from pydantic import BaseModel, Field
from typing import Dict, Any, Optional, List


class FeatureNode(BaseModel):
    id: str  # unique id, e.g. "auth" or "auth.login_flow"
    label: str  # display name
    level: int = 1  # 1=feature, 2=flow step, 3=code detail
    parent_id: Optional[str] = None
    description: str = ""
    files: List[str] = Field(default_factory=list)  # related file paths
    functions: List[str] = Field(default_factory=list)  # key function names
    flow_description: str = ""  # how this feature works (for level 1-2)
    children: List["FeatureNode"] = Field(default_factory=list)  # sub-index
    generated: bool = False  # whether children have been fetched


class FeatureGraph(BaseModel):
    project_path: str
    features: List[FeatureNode] = Field(default_factory=list)
    last_updated: str = ""


class AnalyzeFeaturesRequest(BaseModel):
    project_path: str
    node_id: Optional[str] = None  # if set, analyze children of this node
    parent_context: Optional[str] = None  # context from parent for drill-down


class AnalyzeFeaturesResponse(BaseModel):
    nodes: List[FeatureNode]
