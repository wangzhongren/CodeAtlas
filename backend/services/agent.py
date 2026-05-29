import json
import logging
import os
import re
from html import unescape

from openai import OpenAI

from models.event import AgentRequest, AgentResponse, FileOperation
from services.analyzer import topology_analyzer
from services.sse_manager import sse_manager

logger = logging.getLogger("codeatlas.agent")

MAX_CONTEXT_CHARS = 8000  # Truncate huge files to avoid blowing context window

AGENT_SYSTEM_PROMPT = """你是 CodeAtlas 的 AI 编程助手。你要主动帮助用户完成任务，不只是回答问题。

【工作方式】
1. 收到任务后，如果上下文不够，先用 read_file 去读相关文件
2. 读完文件后你必须立即给出修改方案和具体操作，不要再问用户"你想怎么做"——你已经看到了代码，应该知道怎么改了
3. 修改代码时必须给出完整、可用的代码块，不是伪代码
4. 创建新项目后记得运行 npm install / pip install
5. 不用每步都解释，直接用操作说话

【核心规则】
1. 文件内容 > 用户口述 > 你的推测。不一致时以文件为准
2. 没看到的文件内容就不要断言，读完了再说话
3. 严禁编造文件名、函数名、行号
4. 小改动只改相关行，不要重写整个文件
5. message 一句话说清楚即可，不废话
6. 能做到的就做，不要说"你试试"、"或许可以"——直接给出操作

【操作类型】
- read_file: 读取文件。file 填相对路径，可选 start_line/end_line
- update: 修改文件。用 status="insert|replace|delete" 表示插入、替换、删除
- create_file: 创建新文件
- run_shell: 执行 Shell 命令（需用户确认）

【输出格式】使用 XML-like 操作标签，不要输出 JSON。
你可以先用一小段自然语言说明，然后输出一个或多个操作标签。
基础标签如下：

读取文件：
<read-file path="backend/services/agent.py"></read-file>
<read-file path="backend/services/agent.py" start-line="10" end-line="80"></read-file>

新增文件：
<create-file path="src/new.ts">
完整文件内容
</create-file>

修改文件：
插入行使用 status="insert"，after-line=0 表示文件开头：
<update status="insert" path="src/app.ts" after-line="42">
要插入的内容
</update>

替换已有行使用 status="replace"：
<update status="replace" path="src/app.ts" start-line="10" end-line="20">
替换后的完整内容
</update>

删除行使用 status="delete"：
<update status="delete" path="src/app.ts" start-line="10" end-line="20"></update>

运行命令：
<run-shell>
npm run build
</run-shell>

【XML-like 规则】
1. path 使用相对项目路径
2. 标签内部默认就是文本，多行代码和命令直接写在标签体内，不需要 CDATA
3. 不要把操作再包进 markdown 代码块
4. 修改文件统一使用 update 标签，通过 status 区分 insert / replace / delete
5. 需要读取文件时只输出 read-file；读到内容后再继续给修改操作
6. 不需要操作时只输出一句自然语言，不要输出空 JSON

示例——需要先读文件：
先看看 agent.py 的结构。
<read-file path="backend/services/agent.py"></read-file>

示例——看到了代码再修改：
在 agent.py 第 42 行后添加新方法。
<update status="insert" path="backend/services/agent.py" after-line="42">
    def new_method(self):
        pass
</update>

示例——不需要修改：
这个文件已经是正确的，不需要修改。"""


TAG_TO_OPERATION = {
    "read-file": "read_file",
    "update": "update",
    "insert-lines": "insert_lines",
    "replace-lines": "replace_lines",
    "delete-lines": "delete_lines",
    "create-file": "create_file",
    "run-shell": "run_shell",
}

