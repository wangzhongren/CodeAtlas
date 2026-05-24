import json
import logging
import os
import re

from openai import OpenAI

from models.event import AgentRequest, AgentResponse, FileOperation
from services.analyzer import topology_analyzer
from services.sse_manager import sse_manager

logger = logging.getLogger("codeatlas.agent")

MAX_CONTEXT_CHARS = 8000  # Truncate huge files to avoid blowing context window

AGENT_SYSTEM_PROMPT = """你是「CodeAtlas CodeAtlas」的 AI 编程助手。

【职责】帮助用户阅读代码、修改文件、执行命令、回答项目相关问题。

【核心规则 — 证据优先】
1. 文件内容 > 用户口述 > 你的推测。如果用户说的和文件实际内容不一致，以文件为准并指出差异
2. 你说的每一句话都必须有文件证据支撑。先 read_file 再下结论
3. 文件树只告诉你有哪些文件，不能告诉你文件里写了什么
4. 严禁编造文件名、函数名、代码逻辑、行号。没看到就是没看到
5. 不知道就说不知道
6. 要修改文件时输出具体的操作指令
7. 要执行命令时输出 run_shell
8. message 简洁自然，不废话

【操作类型】
- read_file: 读取文件。file 填相对路径，可选 start_line/end_line 指定行范围（从 1 开始）
- insert_lines: 在 after_line 后插入代码。after_line=0 表示文件开头
- replace_lines: 替换 start_line 到 end_line 的内容（行号从 1 开始）
- delete_lines: 删除 start_line 到 end_line 的内容
- create_file: 创建新文件
- run_shell: 执行 Shell 命令（用户确认后执行，15s 超时自动后台）

【输出格式】纯 JSON，不要 markdown 包裹：
{"message": "简短说明", "operations": []}

示例：
{"message": "这个项目有 23 个文件，主要是 React 前端项目", "operations": []}
{"message": "在 auth.ts 第 42 行后添加 login 函数", "operations": [{"type": "insert_lines", "file": "src/auth.ts", "after_line": 42, "content": "export async function login() {\\n  // ...\\n}"}]}
{"message": "安装项目依赖", "operations": [{"type": "run_shell", "content": "npm install"}]}"""


