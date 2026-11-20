"""长期记忆：条目存储、注入文本、待确认提案与模型工具。

两条规则贯穿全文件：
- 写入只认用户，不认网页：手动保存直接入库；模型提议先进入待确认队列。
- 注入与工具查询互不重复：本轮注入过的条目，search_memory 不再返回。
"""
from __future__ import annotations

import array
import json
import logging
import math
import re
import time
from datetime import datetime

import config
import storage
from providers import embedding as embedding_provider
from providers import rerank as rerank_provider

MAX_TEXT = 300
MAX_DESCRIPTION = 30
MAX_ITEMS = 200
DAILY_PROPOSALS = 20

TOOL_NAMES = ("search_memory", "remember", "edit_memory")

_log = logging.getLogger("memory")


def init() -> None:
    with storage._lock, storage._conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                pinned INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'manual',
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS memory_vectors (
                memory_id INTEGER PRIMARY KEY,
                model TEXT NOT NULL DEFAULT '',
                dim INTEGER NOT NULL DEFAULT 0,
                vec BLOB NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS memory_proposals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL DEFAULT 'tool',
                payload TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL DEFAULT 0,
                session_id TEXT NOT NULL DEFAULT '',
                notified INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        memory_columns = {row["name"] for row in conn.execute("PRAGMA table_info(memories)")}
        if "description" not in memory_columns:
            conn.execute("ALTER TABLE memories ADD COLUMN description TEXT NOT NULL DEFAULT ''")
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(memory_proposals)")}
        if "session_id" not in columns:
            conn.execute(
                "ALTER TABLE memory_proposals ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"
            )
        if "notified" not in columns:
            conn.execute(
                "ALTER TABLE memory_proposals ADD COLUMN notified INTEGER NOT NULL DEFAULT 0"
            )


def _now() -> int:
    return int(time.time())


def _row(row) -> dict:
    return {
        "id": row["id"],
        "text": row["text"],
        "description": row["description"] if "description" in row.keys() else "",
        "pinned": bool(row["pinned"]),
        "source": row["source"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _days_ago(ts: int) -> str:
    days = int((_now() - ts) / 86400)
    return "今天" if days <= 0 else f"{days} 天前"


def _clean_description(value: object) -> str:
    text = " ".join(str(value or "").split())
    if len(text) > MAX_DESCRIPTION:
        raise ValueError(f"记忆说明最多 {MAX_DESCRIPTION} 字")
    return text


def _clean_text(value: object) -> str:
    text = " ".join(str(value or "").split())
    if not text:
        raise ValueError("记忆内容不能为空")
    if len(text) > MAX_TEXT:
        raise ValueError(f"单条记忆最多 {MAX_TEXT} 字")
    return text


def _similarity(a: str, b: str) -> float:
    left = re.sub(r"\s+", "", a).lower()
    right = re.sub(r"\s+", "", b).lower()
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    a_set, b_set = set(left), set(right)
    return len(a_set & b_set) / max(1, len(a_set | b_set))


def _similar(a: str, b: str) -> bool:
    return _similarity(a, b) >= 0.8


def _find_similar(conn, text: str) -> dict | None:
    for row in conn.execute("SELECT * FROM memories ORDER BY id DESC"):
        if _similar(row["text"], text):
            return _row(row)
    return None


def list_items() -> list[dict]:
    with storage._conn() as conn:
        rows = conn.execute(
            "SELECT * FROM memories ORDER BY pinned DESC, updated_at DESC, id DESC"
        ).fetchall()
    return [_row(row) for row in rows]


def stats() -> dict:
    """调试面板用：条目、向量覆盖率、模式与上次错误。"""
    with storage._conn() as conn:
        items = conn.execute("SELECT COUNT(*) AS n FROM memories").fetchone()["n"]
        pinned = conn.execute("SELECT COUNT(*) AS n FROM memories WHERE pinned = 1").fetchone()["n"]
        vectors = conn.execute(
            "SELECT COUNT(*) AS n, MIN(model) AS model, MIN(dim) AS dim FROM memory_vectors"
        ).fetchone()
        missing = conn.execute(
            "SELECT COUNT(*) AS n FROM memories m "
            "LEFT JOIN memory_vectors v ON v.memory_id = m.id WHERE v.memory_id IS NULL"
        ).fetchone()["n"]
        pending = conn.execute(
            "SELECT COUNT(*) AS n FROM memory_proposals WHERE status = 'pending'"
        ).fetchone()["n"]
    return {
        "enabled": bool(config.MEMORY_ENABLED),
        "items": items,
        "pinned": pinned,
        "vectors": vectors["n"],
        "vectors_missing": missing if embedding_provider.configured() else 0,
        "vector_model": vectors["model"] or "",
        "vector_dim": vectors["dim"] or 0,
        "pending": pending,
        "inject_mode": config.MEMORY_INJECT_MODE,
        "inject_count": config.MEMORY_INJECT_COUNT,
        "search_mode": config.MEMORY_SEARCH_MODE,
        "sim_threshold": config.MEMORY_SIM_THRESHOLD,
        "tools": bool(config.MEMORY_TOOLS),
        "write": config.MEMORY_WRITE,
        "embedding_configured": embedding_provider.configured(),
        "rerank_configured": rerank_provider.configured(),
        "last_error": LAST_ERROR,
    }


def add_item(
    text: object,
    pinned: bool = False,
    source: str = "manual",
    description: object = "",
) -> dict:
    text = _clean_text(text)
    description = _clean_description(description)
    with storage._lock, storage._conn() as conn:
        similar = _find_similar(conn, text)
        if similar is not None:
            raise ValueError(f"已有相似记忆：{similar['text']}")
        count = conn.execute("SELECT COUNT(*) AS n FROM memories").fetchone()["n"]
        if count >= MAX_ITEMS:
            raise ValueError(f"记忆已达 {MAX_ITEMS} 条上限，请先整理")
        now = _now()
        cursor = conn.execute(
            "INSERT INTO memories (text, description, pinned, source, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (text, description, 1 if pinned else 0, source, now, now),
        )
        row = conn.execute("SELECT * FROM memories WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _row(row)


def update_item(
    item_id: int,
    text: object | None = None,
    pinned: bool | None = None,
    description: object | None = None,
) -> dict:
    with storage._lock, storage._conn() as conn:
        row = conn.execute("SELECT * FROM memories WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise ValueError("记忆不存在")
        new_text = _clean_text(text) if text is not None else row["text"]
        new_description = (
            _clean_description(description) if description is not None else row["description"]
        )
        if text is not None and new_text != row["text"]:
            similar = _find_similar(conn, new_text)
            if similar is not None and similar["id"] != item_id:
                raise ValueError(f"已有相似记忆：{similar['text']}")
        new_pinned = row["pinned"] if pinned is None else (1 if pinned else 0)
        conn.execute(
            "UPDATE memories SET text = ?, description = ?, pinned = ?, updated_at = ? WHERE id = ?",
            (new_text, new_description, new_pinned, _now(), item_id),
        )
        if new_text != row["text"] or new_description != row["description"]:
            conn.execute("DELETE FROM memory_vectors WHERE memory_id = ?", (item_id,))
        row = conn.execute("SELECT * FROM memories WHERE id = ?", (item_id,)).fetchone()
    return _row(row)


def delete_item(item_id: int) -> None:
    with storage._lock, storage._conn() as conn:
        conn.execute("DELETE FROM memories WHERE id = ?", (item_id,))
        conn.execute("DELETE FROM memory_vectors WHERE memory_id = ?", (item_id,))


def tidy_suggestions(limit: int = 20) -> list[dict]:
    """疑似重复的条目对；只出建议，是否合并由用户决定。"""
    rows = _all_rows()
    pairs = []
    for index in range(len(rows)):
        for other in range(index + 1, len(rows)):
            first, second = rows[index], rows[other]
            score = _similarity(first["text"], second["text"])
            need = 0.8 if min(len(first["text"]), len(second["text"])) < 12 else 0.6
            if score >= need:
                pairs.append({"a": first, "b": second, "score": round(score, 3)})
    pairs.sort(key=lambda item: -item["score"])
    return pairs[:limit]


def merge_items(keep_id: int, drop_id: int) -> dict:
    if keep_id == drop_id:
        raise ValueError("不能合并同一条")
    with storage._lock, storage._conn() as conn:
        keep = conn.execute("SELECT * FROM memories WHERE id = ?", (keep_id,)).fetchone()
        drop = conn.execute("SELECT * FROM memories WHERE id = ?", (drop_id,)).fetchone()
        if keep is None or drop is None:
            raise ValueError("条目不存在，可能已被删除")
        if drop["pinned"] and not keep["pinned"]:
            conn.execute("UPDATE memories SET pinned = 1 WHERE id = ?", (keep_id,))
        if drop["description"] and not keep["description"]:
            conn.execute(
                "UPDATE memories SET description = ? WHERE id = ?",
                (drop["description"], keep_id),
            )
            conn.execute("DELETE FROM memory_vectors WHERE memory_id = ?", (keep_id,))
        conn.execute("DELETE FROM memories WHERE id = ?", (drop_id,))
        conn.execute("DELETE FROM memory_vectors WHERE memory_id = ?", (drop_id,))
        row = conn.execute("SELECT * FROM memories WHERE id = ?", (keep_id,)).fetchone()
    return _row(row)


def clear_all() -> None:
    with storage._lock, storage._conn() as conn:
        conn.execute("DELETE FROM memories")
        conn.execute("DELETE FROM memory_proposals")
        conn.execute("DELETE FROM memory_vectors")


def export_text() -> str:
    items = list_items()
    if not items:
        return ""
    lines = []
    for item in items:
        mark = "[置顶] " if item["pinned"] else ""
        lines.append(f"- {mark}{item['text']}")
        if item.get("description"):
            lines.append(f"  说明：{item['description']}")
    return "\n".join(lines)


def _parse_import(raw: str) -> list[tuple[str, bool, str]]:
    """接受导出的 txt（- [置顶] 内容 与下一行说明）或 JSON（{items:[...]} / 数组）。"""
    raw = raw.strip()
    if not raw:
        raise ValueError("文件是空的")
    if raw[0] in "[{":
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ValueError(f"JSON 解析失败：{error}")
        rows = data.get("items") if isinstance(data, dict) else data
        if not isinstance(rows, list):
            raise ValueError("JSON 需要是数组，或带 items 数组的对象")
        result: list[tuple[str, bool, str]] = []
        for row in rows:
            description = ""
            if isinstance(row, str):
                text, pinned = row, False
            elif isinstance(row, dict):
                text, pinned = str(row.get("text") or ""), bool(row.get("pinned"))
                description = " ".join(str(row.get("description") or "").split())[
                    :MAX_DESCRIPTION
                ]
            else:
                continue
            text = " ".join(text.split())
            if text:
                result.append((text, pinned, description))
        return result
    result: list[tuple[str, bool, str]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        bullet = False
        for prefix in ("- ", "* ", "• ", "· "):
            if line.startswith(prefix):
                line = line[len(prefix) :].strip()
                bullet = True
                break
        if not bullet and result and line.startswith("说明：") and not result[-1][2]:
            text, pinned, _ = result[-1]
            result[-1] = (text, pinned, line[3:].strip())
            continue
        pinned = False
        for mark in ("[置顶]", "【置顶】", "(置顶)", "（置顶）"):
            if line.startswith(mark):
                pinned = True
                line = line[len(mark) :].strip()
                break
        if line:
            result.append((line, pinned, ""))
    return result


def import_text(raw: str) -> dict:
    """导入记忆：与已有条目相似或文件内重复的都跳过，不覆盖、不删除。"""
    parsed = _parse_import(raw)
    added = 0
    skipped = 0
    seen: list[str] = []
    with storage._lock, storage._conn() as conn:
        count = conn.execute("SELECT COUNT(*) AS n FROM memories").fetchone()["n"]
        now = _now()
        for text, pinned, description in parsed:
            if len(text) > MAX_TEXT or count + added >= MAX_ITEMS:
                skipped += 1
                continue
            if any(_similar(text, other) for other in seen) or _find_similar(conn, text) is not None:
                skipped += 1
                continue
            conn.execute(
                "INSERT INTO memories "
                "(text, description, pinned, source, created_at, updated_at) "
                "VALUES (?, ?, ?, 'import', ?, ?)",
                (text, description, 1 if pinned else 0, now, now),
            )
            seen.append(text)
            added += 1
    return {"added": added, "skipped": skipped, "total": len(parsed)}


_QUERY_CACHE: dict[tuple[str, str], list[float]] = {}
LAST_ERROR = ""


def _note_error(message: str) -> None:
    global LAST_ERROR
    LAST_ERROR = str(message)[:300]


def _norm(vec: list[float]) -> list[float]:
    mag = math.sqrt(sum(value * value for value in vec))
    return [value / mag for value in vec] if mag else vec


def _pack(vec: list[float]) -> bytes:
    return array.array("f", vec).tobytes()


def _unpack(blob: bytes) -> list[float]:
    values = array.array("f")
    values.frombytes(blob)
    return list(values)


def _cos(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right))


def _embeddings_ready() -> bool:
    return bool(config.capabilities().get("embedding"))


def _embed_text(row: dict) -> str:
    description = str(row.get("description") or "").strip()
    return f"{description}\n{row['text']}" if description else row["text"]


def _sync_vectors(rows: list[dict]) -> dict[int, list[float]]:
    """确保这些记忆都有当前模型/维度的向量；缺的批量补上。"""
    model = config.EMBEDDING_MODEL
    dim = int(config.EMBEDDING_DIM)
    with storage._conn() as conn:
        known = {
            row["memory_id"]: _unpack(row["vec"])
            for row in conn.execute(
                "SELECT memory_id, vec FROM memory_vectors WHERE model = ? AND dim = ?",
                (model, dim),
            )
        }
    missing = [row for row in rows if row["id"] not in known]
    if missing:
        vectors = embedding_provider.embed_batched([_embed_text(row) for row in missing])
        with storage._lock, storage._conn() as conn:
            for row, vec in zip(missing, vectors):
                if len(vec) != dim:
                    raise RuntimeError(f"向量维度不一致：配置 {dim}，接口返回 {len(vec)}")
                unit = _norm(vec)
                known[row["id"]] = unit
                conn.execute(
                    "INSERT OR REPLACE INTO memory_vectors "
                    "(memory_id, model, dim, vec, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (row["id"], model, dim, _pack(unit), _now()),
                )
    return {row["id"]: known[row["id"]] for row in rows if row["id"] in known}


def _query_vector(text: str) -> list[float]:
    key = (config.EMBEDDING_MODEL, text)
    cached = _QUERY_CACHE.get(key)
    if cached is not None:
        return cached
    vec = _norm(embedding_provider.embed([text])[0])
    dim = int(config.EMBEDDING_DIM)
    if dim and len(vec) != dim:
        raise RuntimeError(f"向量维度不一致：配置 {dim}，接口返回 {len(vec)}")
    if len(_QUERY_CACHE) > 32:
        _QUERY_CACHE.clear()
    _QUERY_CACHE[key] = vec
    return vec


def _rerank_rows(query: str, picked: list[dict], top: int) -> list[dict]:
    if len(picked) <= top or not rerank_provider.configured():
        return picked[:top]
    try:
        order = rerank_provider.rerank(query, [row["text"] for row in picked])
        return [picked[index] for index in order if 0 <= index < len(picked)][:top]
    except Exception as error:
        _note_error(f"重排不可用，按向量顺序：{error}")
        return picked[:top]


def _semantic_order(query: str, rows: list[dict], top: int) -> list[dict]:
    vectors = _sync_vectors(rows)
    query_vec = _query_vector(query)
    pairs = [
        (_cos(query_vec, vectors[row["id"]]), row) for row in rows if row["id"] in vectors
    ]
    # 低于门槛的不算“相关”，宁可少注入也不硬塞
    pairs = [item for item in pairs if item[0] >= config.MEMORY_SIM_THRESHOLD]
    pairs.sort(key=lambda item: item[0], reverse=True)
    return _rerank_rows(query, [row for _, row in pairs], top)


def _tokens(query: str) -> list[str]:
    parts = [part for part in re.split(r"[\s,，。;；、!?！？:：/]+", query.lower()) if part]
    tokens: list[str] = []
    for part in parts:
        tokens.append(part)
        if len(part) >= 2 and re.search(r"[\u4e00-\u9fff]", part):
            tokens.extend(part[i : i + 2] for i in range(len(part) - 1))
    return tokens


def _literal_tokens(query: str) -> list[str]:
    return [part for part in re.split(r"[\s,，。;；、!?！？:：/]+", query.lower()) if part]


def _score_order(query: str, rows: list[dict]) -> list[dict]:
    tokens = _tokens(query)
    scored = []
    for row in rows:
        text = row["text"].lower()
        description = str(row.get("description") or "").lower()
        score = sum(2 * description.count(token) + text.count(token) for token in tokens)
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda item: (-item[0], -item[1]["updatedAt"]))
    return [row for _, row in scored]


def _keyword_order(query: str, rows: list[dict]) -> list[dict]:
    tokens = _literal_tokens(query)
    if not tokens:
        return []
    scored = []
    for row in rows:
        text = row["text"].lower()
        description = str(row.get("description") or "").lower()
        score = sum(2 * description.count(token) + text.count(token) for token in tokens)
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda item: (-item[0], -item[1]["updatedAt"]))
    return [row for _, row in scored]


def _all_rows() -> list[dict]:
    with storage._conn() as conn:
        rows = conn.execute(
            "SELECT * FROM memories ORDER BY pinned DESC, updated_at DESC, id DESC"
        ).fetchall()
    return [_row(row) for row in rows]


def injection(query: str = "") -> tuple[str, set[int]]:
    """返回 (注入文本, 本轮已注入的 id 集合)；关闭注入时返回空。

    置顶条目始终保留（最多占满名额），其余按注入模式挑选；挑不出结果时回退最近。
    """
    mode = str(config.MEMORY_INJECT or "recent")
    if not config.MEMORY_ENABLED or mode == "off":
        return "", set()
    count = max(1, min(10, int(config.MEMORY_INJECT_COUNT or 5)))
    rows = _all_rows()
    if not rows:
        return "", set()
    if mode == "recent":
        picked = rows[:count]
    else:
        pinned = [row for row in rows if row["pinned"]][:count]
        others = [row for row in rows if not row["pinned"]]
        picked = list(pinned)
        need = count - len(picked)
        if need > 0 and others:
            ranked: list[dict] = []
            if mode == "embedding" and _embeddings_ready():
                try:
                    ranked = _semantic_order(query, others, need)
                except Exception as error:
                    _note_error(f"向量检索不可用，回退本地打分：{error}")
            if not ranked:
                # 没有任何命中就只保留置顶条目，不再回退“最近”硬凑满
                ranked = _score_order(query, others) or _keyword_order(query, others)
            chosen = {row["id"] for row in picked}
            for row in ranked:
                if len(picked) >= count:
                    break
                if row["id"] not in chosen:
                    picked.append(row)
                    chosen.add(row["id"])
    body = "\n".join(
        f"- {row['text']}（说明：{row['description']}）"
        if row["description"]
        else f"- {row['text']}"
        for row in picked
    )
    return (
        "以下是我对用户的长期记忆，可能过时，与本轮无关就忽略：\n" + body,
        {row["id"] for row in picked},
    )


def search(
    query: str, exclude: set[int] | None = None, mode: str | None = None
) -> tuple[str, list[int]]:
    started = time.perf_counter()
    query = str(query or "").strip()
    if not query:
        return "查询词为空。", []
    mode = mode or str(config.MEMORY_SEARCH_MODE or "score")
    exclude = exclude or set()
    rows = [row for row in _all_rows() if row["id"] not in exclude]
    if not rows:
        return "没有找到未注入本轮上下文的记忆。", []
    picked: list[dict] = []
    if mode == "embedding" and _embeddings_ready():
        try:
            picked = _semantic_order(query, rows, 5)
        except Exception as error:
            _note_error(f"向量检索不可用，回退本地打分：{error}")
    if not picked and mode == "keyword":
        picked = _keyword_order(query, rows)[:5]
    if not picked:
        picked = _score_order(query, rows)[:5]
    if not picked:
        _log.info("memory search mode=%s hits=0 ms=%d", mode, round((time.perf_counter() - started) * 1000))
        return "没有找到未注入本轮上下文的记忆。", []
    lines = [
        f"[{index}] {row['text']}"
        + (f"（说明：{row['description']}）" if row["description"] else "")
        + f"（更新于 {_days_ago(row['updatedAt'])}）"
        for index, row in enumerate(picked, start=1)
    ]
    _log.info(
        "memory search mode=%s hits=%d ms=%d",
        mode,
        len(picked),
        round((time.perf_counter() - started) * 1000),
    )
    return "\n".join(lines), [row["id"] for row in picked]


def _today_start() -> int:
    now = datetime.now()
    return int(now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())


def propose(
    text: object,
    pinned: bool = False,
    kind: str = "tool",
    session: str = "",
    description: object = "",
) -> int:
    text = _clean_text(text)
    description = _clean_description(description)
    if not config.MEMORY_ENABLED or config.MEMORY_WRITE == "off":
        raise ValueError("记忆写入已关闭")
    with storage._lock, storage._conn() as conn:
        similar = _find_similar(conn, text)
        if similar is not None:
            raise ValueError(f"已有相似记忆：{similar['text']}")
        today = conn.execute(
            "SELECT COUNT(*) AS n FROM memory_proposals WHERE created_at >= ?",
            (_today_start(),),
        ).fetchone()["n"]
        if today >= DAILY_PROPOSALS:
            raise ValueError(f"今天已提议 {DAILY_PROPOSALS} 条，先确认或忽略后再写")
        cursor = conn.execute(
            "INSERT INTO memory_proposals (kind, payload, status, created_at, session_id) "
            "VALUES (?, ?, 'pending', ?, ?)",
            (
                kind,
                json.dumps(
                    {"text": text, "pinned": bool(pinned), "description": description},
                    ensure_ascii=False,
                ),
                _now(),
                str(session or "")[:128],
            ),
        )
        return int(cursor.lastrowid)


def _resolve_target(conn, old_text: str) -> dict:
    wanted = re.sub(r"\s+", "", str(old_text or "")).lower()
    if not wanted:
        raise ValueError("要修改的记忆原文不能为空")
    rows = conn.execute("SELECT * FROM memories ORDER BY id DESC").fetchall()
    for row in rows:
        if re.sub(r"\s+", "", row["text"]).lower() == wanted:
            return _row(row)
    matches = [_row(row) for row in rows if _similar(row["text"], old_text)]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise ValueError("没有找到这条记忆，先用 search_memory 确认原文")
    names = "；".join(item["text"][:30] for item in matches[:3])
    raise ValueError(f"有多条相似记忆，先用 search_memory 确认要改哪一条：{names}")


def propose_edit(
    old_text: object,
    new_text: object,
    pinned: bool | None = None,
    session: str = "",
    description: object | None = None,
) -> int:
    text = _clean_text(new_text)
    clean_description = None if description is None else _clean_description(description)
    if not config.MEMORY_ENABLED or config.MEMORY_WRITE == "off":
        raise ValueError("记忆写入已关闭")
    with storage._lock, storage._conn() as conn:
        target = _resolve_target(conn, str(old_text or ""))
        if text == target["text"] and pinned is None and clean_description is None:
            raise ValueError("新旧内容相同，不用修改")
        for row in conn.execute(
            "SELECT payload FROM memory_proposals WHERE status = 'pending' AND kind = 'edit'"
        ):
            try:
                data = json.loads(row["payload"])
            except json.JSONDecodeError:
                continue
            if data.get("target_id") == target["id"]:
                raise ValueError("这条记忆已有待确认的修改，先在设置里处理")
        similar = _find_similar(conn, text)
        if similar is not None and similar["id"] != target["id"]:
            raise ValueError(f"已有相似记忆：{similar['text']}")
        today = conn.execute(
            "SELECT COUNT(*) AS n FROM memory_proposals WHERE created_at >= ?",
            (_today_start(),),
        ).fetchone()["n"]
        if today >= DAILY_PROPOSALS:
            raise ValueError(f"今天已提议 {DAILY_PROPOSALS} 条，先确认或忽略后再写")
        payload: dict = {"text": text, "old_text": target["text"], "target_id": target["id"]}
        if pinned is not None:
            payload["pinned"] = bool(pinned)
        if clean_description is not None:
            payload["description"] = clean_description
        cursor = conn.execute(
            "INSERT INTO memory_proposals (kind, payload, status, created_at, session_id) "
            "VALUES ('edit', ?, 'pending', ?, ?)",
            (json.dumps(payload, ensure_ascii=False), _now(), str(session or "")[:128]),
        )
        return int(cursor.lastrowid)


def take_session_events(session: str) -> list[dict]:
    """取走本会话里已确认/已忽略、还没告诉过模型的提案，只回执一次。"""
    session = str(session or "").strip()
    if not session:
        return []
    with storage._lock, storage._conn() as conn:
        rows = conn.execute(
            "SELECT id, kind, payload, status FROM memory_proposals "
            "WHERE session_id = ? AND notified = 0 AND status IN ('accepted', 'rejected') "
            "ORDER BY id",
            (session,),
        ).fetchall()
        if not rows:
            return []
        conn.executemany(
            "UPDATE memory_proposals SET notified = 1 WHERE id = ?",
            [(row["id"],) for row in rows],
        )
    events = []
    for row in rows:
        try:
            payload = json.loads(row["payload"])
        except json.JSONDecodeError:
            continue
        text = str(payload.get("text") or "").strip()
        if text:
            events.append(
                {
                    "text": text,
                    "status": row["status"],
                    "kind": row["kind"],
                    "old_text": str(payload.get("old_text") or ""),
                }
            )
    return events


def pending_proposals() -> list[dict]:
    with storage._conn() as conn:
        rows = conn.execute(
            "SELECT * FROM memory_proposals WHERE status = 'pending' ORDER BY created_at DESC, id DESC"
        ).fetchall()
    result = []
    for row in rows:
        try:
            payload = json.loads(row["payload"])
        except json.JSONDecodeError:
            payload = {}
        item = {
            "id": row["id"],
            "kind": row["kind"],
            "text": payload.get("text") or "",
            "description": payload.get("description") or "",
            "pinned": bool(payload.get("pinned")),
            "createdAt": row["created_at"],
        }
        if row["kind"] == "edit":
            item["oldText"] = payload.get("old_text") or ""
        result.append(item)
    return result


def _set_status(conn, proposal_id: int, status: str) -> None:
    conn.execute("UPDATE memory_proposals SET status = ? WHERE id = ?", (status, proposal_id))


def accept_proposal(proposal_id: int) -> dict:
    with storage._lock, storage._conn() as conn:
        row = conn.execute("SELECT * FROM memory_proposals WHERE id = ?", (proposal_id,)).fetchone()
        if row is None or row["status"] != "pending":
            raise ValueError("提案不存在或已处理")
        payload = json.loads(row["payload"])
        text = str(payload.get("text") or "").strip()
        if row["kind"] == "edit":
            target_id = int(payload.get("target_id") or 0)
            target = conn.execute("SELECT * FROM memories WHERE id = ?", (target_id,)).fetchone()
            if target is None or not text:
                _set_status(conn, proposal_id, "rejected")
                raise ValueError("原记忆已不存在，这条修改作废")
            similar = _find_similar(conn, text)
            if similar is not None and similar["id"] != target_id:
                raise ValueError(f"已有相似记忆：{similar['text']}")
            merged_pinned = (
                bool(payload["pinned"]) if "pinned" in payload else bool(target["pinned"])
            )
            merged_description = (
                str(payload["description"])
                if "description" in payload
                else target["description"]
            )
            conn.execute(
                "UPDATE memories SET text = ?, description = ?, pinned = ?, updated_at = ? "
                "WHERE id = ?",
                (text, merged_description, 1 if merged_pinned else 0, _now(), target_id),
            )
            if text != target["text"] or merged_description != target["description"]:
                conn.execute("DELETE FROM memory_vectors WHERE memory_id = ?", (target_id,))
            _set_status(conn, proposal_id, "accepted")
            return _row(
                conn.execute("SELECT * FROM memories WHERE id = ?", (target_id,)).fetchone()
            )
        pinned = bool(payload.get("pinned"))
        description = str(payload.get("description") or "")
        item = None
        if text:
            similar = _find_similar(conn, text)
            if similar is None:
                now = _now()
                cursor = conn.execute(
                    "INSERT INTO memories "
                    "(text, description, pinned, source, created_at, updated_at) "
                    "VALUES (?, ?, ?, 'tool', ?, ?)",
                    (text, description, 1 if pinned else 0, now, now),
                )
                item = _row(
                    conn.execute(
                        "SELECT * FROM memories WHERE id = ?", (cursor.lastrowid,)
                    ).fetchone()
                )
        _set_status(conn, proposal_id, "accepted")
    return item or {"id": None, "text": text, "pinned": pinned}


def reject_proposal(proposal_id: int) -> None:
    with storage._lock, storage._conn() as conn:
        row = conn.execute("SELECT * FROM memory_proposals WHERE id = ?", (proposal_id,)).fetchone()
        if row is None or row["status"] != "pending":
            raise ValueError("提案不存在或已处理")
        _set_status(conn, proposal_id, "rejected")
