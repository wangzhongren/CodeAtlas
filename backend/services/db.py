import sqlite3
import json
import os
import threading
import logging
from datetime import datetime
from typing import List, Optional

logger = logging.getLogger("codeatlas.db")

DB_FILENAME = "codeatlas.db"

# Thread-local connections
_local = threading.local()


def _get_path(project_path: str) -> str:
    store_dir = os.path.join(project_path, ".codeatlas")
    os.makedirs(store_dir, exist_ok=True)
    return os.path.join(store_dir, DB_FILENAME)


def _connect(project_path: str) -> sqlite3.Connection:
    key = project_path
    conn = getattr(_local, key, None)
    if conn is None:
        path = _get_path(project_path)
        conn = sqlite3.connect(path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        _init_tables(conn)
        setattr(_local, key, conn)
    return conn


def close(project_path: str):
    conn = getattr(_local, project_path, None)
    if conn:
        conn.close()
        delattr(_local, project_path)


def _init_tables(conn: sqlite3.Connection):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS features (
            id TEXT PRIMARY KEY,
            project_path TEXT NOT NULL,
            label TEXT NOT NULL,
            level INTEGER DEFAULT 1,
            parent_id TEXT,
            description TEXT DEFAULT '',
            flow_description TEXT DEFAULT '',
            files TEXT DEFAULT '[]',
            functions TEXT DEFAULT '[]',
            generated INTEGER DEFAULT 0,
            children_json TEXT DEFAULT '[]',
            issues_json TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_features_parent ON features(parent_id);
        CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_path);
        """)
    # Migration: add issues_json column
    try:
        conn.execute("ALTER TABLE features ADD COLUMN issues_json TEXT DEFAULT '[]'")
    except sqlite3.OperationalError:
        pass  # column already exists
    conn.executescript("""

        CREATE TABLE IF NOT EXISTS change_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            summary TEXT DEFAULT '',
            files_changed TEXT DEFAULT '[]',
            processed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_queue_project ON change_queue(project_path, processed);

        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT DEFAULT ''
        );
    """)


# ── Feature CRUD ──

def feature_to_row(node: dict) -> tuple:
    def _to_json(v):
        if isinstance(v, str): return v
        return json.dumps(v, ensure_ascii=False)

    files = node.get("files", [])
    functions = node.get("functions", [])
    children = node.get("children", [])

    # Convert children dicts to a consistent format
    children_data = []
    for c in children:
        if isinstance(c, dict):
            children_data.append(feature_to_dict(c))
    children_json = json.dumps(children_data, ensure_ascii=False)

    return (
        node["id"], node.get("project_path", ""), node["label"], node.get("level", 1),
        node.get("parent_id"), node.get("description", ""), node.get("flow_description", ""),
        _to_json(files) if not isinstance(files, list) else json.dumps(files, ensure_ascii=False),
        _to_json(functions) if not isinstance(functions, list) else json.dumps(functions, ensure_ascii=False),
        1 if node.get("generated") else 0,
        children_json,
        _to_json(node.get("issues_json", "[]")) if not isinstance(node.get("issues_json", "[]"), list) else json.dumps(node.get("issues_json", []), ensure_ascii=False),
    )


def _parse_json_field(val):
    """Parse a field that could be a JSON string, list, or sqlite3 Row."""
    if isinstance(val, list):
        return val
    if isinstance(val, str):
        try:
            return json.loads(val)
        except (json.JSONDecodeError, TypeError):
            return []
    return []


def feature_to_dict(row) -> dict:
    """Convert sqlite3.Row or dict to feature dict."""
    if isinstance(row, dict):
        # Already a dict — ensure children are parsed
        children = row.get("children", [])
        parsed_children = [feature_to_dict(c) for c in children] if children else []
        return {
            "id": row.get("id", ""), "label": row.get("label", ""),
            "level": row.get("level", 1), "parent_id": row.get("parent_id"),
            "description": row.get("description", ""),
            "flow_description": row.get("flow_description", ""),
            "files": _parse_json_field(row.get("files", [])),
            "functions": _parse_json_field(row.get("functions", [])),
            "generated": bool(row.get("generated", False)),
            "children": parsed_children,
        }
    # sqlite3.Row
    children_raw = row["children_json"]
    children = json.loads(children_raw) if isinstance(children_raw, str) else (children_raw or [])
    return {
        "id": row["id"], "label": row["label"], "level": row["level"],
        "parent_id": row["parent_id"], "description": row["description"],
        "flow_description": row["flow_description"],
        "files": _parse_json_field(row["files"]),
        "functions": _parse_json_field(row["functions"]),
        "generated": bool(row["generated"]),
        "children": [feature_to_dict(c) for c in children],
    }


def save_features(project_path: str, features: List[dict]):
    conn = _connect(project_path)
    with conn:
        # Delete ALL old features for this project (top-level + children)
        conn.execute("DELETE FROM features WHERE project_path = ?", (project_path,))
        for f in features:
            f["project_path"] = project_path
            conn.execute(
                """INSERT OR REPLACE INTO features
                   (id, project_path, label, level, parent_id, description, flow_description,
                    files, functions, generated, children_json, issues_json, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))""",
                feature_to_row(f),
            )
    conn.execute("UPDATE meta SET value = ? WHERE key = ?", (datetime.now().isoformat(), f"last_updated_{project_path}"))
    logger.info(f"[DB] Saved {len(features)} features for {project_path}")


def load_features(project_path: str) -> List[dict]:
    conn = _connect(project_path)
    rows = conn.execute(
        "SELECT * FROM features WHERE project_path = ? AND parent_id IS NULL ORDER BY id",
        (project_path,),
    ).fetchall()
    return [feature_to_dict(r) for r in rows]


def find_feature(project_path: str, node_id: str) -> Optional[dict]:
    conn = _connect(project_path)
    row = conn.execute("SELECT * FROM features WHERE id = ?", (node_id,)).fetchone()
    if row:
        return feature_to_dict(row)
    # Search in children of all features
    all_rows = conn.execute("SELECT * FROM features WHERE project_path = ?", (project_path,)).fetchall()
    for r in all_rows:
        d = feature_to_dict(r)
        found = _find_in_children(d.get("children", []), node_id)
        if found:
            return found
    return None


def _find_in_children(children: List[dict], node_id: str) -> Optional[dict]:
    for c in children:
        if c["id"] == node_id:
            return c
        found = _find_in_children(c.get("children", []), node_id)
        if found:
            return found
    return None


def update_feature_overview(project_path: str, node_id: str, node: dict):
    """Update overview data for a feature node."""
    conn = _connect(project_path)
    with conn:
        conn.execute(
            "UPDATE features SET flow_description = ?, issues_json = ?, updated_at = datetime('now') WHERE id = ?",
            (node.get("flow_description", ""), node.get("issues_json", "[]"), node_id),
        )
    logger.info(f"[DB] Updated overview for {node_id}")


def update_feature_children(project_path: str, parent_id: str, children: list):
    """Replace children of a feature node entirely (not merge)."""
    conn = _connect(project_path)
    with conn:
        children_json = json.dumps(children, ensure_ascii=False)
        conn.execute(
            "UPDATE features SET children_json = ?, generated = 1, updated_at = datetime('now') WHERE id = ?",
            (children_json, parent_id),
        )
    logger.info(f"[DB] Replaced children of {parent_id}: {len(children)} items")


def upsert_feature(project_path: str, node: dict):
    """Insert or update a feature node, handling parent-child relationship."""
    conn = _connect(project_path)
    node["project_path"] = project_path
    parent_id = node.get("parent_id")

    if parent_id:
        # Find parent and append to its children
        parent_row = conn.execute("SELECT * FROM features WHERE id = ?", (parent_id,)).fetchone()
        if parent_row:
            parent = feature_to_dict(parent_row)
            children = parent.get("children", [])
            replaced = False
            for i, c in enumerate(children):
                if c["id"] == node["id"]:
                    children[i] = node
                    replaced = True
                    break
            if not replaced:
                children.append(node)
            parent["children"] = children
            parent["generated"] = True
            with conn:
                conn.execute(
                    """UPDATE features SET children_json = ?, generated = 1, updated_at = datetime('now') WHERE id = ?""",
                    (json.dumps(children, ensure_ascii=False), parent_id),
                )
            logger.info(f"[DB] Upserted child {node['id']} under {parent_id}")
        else:
            # Parent not in DB yet, insert as standalone
            node["children"] = node.get("children", [])
            node["parent_id"] = parent_id
            with conn:
                conn.execute(
                    """INSERT OR REPLACE INTO features
                       (id, project_path, label, level, parent_id, description, flow_description,
                        files, functions, generated, children_json, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))""",
                    feature_to_row(node),
                )
    else:
        # Top-level node
        node["children"] = node.get("children", [])
        with conn:
            conn.execute(
                """INSERT OR REPLACE INTO features
                   (id, project_path, label, level, parent_id, description, flow_description,
                    files, functions, generated, children_json, issues_json, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))""",
                feature_to_row(node),
            )


# ── Change Queue ──

def push_change(project_path: str, summary: str, files_changed: List[str]):
    conn = _connect(project_path)
    with conn:
        conn.execute(
            "INSERT INTO change_queue (project_path, summary, files_changed) VALUES (?,?,?)",
            (project_path, summary, json.dumps(files_changed, ensure_ascii=False)),
        )
    logger.info(f"[DB] Pushed change: {summary[:60]}")


def pull_changes(project_path: str) -> List[dict]:
    conn = _connect(project_path)
    rows = conn.execute(
        "SELECT * FROM change_queue WHERE project_path = ? AND processed = 0 ORDER BY id",
        (project_path,),
    ).fetchall()
    result = []
    for r in rows:
        result.append({
            "id": r["id"], "summary": r["summary"],
            "files_changed": json.loads(r["files_changed"]),
            "created_at": r["created_at"],
        })
    with conn:
        conn.execute(
            "UPDATE change_queue SET processed = 1 WHERE project_path = ? AND processed = 0",
            (project_path,),
        )
    return result


def has_pending_changes(project_path: str) -> bool:
    conn = _connect(project_path)
    row = conn.execute(
        "SELECT COUNT(*) as cnt FROM change_queue WHERE project_path = ? AND processed = 0",
        (project_path,),
    ).fetchone()
    return row["cnt"] > 0
