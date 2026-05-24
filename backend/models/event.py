from pydantic import BaseModel, Field
from typing import Dict, Any, Optional, List


class OpenFileContext(BaseModel):
    path: str
    content: str
    lines: int


class SelectionContext(BaseModel):
    file: str
    text: str
    lines: str  # e.g. "L12-L18"


class AgentRequest(BaseModel):
    instruction: str
    context: Optional[Dict[str, Any]] = None
    open_file: Optional[OpenFileContext] = None
    file_tree: Optional[List[Dict[str, Any]]] = None
    selection: Optional[SelectionContext] = None
    history: Optional[List[Dict[str, Any]]] = None


class FileOperation(BaseModel):
    type: str
    file: Optional[str] = None
    start_line: Optional[int] = None
    end_line: Optional[int] = None
    after_line: Optional[int] = None
    content: Optional[str] = None


class AgentResponse(BaseModel):
    message: str
    operations: List[FileOperation] = Field(default_factory=list)
