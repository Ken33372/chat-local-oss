"""记忆向量化：OpenAI 兼容 /v1/embeddings。

只用于记忆的高级检索；未配置时记忆退回本地关键词打分。
路由与重排一致：填服务根地址自动接 /v1/embeddings，填完整地址就原样请求。
"""
from __future__ import annotations

import config
from providers.common import ProviderError, api_url, client, detail

_BATCH = 32


def configured() -> bool:
    return config.EMBEDDING_PROVIDER != "none" and bool(config.EMBEDDING_BASE_URL)


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {config.EMBEDDING_API_KEY}"} if config.EMBEDDING_API_KEY else {}


def embed(texts: list[str], timeout: float = 30) -> list[list[float]]:
    """按输入顺序返回向量；服务端若乱序给出 index，这里重新排好。"""
    cleaned = [str(text or "").strip() or "（空）" for text in texts]
    if not cleaned:
        return []
    payload = {"model": config.EMBEDDING_MODEL, "input": cleaned}
    with client(timeout) as http:
        response = http.post(
            api_url(config.EMBEDDING_BASE_URL, "/v1/embeddings"), json=payload, headers=_auth()
        )
    if response.status_code != 200:
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
    return [ordered[position] for position in range(len(cleaned))]


def embed_batched(texts: list[str], timeout: float = 60) -> list[list[float]]:
    result: list[list[float]] = []
    for start in range(0, len(texts), _BATCH):
        result.extend(embed(texts[start : start + _BATCH], timeout=timeout))
    return result