class AgentService:
    def __init__(self):
        self.client = OpenAI(
            api_key=os.getenv("CODEATLAS_LLM_API_KEY"),
            base_url=os.getenv("CODEATLAS_LLM_BASE_URL"),
        )
        self.model = os.getenv("CODEATLAS_LLM_MODEL")

    def _clean_output(self, raw: str) -> str:
        raw = raw.strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        return raw.strip()

    def _build_messages(self, system_prompt: str, user_msg: str, history: list | None) -> list:
        msgs = [{"role": "system", "content": system_prompt}]
        if history:
            for h in history:
                role = "assistant" if h.get("role") == "agent" else "user"
                msgs.append({"role": role, "content": h.get("content", "")})
        msgs.append({"role": "user", "content": user_msg})
        logger.info(f"[Agent] Messages: {len(msgs)} total ({len(history or [])} history)")
        return msgs

    def _truncate(self, text: str, max_chars: int = MAX_CONTEXT_CHARS) -> str:
        if len(text) <= max_chars:
            return text
        half = max_chars // 2
        return text[:half] + "\n\n... (truncated) ...\n\n" + text[-half:]

    async def process(self, req: AgentRequest) -> AgentResponse:
        parts = [f"【用户指令】\n{req.instruction}"]

        if req.open_file:
            parts.append(
                f"\n【当前打开的文件: {req.open_file.path}，共 {req.open_file.lines} 行】\n"
                f"```\n{self._truncate(req.open_file.content)}\n```"
            )

        if req.selection:
            parts.append(
                f"\n【用户选中的代码: {req.selection.file} {req.selection.lines}】\n"
                f"用户特意选中了这段代码，请围绕这段代码进行修改：\n"
                f"```\n{req.selection.text}\n```"
            )

        if req.file_tree:
            tree_summary = json.dumps(req.file_tree, ensure_ascii=False, indent=2)
            parts.append(f"\n【项目文件树 ({len(req.file_tree)} 个顶层条目)】\n{self._truncate(tree_summary, 2000)}")
        else:
            parts.append("\n【注意: 用户已经打开了一个文件夹，但文件树未加载。请告诉用户稍等，不要说你没看到项目。】")

        user_message = "\n".join(parts)
        logger.info(f"[Agent] Context size: {len(user_message)} chars")

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=self._build_messages(AGENT_SYSTEM_PROMPT, user_message, req.history),
                temperature=0.0,
                max_tokens=4096,
            )

            raw = response.choices[0].message.content or "{}"
            logger.info(f"[Agent] Raw LLM response ({len(raw)} chars): {raw[:300]}")

            cleaned = self._clean_output(raw)
            data = json.loads(cleaned)

            message = data.get("message", "")
            ops_data = data.get("operations", [])

            if not message and not ops_data:
                message = "没有检测到需要修改的内容，请重新描述你的需求"
            elif not message:
                types = [op.get("type", "?") for op in ops_data]
                message = f"准备了 {len(ops_data)} 个操作: {', '.join(types)}"

            operations = [FileOperation(**op) for op in ops_data]
            logger.info(f"[Agent] Parsed: message='{message}', {len(operations)} ops")
            return AgentResponse(message=message, operations=operations)

        except json.JSONDecodeError as e:
            logger.error(f"[Agent] JSON parse error: {e}\nContent: {raw[:500]}")
            return AgentResponse(
                message=f"LLM 返回格式异常，请重试。（技术细节: {str(e)[:100]}）",
                operations=[],
            )
        except Exception as e:
            logger.error(f"[Agent] Error: {e}")
            return AgentResponse(
                message=f"⚠️ 处理出错: {str(e)[:200]}",
                operations=[],
            )

    async def process_stream(self, req: AgentRequest):
        """Stream LLM output token by token, yield events. Final event contains parsed JSON."""
        parts = [f"【用户指令】\n{req.instruction}"]
        if req.open_file:
            parts.append(
                f"\n【当前打开的文件: {req.open_file.path}，共 {req.open_file.lines} 行】\n"
                f"```\n{self._truncate(req.open_file.content)}\n```"
            )
        if req.selection:
            parts.append(
                f"\n【用户选中的代码: {req.selection.file} {req.selection.lines}】\n"
                f"```\n{req.selection.text}\n```"
            )
        user_message = "\n".join(parts)
        logger.info(f"[Agent] Stream: instruction='{req.instruction[:50]}' | "
                    f"open_file={'yes' if req.open_file else 'no'} | "
                    f"file_tree={len(req.file_tree or [])} entries | "
                    f"selection={'yes' if req.selection else 'no'} | "
                    f"total={len(user_message)} chars")

        full_text = ""
        try:
            stream = self.client.chat.completions.create(
                model=self.model,
                messages=self._build_messages(AGENT_SYSTEM_PROMPT, user_message, req.history),
                temperature=0.0,
                max_tokens=4096,
                stream=True,
            )

            for chunk in stream:
                delta = chunk.choices[0].delta
                token = delta.content or ""
                if token:
                    full_text += token
                    yield {"event": "token", "data": token}

            # Parse finished text
            cleaned = self._clean_output(full_text)
            data = json.loads(cleaned)
            message = data.get("message", "")
            ops_data = data.get("operations", [])
            operations = [FileOperation(**op) for op in ops_data]

            if not message and operations:
                types = [op.get("type", "?") for op in ops_data]
                message = f"执行 {len(ops_data)} 个操作: {', '.join(types)}"
            elif not message:
                message = "已收到"

            yield {
                "event": "done",
                "data": json.dumps({
                    "message": message,
                    "operations": [op.model_dump() for op in operations],
                }, ensure_ascii=False),
            }

        except json.JSONDecodeError:
            yield {"event": "done", "data": json.dumps({
                "message": f"LLM 返回格式异常，请重试",
                "operations": [],
            }, ensure_ascii=False)}
        except Exception as e:
            logger.error(f"[Agent] Stream error: {e}")
            yield {"event": "done", "data": json.dumps({
                "message": f"⚠️ 处理出错: {str(e)[:200]}",
                "operations": [],
            }, ensure_ascii=False)}

    async def apply_operations(self, operations: list[FileOperation]):
        for op in operations:
            if op.type in ('insert_lines', 'replace_lines', 'delete_lines', 'create_file'):
                if op.file and op.content:
                    diff = f"--- a/{op.file}\n+++ b/{op.file}\n@@ change @@\n"
                    for line in op.content.split('\n'):
                        diff += f"+{line}\n"
                    await topology_analyzer.analyze_diff(op.file, diff)

        await sse_manager.broadcast([{"action": "refresh"}])
        logger.info(f"[Agent] Applied {len(operations)} ops, topology updated")


agent_service = AgentService()
