import asyncio
import json
import logging
from typing import List

logger = logging.getLogger("codeatlas.sse")


class SSEManager:
    """Manages SSE client connections and broadcasts topology commands."""

    def __init__(self):
        self._queues: List[asyncio.Queue] = []

    async def connect(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        self._queues.append(queue)
        logger.info(f"SSE client connected (total: {len(self._queues)})")
        return queue

    def disconnect(self, queue: asyncio.Queue):
        if queue in self._queues:
            self._queues.remove(queue)
            logger.info(f"SSE client disconnected (total: {len(self._queues)})")

    async def broadcast(self, commands: List[dict]):
        if not commands:
            return
        payload = json.dumps(commands, ensure_ascii=False)
        dead: List[asyncio.Queue] = []
        for q in self._queues:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self.disconnect(q)
        logger.info(f"Broadcast {len(commands)} commands to {len(self._queues)} clients")


sse_manager = SSEManager()