OPERATION_TAGS = "|".join(TAG_TO_OPERATION)


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

    def _parse_attrs(self, raw_attrs: str) -> dict:
        attrs = {}
        for key, _quoted, double_value, single_value in re.findall(r'([:\w-]+)\s*=\s*("([^"]*)"|\'([^\']*)\')', raw_attrs):
            attrs[key] = unescape(double_value or single_value or "")
        return attrs

    def _int_attr(self, attrs: dict, name: str):
        value = attrs.get(name)
        if value is None or value == "":
            return None
        try:
            return int(value)
        except ValueError:
            return None

    def _tag_text(self, text: str) -> str:
        text = text.strip()
        if text.startswith("<![CDATA[") and text.endswith("]]>"):
            text = text[9:-3]
        return text.strip("\n")

    def _operation_from_tag(self, tag: str, attrs: dict, content: str) -> dict:
        op_type = TAG_TO_OPERATION[tag]
        if op_type == "update":
            status = (attrs.get("status") or attrs.get("type") or attrs.get("mode") or "").lower()
            op_type = {
                "insert": "insert_lines",
                "replace": "replace_lines",
                "delete": "delete_lines",
            }.get(status, "replace_lines")
        op = {"type": op_type}
        path = attrs.get("path") or attrs.get("file")
        if path:
            op["file"] = path
        start_line = self._int_attr(attrs, "start-line") or self._int_attr(attrs, "start_line")
        end_line = self._int_attr(attrs, "end-line") or self._int_attr(attrs, "end_line")
        after_line = self._int_attr(attrs, "after-line") or self._int_attr(attrs, "after_line")
        if start_line is not None:
            op["start_line"] = start_line
        if end_line is not None:
            op["end_line"] = end_line
        if after_line is not None:
            op["after_line"] = after_line
        body = self._tag_text(content)
        if body and op_type in {"insert_lines", "replace_lines", "create_file", "run_shell"}:
            op["content"] = body
        return op

    def _parse_xml_like(self, raw: str) -> tuple[str, list[dict]]:
        text = self._clean_output(raw)
        ops: list[dict] = []
        spans: list[tuple[int, int]] = []

        block_re = re.compile(
            rf"<(?P<tag>{OPERATION_TAGS})\b(?P<attrs>[^>]*)>(?P<body>.*?)</(?P=tag)>",
            re.DOTALL | re.IGNORECASE,
        )
        for match in block_re.finditer(text):
            tag = match.group("tag").lower()
            attrs = self._parse_attrs(match.group("attrs"))
            ops.append(self._operation_from_tag(tag, attrs, match.group("body")))
            spans.append(match.span())

        self_closing_re = re.compile(
            rf"<(?P<tag>{OPERATION_TAGS})\b(?P<attrs>[^>]*)/>",
            re.DOTALL | re.IGNORECASE,
        )
        for match in self_closing_re.finditer(text):
            tag = match.group("tag").lower()
            attrs = self._parse_attrs(match.group("attrs"))
            ops.append(self._operation_from_tag(tag, attrs, ""))
            spans.append(match.span())

        if not ops:
            raise ValueError("No XML-like operation tags found")

        message_parts = []
        cursor = 0
        for start, end in sorted(spans):
            message_parts.append(text[cursor:start])
            cursor = end
        message_parts.append(text[cursor:])
        message = re.sub(r"\n{3,}", "\n\n", "".join(message_parts)).strip()
        if not message:
            types = [op.get("type", "?") for op in ops]
            message = f"准备了 {len(ops)} 个操作: {', '.join(types)}"
        return message, ops

    def _parse_agent_output(self, raw: str) -> tuple[str, list[FileOperation]]:
        cleaned = self._clean_output(raw)
        try:
            message, ops_data = self._parse_xml_like(cleaned)
        except ValueError:
            try:
                data = json.loads(cleaned)
                message = data.get("message", "")
                ops_data = data.get("operations", [])
            except json.JSONDecodeError:
                message = cleaned.strip()
                ops_data = []

        if not message and not ops_data:
            message = "没有检测到需要修改的内容，请重新描述你的需求"
        elif not message:
            types = [op.get("type", "?") for op in ops_data]
            message = f"准备了 {len(ops_data)} 个操作: {', '.join(types)}"

        operations = [FileOperation(**op) for op in ops_data]
        return message, operations

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

            message, operations = self._parse_agent_output(raw)
            logger.info(f"[Agent] Parsed: message='{message}', {len(operations)} ops")
            return AgentResponse(message=message, operations=operations)

        except (json.JSONDecodeError, ValueError) as e:
            logger.error(f"[Agent] output parse error: {e}\nContent: {raw[:500]}")
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

            message, operations = self._parse_agent_output(full_text)

            yield {
                "event": "done",
                "data": json.dumps({
                    "message": message,
                    "operations": [op.model_dump() for op in operations],
                }, ensure_ascii=False),
            }

        except (json.JSONDecodeError, ValueError) as e:
            logger.error(f"[Agent] Stream parse error: {e}\nContent: {full_text[:500]}")
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
