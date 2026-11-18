"""语音识别：DeepSeek /v1/tools/asr 或 OpenAI 兼容 /v1/audio/transcriptions。"""
from __future__ import annotations

import re

import config
from providers.common import ProviderError, client, detail, endpoint

DEFAULT_BASE = {"deepseek": "https://api.deepseek.com", "openai": "https://api.openai.com"}
_ASR_PREFIX = re.compile(r"^\s*language\s+[^<>]*<asr_text>\s*", re.IGNORECASE)


def _base() -> str:
    return config.ASR_BASE_URL or DEFAULT_BASE.get(config.ASR_PROVIDER, "")


def available() -> bool:
    return config.ASR_PROVIDER in DEFAULT_BASE and bool(_base())


def transcribe(filename: str, data: bytes) -> str:
    if not available():
        raise ProviderError("未配置 ASR（ASR_PROVIDER）")
    headers = (
        {"Authorization": f"Bearer {config.ASR_API_KEY}"} if config.ASR_API_KEY else {}
    )
    files = {"file": (filename or "recording.wav", data, "audio/wav")}
    if config.ASR_PROVIDER == "deepseek":
        url = endpoint(_base(), "/v1/tools/asr")
        payload = None
    else:
        url = endpoint(_base(), "/v1/audio/transcriptions")
        payload = {"model": config.ASR_MODEL}
    with client(300) as http:
        response = http.post(url, files=files, data=payload, headers=headers)
    if response.status_code != 200:
        raise ProviderError(f"ASR 返回 {response.status_code}：{detail(response)}")
    body = response.json()
    text = body.get("text") if isinstance(body, dict) else None
    if not isinstance(text, str):
        raise ProviderError("ASR 响应缺少 text")
    return _ASR_PREFIX.sub("", text).strip()


def health() -> dict:
    return {"ok": available(), "provider": config.ASR_PROVIDER}
