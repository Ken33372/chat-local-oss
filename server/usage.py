"""对话用量记录与统计。

云端由前端上报，自建后端直接记录所有模型轮次的累计用量。
这里只负责落库、按天/按模型聚合，以及用可编辑单价估算费用。
单价按「每百万 tokens」填写，只用于估算，与实际账单无关；0 表示不计费。
只统计对话请求，不含标题生成、附件解析、向量与重排等后台调用。
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import date, datetime, time as clock, timedelta

import config
import storage

PRICING_PATH = config.DATA_DIR / "usage_pricing.json"
DEFAULT_PRICING = {"input": 0.0, "cache_read": 0.0, "output": 0.0, "currency": "CNY"}
MAX_PRICE = 100000.0
MAX_TOKENS = 10**9
UNIT = 1_000_000

_lock = threading.RLock()


def init() -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _lock, storage._conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS usage_events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL DEFAULT '',
                ts INTEGER NOT NULL DEFAULT 0,
                model TEXT NOT NULL DEFAULT '',
                mode TEXT NOT NULL DEFAULT '',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS usage_events_ts ON usage_events(ts);
            """
        )


def _count(value: object) -> int:
    try:
        number = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, min(MAX_TOKENS, number))


def _price(value: object) -> float:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return round(max(0.0, min(MAX_PRICE, number)), 6)


def _line(value: object, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def pricing() -> dict:
    try:
        data = json.loads(PRICING_PATH.read_text("utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    currency = str(data.get("currency") or "CNY").upper()
    return {
        "input": _price(data.get("input")),
        "cache_read": _price(data.get("cache_read")),
        "output": _price(data.get("output")),
        "currency": currency if currency in ("CNY", "USD") else "CNY",
    }


def save_pricing(body: dict) -> dict:
    current = pricing()
    next_value = {
        "input": _price(body.get("input", current["input"])),
        "cache_read": _price(body.get("cache_read", current["cache_read"])),
        "output": _price(body.get("output", current["output"])),
        "currency": str(body.get("currency") or current["currency"]).upper(),
    }
    if next_value["currency"] not in ("CNY", "USD"):
        next_value["currency"] = "CNY"
    temp = PRICING_PATH.with_suffix(".json.tmp")
    temp.write_text(json.dumps(next_value, ensure_ascii=False, indent=2), "utf-8")
    os.replace(temp, PRICING_PATH)
    return next_value


def record(body: dict) -> dict:
    event_id = _line(body.get("id"), 80)
    if not event_id:
        raise ValueError("缺少用量事件 id")
    usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
    input_tokens = _count(usage.get("input_tokens"))
    cache_read = _count(usage.get("cache_read_input_tokens"))
    cache_creation = _count(usage.get("cache_creation_input_tokens"))
    output_tokens = _count(usage.get("output_tokens"))
    # 部分自建服务不返回用量，全 0 的事件没有统计价值，直接丢弃
    if input_tokens + cache_read + cache_creation + output_tokens <= 0:
        return {"ok": True, "recorded": False}
    mode = str(body.get("mode") or "")
    with _lock, storage._conn() as conn:
        cursor = conn.execute(
            "INSERT OR IGNORE INTO usage_events "
            "(id, session_id, ts, model, mode, input_tokens, cache_read_tokens, "
            "cache_creation_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                event_id,
                _line(body.get("session_id"), 128),
                int(time.time()),
                _line(body.get("model"), 80),
                mode if mode in ("cloud", "local") else "",
                input_tokens,
                cache_read,
                cache_creation,
                output_tokens,
            ),
        )
        recorded = cursor.rowcount > 0
    return {"ok": True, "recorded": recorded}


def clear() -> dict:
    with _lock, storage._conn() as conn:
        conn.execute("DELETE FROM usage_events")
    return {"ok": True}


def _cost(row: dict, prices: dict) -> float:
    return (
        (row["input"] + row["cache_creation"]) * prices["input"]
        + row["cache_read"] * prices["cache_read"]
        + row["output"] * prices["output"]
    ) / UNIT


def _blank() -> dict:
    return {
        "calls": 0,
        "input": 0,
        "cache_read": 0,
        "cache_creation": 0,
        "output": 0,
    }


def _merge(target: dict, row: dict) -> None:
    target["calls"] += 1
    target["input"] += row["input"]
    target["cache_read"] += row["cache_read"]
    target["cache_creation"] += row["cache_creation"]
    target["output"] += row["output"]


def _finish(row: dict, prices: dict) -> dict:
    prompt = row["input"] + row["cache_creation"] + row["cache_read"]
    return {
        **row,
        "hit_rate": round(row["cache_read"] / prompt, 4) if prompt else 0.0,
        "cost": round(_cost(row, prices), 6),
    }


def summary(days: int = 30) -> dict:
    days = max(1, min(365, int(days or 30)))
    start = datetime.combine(date.today() - timedelta(days=days - 1), clock.min).timestamp()
    prices = pricing()
    with _lock, storage._conn() as conn:
        rows = conn.execute(
            "SELECT ts, model, mode, input_tokens, cache_read_tokens, "
            "cache_creation_tokens, output_tokens FROM usage_events WHERE ts >= ? "
            "ORDER BY ts",
            (int(start),),
        ).fetchall()
    daily: dict[str, dict] = {}
    models: dict[tuple[str, str], dict] = {}
    totals = _blank()
    for raw in rows:
        row = {
            "input": raw["input_tokens"],
            "cache_read": raw["cache_read_tokens"],
            "cache_creation": raw["cache_creation_tokens"],
            "output": raw["output_tokens"],
        }
        _merge(totals, row)
        key = datetime.fromtimestamp(raw["ts"]).date().isoformat()
        bucket = daily.setdefault(key, {**_blank(), "date": key})
        _merge(bucket, row)
        model_key = (raw["model"] or "—", raw["mode"] or "")
        entry = models.setdefault(model_key, {**_blank(), "model": model_key[0], "mode": model_key[1]})
        _merge(entry, row)
    return {
        "days": days,
        "pricing": prices,
        "totals": _finish(totals, prices),
        "daily": [_finish(bucket, prices) for _, bucket in sorted(daily.items())],
        "models": sorted(
            (_finish(entry, prices) for entry in models.values()),
            key=lambda item: item["cost"],
            reverse=True,
        ),
    }
