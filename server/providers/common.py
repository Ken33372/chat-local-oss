from __future__ import annotations

from urllib.parse import urlsplit

import httpx


class ProviderError(RuntimeError):
    pass


def client(timeout: float = 120) -> httpx.Client:
    return httpx.Client(trust_env=False, timeout=httpx.Timeout(timeout, connect=10))


def join(base: str, path: str) -> str:
    """拼接 base 与 /v1/... 路径；base 已带 /v1 时不重复。"""
    base = base.rstrip("/")
    if base.endswith("/v1") and path.startswith("/v1/"):
        path = path[3:]
    return base + path


def endpoint(base: str, path: str) -> str:
    """拼接接口地址；base 已经是完整接口时不再重复追加。"""
    base = base.rstrip("/")
    if base.endswith(path):
        return base
    return join(base, path)


def api_url(base: str, path: str) -> str:
    """各家的路由不统一：Base URL 只填到主机或 /v1 时才拼标准路径；
    已经带别的路径（如 /rerank、/api/tts/speech）就原样请求，不能逼用户改服务。"""
    base = (base or "").rstrip("/")
    tail = urlsplit(base).path.rstrip("/")
    return base if tail and tail != "/v1" else endpoint(base, path)


def detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except Exception:
        return response.text[:400]
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error)[:400]
        if error:
            return str(error)[:400]
        for key in ("message", "detail", "msg"):
            if body.get(key):
                return str(body[key])[:400]
    return str(body)[:400]
