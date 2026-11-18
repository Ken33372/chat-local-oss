from __future__ import annotations

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
