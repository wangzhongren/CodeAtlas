import json
import logging
import os
import re
from typing import List

from openai import OpenAI

from models.feature import FeatureNode
from services.db import load_features, save_features, find_feature, update_feature_children

logger = logging.getLogger("codeatlas.feature_analyzer")

LEVEL1_PROMPT = """你是一个代码架构分析师。请分析项目代码，输出树状功能结构。

【输出格式】纯 JSON。先输出一个项目总览根节点，下面按功能模块分组，每组下面是具体功能：

{
  "project_overview": {
    "label": "项目总览",
    "description": "一句话描述整个项目是做什么的",
    "flow_description": "项目的整体技术架构和数据流概述"
  },
  "groups": [
    {
      "id": "group_auth",
      "label": "用户认证",
      "description": "处理登录、注册、权限验证",
      "features": [
        {
          "id": "auth_login",
          "label": "登录功能",
          "description": "用户名密码登录",
          "flow_description": "接收请求→验证凭据→生成token→返回",
          "files": ["src/auth/login.ts"],
          "functions": ["handleLogin:42", "verifyPassword:68"]
        }
      ]
    }
  ]
}

【规则】
- groups 3-6 个功能分组
- 每组下面 features 2-5 个具体功能
- 每个 feature 必须有 flow_description（用于钻取流程步骤）
- id 用英文短标识
- files 和 functions 基于代码内容，不要编造"""

OVERVIEW_PROMPT = """你是一个项目架构分析师。你需要为项目或模块写一段详细的技术概述。

请根据文件内容和结构，输出：

【输出格式】纯 JSON：
{
  "description": "2-3句话描述这个模块的核心职责",
  "overview": "详细的技术概述，包含：\n1. 这个模块/项目是做什么的\n2. 核心技术方案和架构设计\n3. 主要功能组件之间如何协作\n4. 数据流和控制流概要\n用 markdown 风格书写，自然段落",
  "files": ["关键文件路径"],
  "functions": ["关键函数名:行号"]
}"""

LEVEL2_PROMPT = """你是一个代码流程分析师。用户正在钻取一个功能点，你需要画出这个功能内部的详细流程步骤。

上级功能信息：
{parent_context}

相关文件内容：
{file_contents}

请分析这些代码，生成该功能的内部流程步骤。

【输出格式】纯 JSON：
{
  "steps": [
    {
      "id": "步骤标识(拼在父级id后面，如 parent_id.login_handler)",
      "label": "步骤名称(中文)",
      "description": "这个步骤做什么",
      "flow_description": "这个步骤内部的具体实现细节描述",
      "files": ["具体到这个步骤的文件"],
      "functions": ["函数名:行号"],  // 必须带行号，如 "login:42", "verifyToken:58"
    }
  ]
}

【规则】
- 生成 4-10 个流程步骤
- 每个步骤代表一个具体的代码执行环节
- files 和 functions 要尽可能具体
- functions 必须带行号，格式: "函数名:行号"
- 代码中每行前面有 "行号|" 标注，直接用那个行号，如代码里 "  42| def login():" 就写 "login:42"
- 行号必须准确，不要瞎编"""

INCREMENTAL_PROMPT = """你是一个代码架构维护助手。项目代码发生了一些变更，你需要增量更新功能点图谱。

【当前功能图谱】
{current_features}

【代码变更摘要】
{change_summary}

【变更涉及的文件内容】
{file_contents}

请分析这些变更对功能点的影响，返回需要增量更新的操作。

【输出格式】纯 JSON：
{
  "message": "简述变更影响",
  "updates": [
    { "action": "add_feature", "feature": { "id": "新功能id", "label": "功能名", "description": "描述", "flow_description": "流程概述", "files": ["文件路径"], "functions": ["函数名:行号"] } },
    { "action": "update_feature", "feature": { "id": "已有功能id", "description": "更新的描述", "files": ["更新的文件"], "functions": ["更新的函数"] } },
    { "action": "remove_feature", "feature_id": "要删除的功能id" }
  ]
}

【规则】
- 只返回真正受影响的变更，不要全量返回
- 如果变更很小（如修改注释、调整格式），返回空 updates
- 如果是新增功能，用 add_feature
- 如果是修改已有功能，用 update_feature（只填变化的字段）
- 如果是删除功能，用 remove_feature"""

