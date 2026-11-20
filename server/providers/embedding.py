"""记忆向量化：OpenAI 兼容 /v1/embeddings。

只用于记忆的高级检索；未配置时记忆退回本地关键词打分。
路由与重排一致：填服务根地址自动接 /v1/embeddings，填完整地址就原样请求。
"""
from __future__ import annotations

import logging
import time

import config
from providers.common import ProviderError, api_url, client, detail

_log = logging.getLogger("embedding")
_BATCH = 32


def configured() -> bool:
    return config.EMBEDDING_PROVIDER != "none" and bool(config.EMBEDDING_BASE_URL)


def health() -> dict:
    """界面显示用：只报配置，不发请求；连通性交给调试面板的探针。"""
    return {
        "configured": configured(),
        "provider": config.EMBEDDING_PROVIDER,
        "base": config.EMBEDDING_BASE_URL,
        "model": config.EMBEDDING_MODEL,
        "dim": config.EMBEDDING_DIM,
        "has_key": bool(config.EMBEDDING_API_KEY),
    }


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {config.EMBEDDING_API_KEY}"} if config.EMBEDDING_API_KEY else {}


def embed(texts: list[str], timeout: float = 30) -> list[list[float]]:
    """按输入顺序返回向量；服务端若乱序给出 index，这里重新排好。"""
    cleaned = [str(text or "").strip() or "（空）" for text in texts]
    if not cleaned:
        return []
    started = time.perf_counter()
    payload = {"model": config.EMBEDDING_MODEL, "input": cleaned}
    with client(timeout) as http:
        response = http.post(
            api_url(config.EMBEDDING_BASE_URL, "/v1/embeddings"), json=payload, headers=_auth()
        )
    if response.status_code != 200:
        _log.warning("embedding http %s", response.status_code)
        raise ProviderError(f"向量接口返回 {response.status_code}：{detail(response)}")
    body = response.json()
    items = body.get("data") if isinstance(body, dict) else None
    if not isinstance(items, list) or len(items) != len(cleaned):
        raise ProviderError("向量接口返回的数量与输入不一致")
    ordered: dict[int, list[float]] = {}
    for position, item in enumerate(items):
        if not isinstance(item, dict) or not isinstance(item.get("embedding"), list):
            raise ProviderError("向量接口返回格式不符合 OpenAI 兼容约定")
        index = item.get("index", position)
        ordered[int(index) if isinstance(index, int) else position] = [
            float(value) for value in item["embedding"]
        ]
    if sorted(ordered) != list(range(len(cleaned))):
        ordered = {position: item["embedding"] for position, item in enumerate(items)}
    result = [ordered[position] for position in range(len(cleaned))]
    _log.info("embedding %d texts dim=%d ms=%d", len(cleaned), len(result[0]), round((time.perf_counter() - started) * 1000))
    return result


def embed_batched(texts: list[str], timeout: float = 60) -> list[list[float]]:
    result: list[list[float]] = []
    for start in range(0, len(texts), _BATCH):
        result.extend(embed(texts[start : start + _BATCH], timeout=timeout))
    return result
