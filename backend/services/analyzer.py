import json
import logging
import os
import re
from typing import List

from openai import OpenAI

from services.sse_manager import sse_manager

logger = logging.getLogger("codeatlas.analyzer")

SYSTEM_PROMPT = (
    "你是一个殿堂级的系统架构师（Agent 2）。你的唯一职责是实时维护代码库的物理与逻辑拓扑图谱。\n"
    "你会收到编码助手修改代码所产生的 Git Diff。\n\n"
    "【核心过滤法则】\n"
    "1. 忽略所有琐碎的业务细节、业务逻辑、局部修复（如 if-else 条件变动、变量改名、日志打印、参数微调等）。\n"
    "2. 聚焦提取高层实体（Entity）变动：\n"
    "   - Module (技术分层/业务域): 如 controller, service, repository, config\n"
    "   - Class (类/接口/大结构体): 如 class AuthService, interface UserRepository\n"
    "   - Function (核心骨干函数/路由映射): 如 def login(), @app.post('/register')\n"
    "3. 核心强关注：跨文件、跨实体的调用链（Call Graph）与依赖关系（Dependency）。如 A 函数内部调用了 B 类的方法，需要拉出有向箭头。\n\n"
    "【输出指令协议 (核心)】\n"
    "你必须且只能输出一个标准的纯 JSON Array。严禁包含任何 Markdown 格式包裹（不要用 ```json）、严禁任何自然语言散文解释。\n"
    "Array 内的每一个对象必须符合以下四种原子操作之一（必须严格遵守字段格式）：\n"
    "[\n"
    "  { \"action\": \"upsert_node\", \"node\": { \"id\": \"符号全称\", \"label\": \"显示名\", \"type\": \"module|class|function\", \"layer\": 1|2|3|4, \"file\": \"源文件路径\" } },\n"
    "  { \"action\": \"delete_node\", \"node\": { \"id\": \"节点id\" } },\n"
    "  { \"action\": \"add_edge\", \"edge\": { \"source\": \"源节点id\", \"target\": \"目标节点id\", \"type\": \"call|inherit|depend\" } },\n"
    "  { \"action\": \"delete_edge\", \"edge\": { \"source\": \"源节点id\", \"target\": \"目标节点id\" } }\n"
    "]"
)


class TopologyAnalyzer:
    def __init__(self):
        self.client = OpenAI(
            api_key=os.getenv("CODEATLAS_LLM_API_KEY"),
            base_url=os.getenv("CODEATLAS_LLM_BASE_URL"),
        )
        self.model = os.getenv("CODEATLAS_LLM_MODEL")

    def _clean_llm_output(self, raw: str) -> str:
        """Strip markdown fences and surrounding whitespace from LLM output."""
        raw = raw.strip()
        # Remove ```json ... ``` or ``` ... ``` fences
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        return raw.strip()

    async def analyze_diff(self, file_path: str, diff_content: str):
        user_content = f"变更文件路径: {file_path}\n\n代码增量 Diff 内容:\n{diff_content}"

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
                temperature=0.0,
            )

            raw_output = response.choices[0].message.content
            if not raw_output:
                logger.warning("[TopologyAnalyzer] Empty LLM response")
                return

            cleaned = self._clean_llm_output(raw_output)
            logger.info(f"[TopologyAnalyzer] Raw output (cleaned): {cleaned[:300]}")

            commands = json.loads(cleaned)
            if not isinstance(commands, list):
                logger.warning(f"[TopologyAnalyzer] Expected JSON array, got {type(commands)}")
                return

            await self._push_to_canvas(commands)
        except json.JSONDecodeError as e:
            logger.error(f"[TopologyAnalyzer] JSON parse error: {e}\nRaw: {raw_output[:500]}")
        except Exception as e:
            logger.error(f"[TopologyAnalyzer] Unexpected error: {e}")

    async def predict_intent(self, args: dict):
        """Pre-intent capture — placeholder for future semantic enrichment."""
        if not args:
            return
        logger.info(f"[TopologyAnalyzer] User intent captured: {json.dumps(args, ensure_ascii=False)[:200]}")

    async def sync_final_state(self):
        """Round-end persistence — placeholder for snapshot serialization."""
        logger.info("[TopologyAnalyzer] Round ended — topology state snapshot would persist here")

    async def _push_to_canvas(self, commands: List[dict]):
        logger.info(f"[Pushing to Canvas] Sending {len(commands)} atomic commands")
        await sse_manager.broadcast(commands)


topology_analyzer = TopologyAnalyzer()
