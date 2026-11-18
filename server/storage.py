"""SQLite 存储：会话、附件、历史导入暂存、附件 OCR 文本缓存。

会话整份以 JSON 存储（与前端消息树结构一致），另存标题和时间列用于列表。
附件原件放 data/files，库里只存元数据；删除会话时清理不再被引用的原件。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from config import DATA_DIR

DB_PATH = DATA_DIR / "chat.db"
FILES_DIR = DATA_DIR / "files"
STAGING_DIR = DATA_DIR / "staging_files"

_lock = threading.RLock()
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init() -> None:
    for path in (DATA_DIR, FILES_DIR, STAGING_DIR):
        path.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '',
                mime TEXT NOT NULL DEFAULT '',
                size INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS staging_sessions (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS staging_files (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '',
                mime TEXT NOT NULL DEFAULT '',
                size INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS file_texts (
                file_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL DEFAULT '',
                text TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(sessions)")}
        if "archived" not in columns:
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"
            )


def _check_id(value: str) -> str:
    if not _ID_RE.match(value or ""):
        raise ValueError(f"非法 ID: {value!r}")
    return value


def _file_ids_in(session: dict) -> set[str]:
    ids: set[str] = set()
    for message in session.get("messages") or []:
        if message.get("role") != "user":
            continue
        for item in message.get("files") or []:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                ids.add(item["id"])
    return ids


# ---------------- 会话 ----------------

def list_sessions() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, title, created_at, updated_at, archived FROM sessions "
            "ORDER BY updated_at DESC"
        ).fetchall()
    return [
        {
            "id": row["id"],
            "title": row["title"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "archived": bool(row["archived"]),
        }
        for row in rows
    ]


def load_session(session_id: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT data FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return json.loads(row["data"]) if row else None


def save_session(session: dict) -> None:
    session_id = _check_id(str(session.get("id", "")))
    payload = json.dumps(session, ensure_ascii=False, separators=(",", ":"))
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT INTO sessions (id, title, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET title=excluded.title, created_at=excluded.created_at, "
            "updated_at=excluded.updated_at, data=excluded.data",
            (
                session_id,
                str(session.get("title") or ""),
                int(session.get("createdAt") or 0),
                int(session.get("updatedAt") or 0),
                payload,
            ),
        )


def rename_session(session_id: str, title: str) -> None:
    with _lock, _conn() as conn:
        row = conn.execute("SELECT data FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            return
        session = json.loads(row["data"])
        session["title"] = title
        conn.execute(
            "UPDATE sessions SET title = ?, data = ? WHERE id = ?",
            (title, json.dumps(session, ensure_ascii=False, separators=(",", ":")), session_id),
        )


def _delete_file_records(conn: sqlite3.Connection, file_ids: set[str]) -> None:
    for file_id in file_ids:
        conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
        conn.execute("DELETE FROM file_texts WHERE file_id = ?", (file_id,))
        if _ID_RE.match(file_id or ""):
            try:
                (FILES_DIR / file_id).unlink(missing_ok=True)
            except OSError:
                pass


def _remaining_file_ids(conn: sqlite3.Connection) -> set[str]:
    remaining: set[str] = set()
    for other in conn.execute("SELECT data FROM sessions").fetchall():
        remaining |= _file_ids_in(json.loads(other["data"]))
    return remaining


def delete_session(session_id: str) -> None:
    with _lock, _conn() as conn:
        row = conn.execute("SELECT data FROM sessions WHERE id = ?", (session_id,)).fetchone()
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        if not row:
            return
        removed = _file_ids_in(json.loads(row["data"]))
        if not removed:
            return
        _delete_file_records(conn, removed - _remaining_file_ids(conn))


def set_archived(session_id: str, archived: bool) -> None:
    with _lock, _conn() as conn:
        conn.execute(
            "UPDATE sessions SET archived = ? WHERE id = ?",
            (1 if archived else 0, session_id),
        )


# ---------------- 维护：按时间删除、清理工具与图片 ----------------

_TOOL_BLOCK_TYPES = {"server_tool_use", "web_search_tool_result", "web_fetch_tool_result"}
_IMAGE_KEYS = ("id", "isImage", "mimeType")


def _time_rows(
    conn: sqlite3.Connection,
    older_than: int | None,
    start: int | None,
    end: int | None,
) -> list[sqlite3.Row]:
    """按最后活动时间筛选；没有任何时间条件时不返回任何行，避免误删全部。"""
    if older_than is not None:
        return conn.execute(
            "SELECT id, data FROM sessions WHERE updated_at < ?", (older_than,)
        ).fetchall()
    if start is not None and end is not None:
        return conn.execute(
            "SELECT id, data FROM sessions WHERE updated_at >= ? AND updated_at <= ?",
            (start, end),
        ).fetchall()
    if start is not None:
        return conn.execute(
            "SELECT id, data FROM sessions WHERE updated_at >= ?", (start,)
        ).fetchall()
    if end is not None:
        return conn.execute(
            "SELECT id, data FROM sessions WHERE updated_at <= ?", (end,)
        ).fetchall()
    return []


def _blob_size(file_id: str) -> int:
    """只认磁盘上真实存在的原件；导入时跳过图片会留下仅元数据行，不能算作可释放空间。"""
    if not _ID_RE.match(file_id or ""):
        return 0
    path = FILES_DIR / file_id
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


def _file_bytes(conn: sqlite3.Connection, file_ids: set[str]) -> int:
    return sum(_blob_size(file_id) for file_id in file_ids)


def _stored_file_ids(conn: sqlite3.Connection, file_ids: set[str]) -> set[str]:
    if not file_ids:
        return set()
    return {file_id for file_id in file_ids if _blob_size(file_id) > 0}


def _all_stored_file_ids(conn: sqlite3.Connection) -> set[str]:
    ids = {row["id"] for row in conn.execute("SELECT id FROM files").fetchall()}
    return _stored_file_ids(conn, ids)


def _scan_clean(
    rows: list[sqlite3.Row],
    clean_tools: bool,
    clean_images: bool,
    stored_ids: set[str],
) -> dict:
    affected = 0
    tool_blocks = 0
    images: set[str] = set()
    for row in rows:
        session = json.loads(row["data"])
        touched = False
        for message in session.get("messages") or []:
            role = message.get("role")
            if role == "assistant" and clean_tools:
                blocks = message.get("blocks") or []
                kept = [
                    block
                    for block in blocks
                    if not (isinstance(block, dict) and block.get("type") in _TOOL_BLOCK_TYPES)
                ]
                if len(kept) != len(blocks):
                    tool_blocks += len(blocks) - len(kept)
                    touched = True
            elif role == "user" and clean_images:
                for item in message.get("files") or []:
                    if (
                        isinstance(item, dict)
                        and item.get("isImage")
                        and isinstance(item.get("id"), str)
                        and item["id"] in stored_ids
                    ):
                        images.add(item["id"])
                        touched = True
        if touched:
            affected += 1
    return {"sessions": affected, "toolBlocks": tool_blocks, "images": len(images), "files": images}


def maintenance_preview(
    older_than: int | None,
    start: int | None,
    end: int | None,
    clean_tools: bool,
    clean_images: bool,
) -> dict:
    with _lock, _conn() as conn:
        time_rows = _time_rows(conn, older_than, start, end)
        delete_files: set[str] = set()
        for row in time_rows:
            delete_files |= _file_ids_in(json.loads(row["data"]))
        stored_delete_files = _stored_file_ids(conn, delete_files)
        stored_ids = _all_stored_file_ids(conn)
        clean = _scan_clean(
            conn.execute("SELECT id, data FROM sessions").fetchall(),
            clean_tools,
            clean_images,
            stored_ids,
        )
        stored = _stored_file_ids(conn, clean.pop("files"))
        clean_bytes = _file_bytes(conn, stored)
        return {
            "delete": {
                "sessions": len(time_rows),
                "files": len(stored_delete_files),
                "bytes": _file_bytes(conn, stored_delete_files),
            },
            "clean": {
                "sessions": clean["sessions"],
                "toolBlocks": clean["toolBlocks"],
                "images": len(stored),
                "bytes": clean_bytes,
            },
        }


def delete_sessions_by_time(
    older_than: int | None, start: int | None, end: int | None
) -> dict:
    with _lock, _conn() as conn:
        rows = _time_rows(conn, older_than, start, end)
        if not rows:
            return {"sessions": 0, "files": 0, "bytes": 0}
        removed_files: set[str] = set()
        for row in rows:
            removed_files |= _file_ids_in(json.loads(row["data"]))
        ids = [row["id"] for row in rows]
        conn.executemany("DELETE FROM sessions WHERE id = ?", [(session_id,) for session_id in ids])
        orphaned = removed_files - _remaining_file_ids(conn)
        orphaned_bytes = _file_bytes(conn, orphaned)
        blobs = _stored_file_ids(conn, orphaned)
        _delete_file_records(conn, orphaned)
        return {
            "sessions": len(ids),
            "files": len(blobs),
            "bytes": orphaned_bytes,
        }


def clean_sessions(clean_tools: bool, clean_images: bool) -> dict:
    if not clean_tools and not clean_images:
        return {"sessions": 0, "toolBlocks": 0, "images": 0, "bytes": 0}
    with _lock, _conn() as conn:
        rows = conn.execute("SELECT id, data FROM sessions").fetchall()
        stored_ids = _all_stored_file_ids(conn)
        affected = 0
        tool_blocks = 0
        image_ids: set[str] = set()
        for row in rows:
            session = json.loads(row["data"])
            changed = False
            for message in session.get("messages") or []:
                role = message.get("role")
                if role == "assistant" and clean_tools:
                    blocks = message.get("blocks") or []
                    kept = [
                        block
                        for block in blocks
                        if not (
                            isinstance(block, dict) and block.get("type") in _TOOL_BLOCK_TYPES
                        )
                    ]
                    if len(kept) != len(blocks):
                        tool_blocks += len(blocks) - len(kept)
                        message["blocks"] = kept
                        changed = True
                elif role == "user" and clean_images:
                    for item in message.get("files") or []:
                        if (
                            isinstance(item, dict)
                            and item.get("isImage")
                            and isinstance(item.get("id"), str)
                            and item["id"] in stored_ids
                        ):
                            image_ids.add(item["id"])
                            changed = True
                            if item.get("mimeType"):
                                item["mimeType"] = ""
            if changed:
                affected += 1
                conn.execute(
                    "UPDATE sessions SET data = ? WHERE id = ?",
                    (
                        json.dumps(session, ensure_ascii=False, separators=(",", ":")),
                        row["id"],
                    ),
                )
        total_bytes = _file_bytes(conn, image_ids)
        _delete_file_records(conn, image_ids)
        return {
            "sessions": affected,
            "toolBlocks": tool_blocks,
            "images": len(image_ids),
            "bytes": total_bytes,
        }


# ---------------- 附件原件 ----------------

def _atomic_write(target: Path, data: bytes) -> None:
    """同一附件可能被并发上传（输入框一次、会话保存一次）；已存在且大小一致就不再重写。
    Windows 上目标文件被读取时替换会报 WinError 5，失败后短暂重试。"""
    with _lock:
        if target.is_file() and target.stat().st_size == len(data):
            return
        tmp = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
        tmp.write_bytes(data)
        for attempt in range(5):
            try:
                os.replace(tmp, target)
                return
            except PermissionError:
                if attempt == 4:
                    tmp.unlink(missing_ok=True)
                    raise
                time.sleep(0.15 * (attempt + 1))


def save_file(file_id: str, name: str, mime: str, data: bytes) -> None:
    _check_id(file_id)
    _atomic_write(FILES_DIR / file_id, data)
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT INTO files (id, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, mime=excluded.mime, "
            "size=excluded.size",
            (file_id, name, mime, len(data), int(time.time() * 1000)),
        )


def file_meta(file_id: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
    return dict(row) if row else None


def file_path(file_id: str) -> Path | None:
    if not _ID_RE.match(file_id or ""):
        return None
    path = FILES_DIR / file_id
    return path if path.is_file() else None


def read_file(file_id: str) -> tuple[bytes, dict] | None:
    meta = file_meta(file_id)
    path = file_path(file_id)
    if not meta or not path:
        return None
    return path.read_bytes(), meta


def get_file_text(file_id: str) -> str | None:
    with _conn() as conn:
        row = conn.execute("SELECT text FROM file_texts WHERE file_id = ?", (file_id,)).fetchone()
    return row["text"] if row else None


def set_file_text(file_id: str, kind: str, text: str) -> None:
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT INTO file_texts (file_id, kind, text, created_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(file_id) DO UPDATE SET kind=excluded.kind, text=excluded.text",
            (file_id, kind, text, int(time.time() * 1000)),
        )


# ---------------- 历史导入暂存 ----------------

def clear_staging() -> None:
    with _lock, _conn() as conn:
        conn.execute("DELETE FROM staging_sessions")
        conn.execute("DELETE FROM staging_files")
    if STAGING_DIR.exists():
        for item in STAGING_DIR.iterdir():
            if item.is_file():
                item.unlink(missing_ok=True)


def add_staging_session(session: dict) -> None:
    session_id = _check_id(str(session.get("id", "")))
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO staging_sessions (id, data) VALUES (?, ?)",
            (session_id, json.dumps(session, ensure_ascii=False, separators=(",", ":"))),
        )


def save_staging_file(file_id: str, name: str, mime: str, data: bytes) -> None:
    _check_id(file_id)
    _atomic_write(STAGING_DIR / file_id, data)
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO staging_files (id, name, mime, size) VALUES (?, ?, ?, ?)",
            (file_id, name, mime, len(data)),
        )


def update_staging_file_types(types: dict[str, str]) -> None:
    with _lock, _conn() as conn:
        rows = conn.execute("SELECT id, data FROM staging_sessions").fetchall()
        for row in rows:
            session = json.loads(row["data"])
            changed = False
            for message in session.get("messages") or []:
                if message.get("role") != "user":
                    continue
                for item in message.get("files") or []:
                    if not isinstance(item, dict):
                        continue
                    mime = types.get(item.get("id", ""), "")
                    if item.get("mimeType") != mime:
                        item["mimeType"] = mime
                        changed = True
            if changed:
                conn.execute(
                    "UPDATE staging_sessions SET data = ? WHERE id = ?",
                    (json.dumps(session, ensure_ascii=False, separators=(",", ":")), row["id"]),
                )


def _session_file_meta(session: dict) -> dict[str, dict]:
    meta: dict[str, dict] = {}
    for message in session.get("messages") or []:
        if message.get("role") != "user":
            continue
        for item in message.get("files") or []:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                meta.setdefault(item["id"], item)
    return meta


def _apply_file_map(session: dict, file_map: dict[str, str]) -> None:
    if not file_map:
        return
    for message in session.get("messages") or []:
        if message.get("role") != "user":
            continue
        for item in message.get("files") or []:
            if not isinstance(item, dict):
                continue
            old = item.get("id")
            new = file_map.get(old) if isinstance(old, str) else None
            if new:
                item["id"] = new
            if isinstance(item.get("serverId"), str) and item["serverId"] == old:
                item["serverId"] = new


def _remap_session(session: dict) -> tuple[dict, dict[str, str], dict[str, dict]]:
    """冲突会话另存副本：会话、消息、附件全部换新 ID，保留分支结构。"""
    copy = json.loads(json.dumps(session))
    old_meta = _session_file_meta(copy)
    file_map = {file_id: str(uuid.uuid4()) for file_id in old_meta}
    new_session_id = str(uuid.uuid4())
    message_ids = {}
    for message in copy.get("messages") or []:
        old = message.get("id")
        if old is not None:
            message_ids[str(old)] = f"{new_session_id[:8]}_{old}"
    for message in copy.get("messages") or []:
        old = message.get("id")
        if old is not None and str(old) in message_ids:
            message["id"] = message_ids[str(old)]
        parent = message.get("parentId")
        if parent is not None:
            message["parentId"] = message_ids.get(str(parent))
        child = message.get("selectedChildId")
        if child is not None:
            message["selectedChildId"] = message_ids.get(str(child))
    _apply_file_map(copy, file_map)
    root = copy.get("rootMessageId")
    if root is not None:
        copy["rootMessageId"] = message_ids.get(str(root))
    summary = copy.get("summary")
    if isinstance(summary, dict) and summary.get("upToMessageId") is not None:
        summary["upToMessageId"] = message_ids.get(
            str(summary["upToMessageId"]), summary["upToMessageId"]
        )
    copy["id"] = new_session_id
    title = str(copy.get("title") or "导入的对话")
    copy["title"] = title if title.endswith("（副本）") else f"{title}（副本）"
    return copy, file_map, old_meta


def _staging_size(conn: sqlite3.Connection, file_id: str) -> int | None:
    row = conn.execute("SELECT size FROM staging_files WHERE id = ?", (file_id,)).fetchone()
    return int(row["size"]) if row else None


def _prepare_added_files(
    session: dict, conn: sqlite3.Connection, existing_files: dict[str, dict]
) -> tuple[dict[str, str], dict[str, dict]]:
    """新会话的附件若与现有文件重名但大小不同，换新 ID，避免贴错图。"""
    meta = _session_file_meta(session)
    file_map: dict[str, str] = {}
    for file_id in meta:
        existing = existing_files.get(file_id)
        if existing is None:
            continue
        staged = _staging_size(conn, file_id)
        if staged is not None and int(existing.get("size") or 0) != staged:
            file_map[file_id] = str(uuid.uuid4())
    _apply_file_map(session, file_map)
    return file_map, meta


def _install_files(
    conn: sqlite3.Connection,
    file_map: dict[str, str],
    meta: dict[str, dict],
    copied: list[str],
) -> None:
    now = int(time.time() * 1000)

    def install(old_id: str, new_id: str, session_file: dict | None) -> None:
        staged = conn.execute(
            "SELECT * FROM staging_files WHERE id = ?", (old_id,)
        ).fetchone()
        source = STAGING_DIR / old_id
        if staged is not None and source.is_file():
            if not (FILES_DIR / new_id).is_file():
                _atomic_write(FILES_DIR / new_id, source.read_bytes())
                copied.append(new_id)
            conn.execute(
                "INSERT OR REPLACE INTO files (id, name, mime, size, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (new_id, staged["name"], staged["mime"], staged["size"], now),
            )
            return
        # 没有原件的附件：只登记元数据，后续请求会自动跳过
        session_file = session_file or {}
        conn.execute(
            "INSERT OR REPLACE INTO files (id, name, mime, size, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                new_id,
                str(session_file.get("name") or ""),
                str(session_file.get("mimeType") or ""),
                int(session_file.get("size") or 0),
                now,
            ),
        )

    for old_id, new_id in file_map.items():
        install(old_id, new_id, meta.get(old_id))
    for file_id, item in meta.items():
        if file_id not in file_map:
            install(file_id, file_id, item)


def _clear_staging_files() -> None:
    if STAGING_DIR.exists():
        for item in STAGING_DIR.iterdir():
            if item.is_file():
                item.unlink(missing_ok=True)


def _replace_commit() -> dict:
    """用暂存内容整体替换会话与附件；失败时恢复原文件目录。"""
    backup = DATA_DIR / "files_previous"
    with _lock:
        if backup.exists():
            shutil.rmtree(backup, ignore_errors=True)
        swapped = False
        staging_rows = []
        try:
            with _conn() as conn:
                staging_rows = conn.execute("SELECT id, data FROM staging_sessions").fetchall()
            if FILES_DIR.exists():
                os.replace(FILES_DIR, backup)
            os.replace(STAGING_DIR, FILES_DIR)
            STAGING_DIR.mkdir(parents=True, exist_ok=True)
            swapped = True
            with _conn() as conn:
                conn.execute("DELETE FROM sessions")
                conn.execute("DELETE FROM files")
                conn.execute("DELETE FROM file_texts")
                for row in staging_rows:
                    session = json.loads(row["data"])
                    conn.execute(
                        "INSERT INTO sessions (id, title, created_at, updated_at, data) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (
                            row["id"],
                            str(session.get("title") or ""),
                            int(session.get("createdAt") or 0),
                            int(session.get("updatedAt") or 0),
                            row["data"],
                        ),
                    )
                for row in conn.execute("SELECT * FROM staging_files").fetchall():
                    conn.execute(
                        "INSERT INTO files (id, name, mime, size, created_at) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (
                            row["id"],
                            row["name"],
                            row["mime"],
                            row["size"],
                            int(time.time() * 1000),
                        ),
                    )
                conn.execute("DELETE FROM staging_sessions")
                conn.execute("DELETE FROM staging_files")
        except Exception:
            if swapped:
                shutil.rmtree(FILES_DIR, ignore_errors=True)
                if backup.exists():
                    os.replace(backup, FILES_DIR)
                STAGING_DIR.mkdir(parents=True, exist_ok=True)
            raise
        shutil.rmtree(backup, ignore_errors=True)
    return {"sessions": list_sessions(), "added": len(staging_rows)}


def _merge_commit(mode: str) -> dict:
    """合并导入：保留现有数据，只追加新会话。"""
    copied: list[str] = []
    added = 0
    with _lock:
        try:
            with _conn() as conn:
                existing_sessions = {
                    row["id"] for row in conn.execute("SELECT id FROM sessions").fetchall()
                }
                existing_files = {
                    row["id"]: dict(row)
                    for row in conn.execute("SELECT * FROM files").fetchall()
                }
                rows = conn.execute("SELECT id, data FROM staging_sessions").fetchall()
                for row in rows:
                    session = json.loads(row["data"])
                    session_id = row["id"]
                    conflict = session_id in existing_sessions
                    if conflict and mode == "merge-skip":
                        continue
                    if conflict:
                        session, file_map, meta = _remap_session(session)
                        session_id = session["id"]
                    else:
                        file_map, meta = _prepare_added_files(session, conn, existing_files)
                    _install_files(conn, file_map, meta, copied)
                    conn.execute(
                        "INSERT INTO sessions (id, title, created_at, updated_at, data) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (
                            session_id,
                            str(session.get("title") or ""),
                            int(session.get("createdAt") or 0),
                            int(session.get("updatedAt") or 0),
                            json.dumps(session, ensure_ascii=False, separators=(",", ":")),
                        ),
                    )
                    existing_sessions.add(session_id)
                    added += 1
                conn.execute("DELETE FROM staging_sessions")
                conn.execute("DELETE FROM staging_files")
        except Exception:
            for file_id in copied:
                try:
                    (FILES_DIR / file_id).unlink(missing_ok=True)
                except OSError:
                    pass
            raise
        _clear_staging_files()
    return {"sessions": list_sessions(), "added": added}


def commit_staging(mode: str = "replace") -> dict:
    if mode not in ("replace", "merge-skip", "merge-copy"):
        raise ValueError(f"未知导入方式：{mode}")
    if mode == "replace":
        return _replace_commit()
    return _merge_commit(mode)
