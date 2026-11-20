"""搜索候选重排：用户自配的 OpenAI 兼容 /v1/rerank 接口。

可接的实现：llama-server --reranking、HuggingFace text-embeddings-inference、
任何返回 {"results":[{"index":n,"relevance_score":x}]} 或顶层数组
[{"index":n,"score":x}]（HuggingFace TEI 的形状）的服务。
路由各异：填服务根地址时自动接 /v1/rerank，填完整地址（TEI 的 /rerank）就原样请求。
没配 RERANK_BASE_URL 时重排关闭，搜索只取一页——聚合来的候选没人排序，
全塞给模型只会挤占上下文，所以"更多搜索数据"这件事必须以重排为前提。
"""
from __future__ import annotations

import logging
import time

import config
from providers.common import ProviderError, api_url, client, detail

_log = logging.getLogger("rerank")

_PROBE_TTL = 60.0
_probe: dict = {"at": 0.0, "ok": False, "detail": "未探测"}


def configured() -> bool:
    return config.RERANK_PROVIDER != "none" and bool(config.RERANK_BASE_URL)


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {config.RERANK_API_KEY}"} if config.RERANK_API_KEY else {}


def _request(query: str, documents: list[str], timeout: float) -> object:
    payload = {"model": config.RERANK_MODEL, "query": query, "documents": documents}
    with client(timeout) as http:
        response = http.post(
            api_url(config.RERANK_BASE_URL, "/v1/rerank"), json=payload, headers=_auth()
        )
    if response.status_code != 200:
        raise ProviderError(
            f"重排接口返回 {response.status_code}：{detail(response)}"
        )
    return response.json()


def _entries(body: object) -> list:
    """两种形状都认：Cohere / llama-server 的 {"results": [...]}，
    以及 HuggingFace TEI 直接返回的顶层数组 [{index, score}]；有些网关再套一层 data。"""
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for key in ("results", "data"):
            items = body.get(key)
            if isinstance(items, list):
                return items
    return []


def _remember(ok: bool, note: str) -> None:
    _probe.update({"at": time.monotonic(), "ok": bool(ok), "detail": str(note)[:200]})


def ready(force: bool = False) -> tuple[bool, str]:
    """搜索前决定要不要翻页聚合；结果缓存 60 秒，免得每次搜索都探一遍。"""
    if not configured():
        return False, "未配置重排接口（RERANK_BASE_URL）"
    if not force and time.monotonic() - _probe["at"] < _PROBE_TTL:
        return bool(_probe["ok"]), str(_probe["detail"])
    try:
        body = _request("重排可用性探测", ["第一条候选文本。", "第二条候选文本。"], 8)
        entries = _entries(body)
        _remember(bool(entries), f"{len(entries)} 段")
    except Exception as error:
        _remember(False, f"{type(error).__name__}: {error}")
    return bool(_probe["ok"]), str(_probe["detail"])


def rerank(query: str, documents: list[str]) -> list[int]:
    """返回按相关性排好的原下标，最好的在前；调用失败由上层兜底原序。"""
    # 先剔空串再发：接口一般会跳过空文档，直接透传会让下标对不上
    pairs = [(index, str(doc).strip()) for index, doc in enumerate(documents)]
    pairs = [(index, doc) for index, doc in pairs if doc]
    if len(pairs) < 2:
        return list(range(len(documents)))
    started = time.perf_counter()
    body = _request(query, [doc for _, doc in pairs], config.RERANK_TIMEOUT)
    scored: list[tuple[float, int]] = []
    for item in _entries(body):
        if not isinstance(item, dict):
            continue
        position = item.get("index")
        # 标准 /v1/rerank 的 index 是从 0 开始的文档下标（tei、Cohere、llama-server 都是）
        if not isinstance(position, int) or not 0 <= position < len(pairs):
            continue
        score = item.get("relevance_score", item.get("score"))
        scored.append(
            (float(score) if isinstance(score, (int, float)) else float("-inf"), pairs[position][0])
        )
    scored.sort(key=lambda entry: entry[0], reverse=True)
    order = [index for _, index in scored]
    seen = set(order)
    order.extend(index for index, _ in pairs if index not in seen)
    order.extend(index for index, doc in enumerate(documents) if not doc)
    _log.info("rerank %d docs ms=%d", len(pairs), round((time.perf_counter() - started) * 1000))
    return order


def status() -> dict:
    return {
        "configured": configured(),
        "provider": config.RERANK_PROVIDER,
        "base_url": config.RERANK_BASE_URL,
        "model": config.RERANK_MODEL,
        "has_key": bool(config.RERANK_API_KEY),
        "ok": bool(_probe["ok"]) if configured() else False,
        "detail": "未探测" if not _probe["at"] else str(_probe["detail"]),
        "probed": _probe["at"] > 0,
    }


def note_failure(reason: str) -> None:
    """重排真调用失败时记一笔，缓存期内不再翻页聚合。"""
    _remember(False, reason)
