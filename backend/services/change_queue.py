import logging
from typing import List
from services.db import push_change, pull_changes, has_pending_changes

logger = logging.getLogger("codeatlas.change_queue")


class ChangeQueue:
    def push(self, project_path: str, summary: str, files_changed: List[str]):
        push_change(project_path, summary, files_changed)

    def pull_unprocessed(self, project_path: str):
        items = pull_changes(project_path)
        result = []
        for item in items:
            result.append(ChangeItem(
                project_path=project_path,
                summary=item["summary"],
                files_changed=item["files_changed"],
                timestamp=item["created_at"],
            ))
        return result

    def has_pending(self, project_path: str) -> bool:
        return has_pending_changes(project_path)


class ChangeItem:
    def __init__(self, project_path: str, summary: str, files_changed: list[str],
                 timestamp: str = ""):
        self.project_path = project_path
        self.summary = summary
        self.files_changed = files_changed
        self.timestamp = timestamp
        self.processed = False

    def to_dict(self):
        return {
            "project_path": self.project_path,
            "summary": self.summary,
            "files_changed": self.files_changed,
            "timestamp": self.timestamp,
            "processed": self.processed,
        }


change_queue = ChangeQueue()
