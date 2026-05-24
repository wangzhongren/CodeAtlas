import json
import logging
import os
import re
from typing import List

from openai import OpenAI

logger = logging.getLogger("codeatlas.overview_agent")

AGENT_PROMPT = """你是项目架构审计师，需要自主探索项目代码并生成详细概述。你不仅要描述，更要发现问题。

工作方式：
1. 第一轮：基于文件树，决定要读哪些关键文件
2. 后续轮：基于已读内容，决定还要读哪些文件
3. 信息足够时，生成最终概述
4. 最多 10 轮探索

【审计要点——必须检查】
- 前后端接口是否对得上（API 路径、参数名、数据结构）
- import 的模块/包是否存在
- 配置文件引用的服务/端口是否合理
- 类型定义和使用是否一致
- 函数调用链是否有断裂

【输出格式】纯 JSON：
如果要继续探索：{"action":"read","files":["相对路径1","相对路径2"],"reason":"why"}
如果信息足够了：{"action":"done","overview":"详细的 Markdown 概述，包含：## 项目概述\n## 技术架构\n## 模块协作\n## ⚠️ 发现的问题（如果有）\n## 建议","files":[{"path":"相对路径","description":"这个文件的作用"}],"functions":["关键函数:行号"],"issues":[{"severity":"warning|error","title":"问题标题","detail":"具体描述"}]}"""


class OverviewAgent:
    def __init__(self):
        self.client = OpenAI(
            api_key=os.getenv("CODEATLAS_LLM_API_KEY", "your-api-key-here"),
            base_url=os.getenv("CODEATLAS_LLM_BASE_URL", "https://aiproxy2.abujlb.com/deepseek/v1"),
        )
        self.model = os.getenv("CODEATLAS_LLM_MODEL", "deepseek-v4-pro")

    def _clean(self, raw: str) -> str:
        raw = raw.strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        return raw.strip()

    def _read_file(self, filepath: str) -> str:
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                lines = f.readlines()
            numbered = []
            for i, line in enumerate(lines, 1):
                numbered.append(f"{i:4d}| {line.rstrip()}")
            content = "\n".join(numbered)
            if len(content) > 5000:
                half = 2500
                content = content[:half] + "\n...(truncated)...\n" + content[-half:]
            return content
        except Exception:
            return f"[无法读取]"

    def _build_file_tree(self, project_path: str, depth: int = 2) -> str:
        """Build a simple file tree string."""
        lines = []
        try:
            for root, dirs, files in os.walk(project_path):
                rel = os.path.relpath(root, project_path)
                if rel == '.':
                    rel = ''
                # Filter hidden and node_modules
                dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('node_modules', '__pycache__', 'venv', '.venv', 'dist')]
                # Limit depth
                if depth > 0 and rel.count(os.sep) >= depth:
                    dirs[:] = []
                for f in files[:30]:
                    if not f.startswith('.'):
                        lines.append(os.path.join(rel, f).replace('\\', '/'))
        except Exception as e:
            lines.append(f"[error: {e}]")
        return '\n'.join(lines[:200])

    async def explore(self, project_path: str) -> dict:
        """Autonomous agent: explore project and generate overview."""
        tree = self._build_file_tree(project_path)
        read_so_far: dict[str, str] = {}
        read_files_set: set[str] = set()

        messages = [
            {"role": "system", "content": AGENT_PROMPT},
            {"role": "user", "content": f"项目路径: {project_path}\n项目名称: {os.path.basename(project_path)}\n\n文件列表:\n{tree}\n\n开始探索，先读最关键的几个文件。"},
        ]

        overview = ""
        key_files = []
        key_functions = []

        for iteration in range(10):
            logger.info(f"[OverviewAgent] Round {iteration + 1}, context: {len(messages)} msgs")

            response = self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=0.1,
                max_tokens=2048,
            )

            raw = response.choices[0].message.content or "{}"
            data = json.loads(self._clean(raw))
            action = data.get("action", "done")

            if action == "done":
                overview = data.get("overview", "")
                key_files = data.get("files", [])
                key_functions = data.get("functions", [])
                logger.info(f"[OverviewAgent] Done after {iteration + 1} rounds")
                break

            # Read requested files
            files_to_read = data.get("files", [])
            if not files_to_read:
                logger.warning("[OverviewAgent] No files requested, forcing done")
                break

            reason = data.get("reason", "")
            new_content = ""
            for fp in files_to_read:
                if fp in read_files_set:
                    continue
                read_files_set.add(fp)
                full = os.path.join(project_path, fp) if not os.path.isabs(fp) else fp
                content = self._read_file(full)
                read_so_far[fp] = content
                new_content += f"\n\n=== {fp} ===\n{content}"

            if not new_content:
                logger.warning("[OverviewAgent] All requested files already read")
                break

            messages.append({"role": "assistant", "content": f"I'll read: {', '.join(files_to_read)}"})
            messages.append({"role": "user", "content": f"读取了以下文件 ({reason}):\n{new_content}\n\n还需要更多信息吗？如果够了请输出 done。"})

        # If agent didn't produce overview, generate one from accumulated reads
        if not overview and read_so_far:
            overview = self._summarize_reads(project_path, read_so_far)

        return {
            "overview": overview,
            "files": key_files or list(read_so_far.keys()),
            "functions": key_functions,
            "rounds": iteration + 1,
        }

    def _summarize_reads(self, project_path: str, reads: dict[str, str]) -> str:
        """Fallback: summarize accumulated reads."""
        all_text = "\n\n".join(f"=== {k} ===\n{v[:2000]}" for k, v in list(reads.items())[:10])
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "请用 3-5 段 Markdown 概述这个项目的架构、功能、协作方式。"},
                    {"role": "user", "content": f"项目: {os.path.basename(project_path)}\n\n{all_text[:6000]}"},
                ],
                temperature=0.1,
                max_tokens=1024,
            )
            return response.choices[0].message.content or ""
        except Exception:
            return "无法生成概述"


overview_agent = OverviewAgent()
