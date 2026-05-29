import ast
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from services.feature_persistence import load


SOURCE_EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java"}
IGNORE_DIRS = {
    ".git", ".codeatlas", ".codeatlas-logs", "node_modules", "__pycache__",
    ".venv", ".venv312", "venv", "dist", "dist-electron", "release",
}


@dataclass
class SymbolHit:
    name: str
    kind: str
    file: str
    line: int
    score: int
    preview: str = ""


def _tokens(text: str) -> list[str]:
    return [t for t in re.split(r"[^a-zA-Z0-9_\u4e00-\u9fff]+", text.lower()) if len(t) > 1]


def _score_blob(query_tokens: list[str], blob: str) -> int:
    lowered = blob.lower()
    return sum(1 for token in query_tokens if token in lowered)


def _flatten_features(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flat: list[dict[str, Any]] = []
    for node in nodes:
        flat.append(node)
        flat.extend(_flatten_features(node.get("children", []) or []))
    return flat


def _iter_source_files(project_path: str, limit: int = 600):
    root = Path(project_path)
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS]
        for filename in filenames:
            path = Path(dirpath) / filename
            if path.suffix not in SOURCE_EXTENSIONS:
                continue
            count += 1
            if count > limit:
                return
            yield path


def _relative(path: Path, project_path: str) -> str:
    try:
        return str(path.relative_to(project_path)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


def _python_symbols(path: Path, project_path: str) -> list[SymbolHit]:
    try:
        text = path.read_text(encoding="utf-8")
        tree = ast.parse(text)
    except Exception:
        return []

    rel = _relative(path, project_path)
    hits: list[SymbolHit] = []
    lines = text.splitlines()
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            preview = lines[node.lineno - 1].strip() if node.lineno <= len(lines) else ""
            hits.append(SymbolHit(node.name, "class", rel, node.lineno, 0, preview))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            preview = lines[node.lineno - 1].strip() if node.lineno <= len(lines) else ""
            hits.append(SymbolHit(node.name, "function", rel, node.lineno, 0, preview))
    return hits


TS_SYMBOL_RE = re.compile(
    r"^\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)|"
    r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(",
    re.MULTILINE,
)


def _text_symbols(path: Path, project_path: str) -> list[SymbolHit]:
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return []

    rel = _relative(path, project_path)
    lines = text.splitlines()
    hits: list[SymbolHit] = []
    for match in TS_SYMBOL_RE.finditer(text):
        name = next(group for group in match.groups() if group)
        line = text.count("\n", 0, match.start()) + 1
        preview = lines[line - 1].strip() if line <= len(lines) else ""
        kind = "class" if "class" in preview else "function"
        hits.append(SymbolHit(name, kind, rel, line, 0, preview))
    return hits


def _search_symbols(project_path: str, query_tokens: list[str], limit: int) -> list[dict[str, Any]]:
    hits: list[SymbolHit] = []
    for path in _iter_source_files(project_path):
        file_hits = _python_symbols(path, project_path) if path.suffix == ".py" else _text_symbols(path, project_path)
        for hit in file_hits:
            blob = f"{hit.name} {hit.kind} {hit.file} {hit.preview}"
            hit.score = _score_blob(query_tokens, blob)
            if hit.score:
                hits.append(hit)

    hits.sort(key=lambda h: (-h.score, h.file, h.line))
    return [
        {
            "name": h.name,
            "kind": h.kind,
            "file": h.file,
            "line": h.line,
            "score": h.score,
            "preview": h.preview,
        }
        for h in hits[:limit]
    ]


def search_project_map(project_path: str, query: str, limit: int = 8) -> dict[str, Any]:
    query_tokens = _tokens(query)
    if not project_path or not query_tokens:
        return {"features": [], "symbols": []}

    features = []
    for node in _flatten_features(load(project_path)):
        blob = " ".join([
            node.get("id", ""),
            node.get("label", ""),
            node.get("description", ""),
            node.get("flow_description", ""),
            " ".join(node.get("files", []) or []),
            " ".join(node.get("functions", []) or []),
        ])
        score = _score_blob(query_tokens, blob)
        if score:
            features.append({
                "id": node.get("id"),
                "label": node.get("label"),
                "level": node.get("level"),
                "description": node.get("description", ""),
                "flow_description": node.get("flow_description", ""),
                "files": node.get("files", []) or [],
                "functions": node.get("functions", []) or [],
                "score": score,
            })

    features.sort(key=lambda f: (-f["score"], f.get("level", 9), f.get("label") or ""))
    symbols = _search_symbols(project_path, query_tokens, limit)
    return {"features": features[:limit], "symbols": symbols}
