"""调试面板：内存日志、服务状态与主动探针。

日志只留在进程内环形缓冲里（默认 800 行），重启即清空；不写盘、不外传。
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from datetime import datetime
from threading import Lock

import config
import memory
from providers import asr as asr_provider
from providers import embedding as embedding_provider
from providers import llm as llm_provider
from providers import ocr as ocr_provider
from providers import rerank as rerank_provider
from providers import search
from providers import tts as tts_provider

MAX_LINES = 800
_started = time.monotonic()
_lines: deque[dict] = deque(maxlen=MAX_LINES)
_lock = Lock()
_seq = 0


class _RingHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        global _seq
        try:
            # 面板自己的轮询也会走 access log，记进来会迅速挤掉真实日志
            if record.name == "uvicorn.access" and "/api/debug/" in str(record.args):
                return
            text = record.getMessage()
            if record.exc_info:
                text += "\n" + logging.Formatter().formatException(record.exc_info)
            with _lock:
                _seq += 1
                _lines.append(
                    {
                        "seq": _seq,
                        "ts": datetime.now().strftime("%H:%M:%S"),
                        "level": record.levelname,
                        "name": record.name,
                        "text": text[:2000],
                    }
                )
        except Exception:
            pass


def install() -> None:
    """挂到根与 uvicorn 的 logger 上；重复调用不会叠加。"""
    # uvicorn.error 会向 uvicorn 传播，只挂父级，避免同一行记两遍
    for name in ("", "uvicorn", "uvicorn.access"):
        logger = logging.getLogger(name)
        if any(getattr(item, "_chat_local_ring", False) for item in logger.handlers):
            continue
        handler = _RingHandler()
        handler.setLevel(logging.INFO)
        handler._chat_local_ring = True  # type: ignore[attr-defined]
        logger.addHandler(handler)
        if logger.level == logging.NOTSET or logger.level > logging.INFO:
            logger.setLevel(logging.INFO)


def logs(after: int = 0, limit: int = 300) -> dict:
    limit = max(1, min(MAX_LINES, int(limit)))
    with _lock:
        items = [item for item in _lines if item["seq"] > int(after)]
        last = _lines[-1]["seq"] if _lines else 0
    return {"lines": items[-limit:], "last": last}


def status() -> dict:
    caps = config.capabilities()
    return {
        "app": {
            "uptime": round(time.monotonic() - _started, 1),
            "data_dir": str(config.DATA_DIR),
            "context_limit": config.LLM_CONTEXT_LIMIT,
            "output_limit": config.LLM_MAX_OUTPUT_TOKENS,
            "capabilities": caps,
        },
        "llm": {
            "configured": bool(config.LLM_BASE_URL and config.LLM_MODEL),
            "provider": llm_provider.provider(),
            "base": config.LLM_BASE_URL,
            "model": config.LLM_MODEL,
        },
        "embedding": embedding_provider.health(),
        "rerank": rerank_provider.status(),
        "search": search.status(),
        "memory": memory.stats(),
        "asr": asr_provider.health(),
        "ocr": ocr_provider.health(),
        "tts": tts_provider.health(),
    }


async def probe(target: str) -> dict:
    started = time.perf_counter()
    ok = False
    state = ""
    detail = ""
    extra: dict = {}
    try:
        if target == "llm":
            info = await llm_provider.probe(
                config.LLM_BASE_URL,
                config.LLM_API_KEY,
                llm_provider.provider(),
                config.LLM_HEADERS,
            )
            ok = bool(info.get("ok"))
            models = [str(name) for name in info.get("models") or []]
            extra["models"] = models[:10]
            detail = (
                f"HTTP {info.get('status')}，{len(models)} 个模型"
                if models
                else f"HTTP {info.get('status')}，未返回模型列表"
            )
        elif target == "embedding":
            if not embedding_provider.configured():
                detail = "未配置 EMBEDDING_BASE_URL"
            else:
                vectors = await asyncio.to_thread(
                    embedding_provider.embed, ["调试面板探针：向量接口连通性"]
                )
                dim = len(vectors[0]) if vectors else 0
                extra["dim"] = dim
                expected = int(config.EMBEDDING_DIM or 0)
                ok = dim > 0 and (expected <= 0 or dim == expected)
                detail = f"返回 {dim} 维"
                if expected > 0 and dim != expected:
                    detail += f"，与配置的 {expected} 维不一致（记忆检索会回退本地打分）"
        elif target == "rerank":
            if not rerank_provider.configured():
                detail = "未配置 RERANK_BASE_URL"
            else:
                ok, note = await asyncio.to_thread(rerank_provider.ready, True)
                detail = note
        elif target == "search":
            if not config.SEARCH_PROVIDER or config.SEARCH_PROVIDER == "none":
                detail = "未配置搜索服务"
            elif config.SEARCH_PROVIDER == "searxng":
                result = await asyncio.to_thread(search.probe_query)
                ok = True
                extra["results"] = result["count"]
                detail = f"SearXNG 单页真实查询，返回 {result['count']} 条"
                info = await asyncio.to_thread(search.health)
                rerank = info.get("rerank") or {}
                if rerank.get("configured"):
                    detail += f"；重排 {'正常' if rerank.get('ok') else '异常'}（{rerank.get('detail')}）"
            else:
                info = await asyncio.to_thread(search.health)
                ok = bool(info.get("ok"))
                detail = f"{info.get('provider') or 'none'} 已配置"
                rerank = info.get("rerank") or {}
                if rerank.get("configured"):
                    detail += f"；重排 {'正常' if rerank.get('ok') else '异常'}（{rerank.get('detail')}）"
        elif target == "asr":
            result = await asyncio.wait_for(asyncio.to_thread(asr_provider.probe), 60)
            ok = bool(result.get("ok"))
            state = str(result.get("state") or "")
            detail = str(result.get("detail") or "")
            if result.get("text"):
                extra["text"] = result["text"]
        elif target == "tts":
            result = await asyncio.wait_for(asyncio.to_thread(tts_provider.probe), 90)
            ok = bool(result.get("ok"))
            state = str(result.get("state") or "")
            detail = str(result.get("detail") or "")
            if result.get("bytes"):
                extra["bytes"] = result["bytes"]
                extra["mime"] = result.get("mime")
        elif target == "memory":
            mode = config.MEMORY_SEARCH_MODE
            text, ids = await asyncio.to_thread(memory.search, "调试面板探针", set(), mode)
            ok = True
            extra["hits"] = len(ids)
            extra["mode"] = mode
            detail = f"{mode} 模式，命中 {len(ids)} 条"
            if memory.LAST_ERROR:
                detail += f"；上次错误：{memory.LAST_ERROR}"
            if not text:
                detail += "；没有命中属于正常（库里可能没有相关条目）"
        else:
            detail = f"未知探针：{target}"
    except Exception as error:
        ok = False
        detail = f"{type(error).__name__}: {error}"
        if type(error).__name__.startswith(("Connect", "ReadTimeout", "Timeout")):
            state = "warn"
    return {
        "target": target,
        "ok": ok,
        "state": state or ("ok" if ok else "error"),
        "ms": round((time.perf_counter() - started) * 1000),
        "detail": detail,
        "extra": extra,
    }