LEVEL3_PROMPT = """你是一个代码细节分析专家。用户正在查看一个流程步骤的具体实现。

步骤信息：{parent_context}

相关代码：
{file_contents}

请分析这段代码的具体实现细节。

【输出格式】纯 JSON：
{
  "details": [
    {
      "id": "细节标识",
      "label": "细节名称",
      "description": "这段代码的具体逻辑和关键实现细节",
      "files": ["文件路径"],
      "functions": ["函数名:行号"],
      "flow_description": ""
    }
  ]
}"""


class FeatureAnalyzer:
    def __init__(self):
        self.client = OpenAI(
            api_key=os.getenv("CODEATLAS_LLM_API_KEY"),
            base_url=os.getenv("CODEATLAS_LLM_BASE_URL"),
        )
        self.model = os.getenv("CODEATLAS_LLM_MODEL")

    def _clean(self, raw: str) -> str:
        raw = raw.strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        return raw.strip()

    def _read_file(self, filepath: str) -> str:
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                lines = f.readlines()
            # Prepend line numbers so LLM can reference exact positions
            numbered = []
            for i, line in enumerate(lines, 1):
                numbered.append(f"{i:4d}| {line.rstrip()}")
            content = "\n".join(numbered)
            if len(content) > 8000:
                half = 4000
                content = content[:half] + "\n    ...(truncated)...\n" + content[-half:]
            return content
        except Exception:
            return f"[无法读取: {filepath}]"

    def _make_relative(self, filepath: str, project_path: str) -> str:
        """Convert absolute path to relative from project root."""
        try:
            pp = os.path.normpath(project_path)
            fp = os.path.normpath(filepath)
            if fp.lower().startswith(pp.lower()):
                rel = os.path.relpath(fp, pp)
                return rel.replace('\\', '/')
        except Exception:
            pass
        return filepath.replace('\\', '/')

    def _find_key_files(self, file_tree: list, project_path: str) -> list[str]:
        """Auto-discover important files to read for context."""
        key_patterns = [
            'package.json', 'README.md', 'setup.py', 'pyproject.toml',
            'main.py', 'app.py', 'index.ts', 'index.tsx', 'main.ts',
            'Cargo.toml', 'go.mod', 'Makefile', 'Dockerfile',
            'src/index', 'src/main', 'src/app',
        ]
        key_files: list[str] = []

        def walk(entries: list, depth: int = 0):
            if depth > 3:
                return
            for e in entries:
                if e.get('type') == 'file':
                    name = e.get('name', '')
                    path_str = e.get('path', '')
                    for pat in key_patterns:
                        if pat in name or pat in path_str:
                            key_files.append(self._make_relative(path_str, project_path))
                            break
                if e.get('type') == 'directory' and e.get('children'):
                    walk(e['children'], depth + 1)

        walk(file_tree)
        seen = set()
        result = []
        for f in key_files:
            if f not in seen:
                seen.add(f)
                result.append(f)
        return result[:15]

    async def analyze_top_level(self, project_path: str, file_tree: list) -> List[FeatureNode]:
        """Auto-agent: read key files, then generate feature list from real code."""
        # Step 1: Find and read key files
        key_files = self._find_key_files(file_tree, project_path)
        logger.info(f"[FeatureAnalyzer] Reading {len(key_files)} key files")

        file_contents = []
        for fp in key_files:
            full = fp if os.path.isabs(fp) else os.path.join(project_path, fp)
            if os.path.isfile(full):
                content = self._read_file(full)
                if content:
                    file_contents.append(f"=== {fp} ===\n{content}")

        # Step 2: Build prompt with real file content
        tree_summary = json.dumps(file_tree, ensure_ascii=False, indent=2)[:4000]
        code_preview = "\n\n".join(file_contents)[:8000]

        user_msg = (
            f"项目路径: {project_path}\n\n"
            f"【文件树】\n{tree_summary}\n\n"
            f"【关键文件内容】\n{code_preview}\n\n"
            f"请基于以上信息分析项目的核心功能点。"
        )

        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": LEVEL1_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.2,
            max_tokens=4096,
        )

        raw = response.choices[0].message.content or "{}"
        data = json.loads(self._clean(raw))

        overview_data = data.get("project_overview", {})
        groups_data = data.get("groups", [])

        # Build tree: root → groups → features
        root = FeatureNode(
            id="project_overview",
            label=overview_data.get("label", "项目总览"),
            level=0,
            description=overview_data.get("description", ""),
            flow_description=overview_data.get("flow_description", ""),
            files=[], functions=[],
        )

        group_nodes = []
        for g in groups_data:
            feature_nodes = []
            for f in g.get("features", []):
                normalized_files = [self._make_relative(fp, project_path) for fp in f.get("files", [])]
                feature_nodes.append(FeatureNode(
                    id=f["id"],
                    label=f["label"],
                    level=2,
                    parent_id=g["id"],
                    description=f.get("description", ""),
                    flow_description=f.get("flow_description", ""),
                    files=normalized_files,
                    functions=f.get("functions", []),
                ))
            group_nodes.append(FeatureNode(
                id=g["id"],
                label=g["label"],
                level=1,
                parent_id="project_overview",
                description=g.get("description", ""),
                flow_description="",
                files=[], functions=[],
                children=feature_nodes,
                generated=True,
            ))

        root.children = group_nodes
        root.generated = True

        save_features(project_path, [root.model_dump()])

        logger.info(f"[FeatureAnalyzer] Generated tree: {len(groups_data)} groups, "
                    f"{sum(len(g.get('features',[])) for g in groups_data)} features")
        return [root]

    async def generate_overview(self, project_path: str, node_id: str, files: list[str]) -> dict:
        """Generate a detailed overview for a project root or feature group."""
        logger.info(f"[FeatureAnalyzer] Generating overview for {node_id}")

        # If no files provided, auto-discover key files from project
        if not files:
            try:
                entries = os.listdir(project_path)
                for entry in entries[:30]:
                    fp = os.path.join(project_path, entry)
                    if os.path.isfile(fp) and not entry.startswith('.'):
                        files.append(entry)
            except Exception:
                pass

        file_contents = []
        for fp in (files or [])[:15]:
            full = fp if os.path.isabs(fp) else os.path.join(project_path, fp)
            if os.path.isfile(full):
                content = self._read_file(full)
                file_contents.append(f"=== {fp} ===\n{content}")
        files_text = "\n\n".join(file_contents)[:8000] if file_contents else "(no readable files found)"

        prompt = OVERVIEW_PROMPT + f"\n\n项目: {project_path}\n节点: {node_id}\n\n{files_text}"

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
                max_tokens=2048,
            )
            raw = response.choices[0].message.content or "{}"
            data = json.loads(self._clean(raw))
            return {
                "description": data.get("description", ""),
                "overview": data.get("overview", ""),
                "files": data.get("files", []),
                "functions": data.get("functions", []),
            }
        except Exception as e:
            logger.error(f"[FeatureAnalyzer] Overview generation failed: {e}")
            return {"description": "", "overview": "", "files": [], "functions": []}

    async def drill_down(self, project_path: str, node_id: str, parent_context: str) -> List[FeatureNode]:
        """Drill down into a feature/flow node and generate children."""
        try:
            return await self._drill_down_impl(project_path, node_id, parent_context)
        except Exception as e:
            logger.error(f"[FeatureAnalyzer] drill_down failed: {e}", exc_info=True)
            return []

    async def _drill_down_impl(self, project_path: str, node_id: str, parent_context: str) -> List[FeatureNode]:
        parent = find_feature(project_path, node_id)
        if not parent:
            logger.warning(f"[FeatureAnalyzer] Node {node_id} not in DB, building from context")
            parent = {
                "id": node_id, "label": node_id, "level": 1,
                "description": parent_context or "",
                "flow_description": parent_context or "",
                "files": [], "functions": [],
            }
            target_level = 2
        else:
            target_level = parent["level"] + 1

        # Read related files
        file_contents = []
        for fp in parent.get("files", []):
            full_path = os.path.join(project_path, fp)
            if os.path.isfile(full_path):
                content = self._read_file(full_path)
                file_contents.append(f"=== {fp} ===\n{content}")
        files_text = "\n\n".join(file_contents) if file_contents else "(无法读取相关文件)"

        # Choose prompt based on level
        if target_level == 2:
            prompt = (LEVEL2_PROMPT
                .replace("{parent_context}", f"功能: {parent.get('label','')}\n描述: {parent.get('description','')}\n流程概述: {parent.get('flow_description','')}\n相关文件: {', '.join(parent.get('files',[]))}\n核心函数: {', '.join(parent.get('functions',[]))}{parent_context}")
                .replace("{file_contents}", files_text[:8000]))
        elif target_level == 3:
            prompt = (LEVEL3_PROMPT
                .replace("{parent_context}", f"步骤: {parent.get('label','')}\n描述: {parent.get('description','')}\n流程概述: {parent.get('flow_description','')}{parent_context}")
                .replace("{file_contents}", files_text[:8000]))
        else:
            prompt = (LEVEL3_PROMPT
                .replace("{parent_context}", f"节点: {parent.get('label','')}\n{parent_context}")
                .replace("{file_contents}", files_text[:8000]))

        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": prompt.split('【输出格式】')[0]},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            max_tokens=4096,
        )

        raw = response.choices[0].message.content or "{}"
        data = json.loads(self._clean(raw))

        items = data.get("steps") or data.get("details") or []
        nodes = []
        for item in items:
            child_id = f"{node_id}.{item['id']}"
            normalized_files = [self._make_relative(fp, project_path) for fp in item.get("files", [])]
            nodes.append(FeatureNode(
                id=child_id,
                label=item["label"],
                level=target_level,
                parent_id=node_id,
                description=item.get("description", ""),
                flow_description=item.get("flow_description", ""),
                files=normalized_files,
                functions=item.get("functions", []),
            ))

        # Replace children in DB (not merge)
        update_feature_children(project_path, node_id, [n.model_dump() for n in nodes])

        logger.info(f"[FeatureAnalyzer] Generated {len(nodes)} children for {node_id}")
        return nodes

    async def incremental_update(self, project_path: str, change_summary: str, files_changed: list[str]) -> dict:
        """Incrementally update feature graph based on specific code changes."""
        # Load current features
        features = load_features(project_path)
        features_json = json.dumps(features, ensure_ascii=False, indent=2)[:3000]

        # Read changed files
        file_contents = []
        for fp in files_changed:
            full = fp if os.path.isabs(fp) else os.path.join(project_path, fp)
            if os.path.isfile(full):
                content = self._read_file(full)
                file_contents.append(f"=== {fp} ===\n{content}")
        files_text = "\n\n".join(file_contents)[:6000] if file_contents else "(no files read)"

        prompt = INCREMENTAL_PROMPT.format(
            current_features=features_json,
            change_summary=change_summary,
            file_contents=files_text,
        )

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": prompt},
                ],
                temperature=0.1,
                max_tokens=2048,
            )

            raw = response.choices[0].message.content or "{}"
            data = json.loads(self._clean(raw))
            updates = data.get("updates", [])
            message = data.get("message", "")

            # Apply updates
            for update in updates:
                action = update.get("action")
                if action == "add_feature":
                    feat = update.get("feature", {})
                    if feat.get("id"):
                        feat["project_path"] = project_path
                        feat["level"] = 1
                        feat["files"] = [self._make_relative(f, project_path) for f in feat.get("files", [])]
                        save_features(project_path, features + [feat])
                        logger.info(f"[Incremental] Added feature: {feat['id']}")
                elif action == "update_feature":
                    feat = update.get("feature", {})
                    fid = feat.get("id")
                    if fid:
                        existing = find_feature(project_path, fid)
                        if existing:
                            existing.update({k: v for k, v in feat.items() if v})
                            if "files" in feat:
                                existing["files"] = [self._make_relative(f, project_path) for f in feat["files"]]
                            save_features(project_path, [f for f in features if f["id"] != fid] + [existing])
                            logger.info(f"[Incremental] Updated feature: {fid}")
                elif action == "remove_feature":
                    fid = update.get("feature_id")
                    if fid:
                        features = [f for f in features if f["id"] != fid]
                        save_features(project_path, features)
                        logger.info(f"[Incremental] Removed feature: {fid}")

            logger.info(f"[Incremental] Applied {len(updates)} updates: {message}")
            return {"message": message, "updates": updates}

        except Exception as e:
            logger.error(f"[Incremental] Error: {e}")
            return {"message": str(e), "updates": []}


feature_analyzer = FeatureAnalyzer()
