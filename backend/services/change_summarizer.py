import json
import logging
import os
import re
from typing import List

from openai import OpenAI

from services.change_queue import change_queue

logger = logging.getLogger("codeatlas.change_summarizer")

SUMMARIZE_PROMPT = """你是一个代码变更摘要专家。你会收到一系列代码修改操作，请用一句话总结这些变更对项目架构的影响。

【输出格式】纯 JSON：
{"summary": "一句话总结，聚焦于新增/修改了哪些功能模块、类、函数，以及它们之间的关系", "key_entities": ["受影响的实体列表"]}"""


class ChangeSummarizer:
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

    async def summarize(self, project_path: str, operations: List[dict]) -> str:
        """Summarize a batch of code change operations."""
        if not operations:
            return ""

        # Build a concise summary of changes
        ops_text = []
        for op in operations:
            t = op.get("type", "?")
            f = op.get("file", "?")
            c = (op.get("content", "") or "")[:200]
            ops_text.append(f"- {t}: {f}\n  content: {c[:100]}")

        ops_summary = "\n".join(ops_text[:5000])

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": SUMMARIZE_PROMPT},
                    {"role": "user", "content": f"项目: {project_path}\n变更操作:\n{ops_summary}"},
                ],
                temperature=0.0,
                max_tokens=512,
            )

            raw = response.choices[0].message.content or "{}"
            data = json.loads(self._clean(raw))
            summary = data.get("summary", "")
            files = list(set(op.get("file", "") for op in operations if op.get("file")))

            if summary:
                change_queue.push(project_path, summary, files)
                logger.info(f"[Summarizer] Pushed summary: {summary[:80]}")

            return summary
        except Exception as e:
            logger.error(f"[Summarizer] Error: {e}")
            return ""


change_summarizer = ChangeSummarizer()
