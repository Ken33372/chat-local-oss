"""语音识别：DeepSeek /v1/tools/asr 或 OpenAI 兼容 /v1/audio/transcriptions。

请求走标准 multipart（字段 file + model），whisper.cpp 与多数 fork 都认这个形状；
响应各家不同，{text} / [{text}] / {results|segments:[{text}]} / 纯文本都解。
"""
from __future__ import annotations

import re

import config
from providers.common import ProviderError, api_url, client, detail

DEFAULT_BASE = {"deepseek": "https://api.deepseek.com", "openai": "https://api.openai.com"}
_ASR_PREFIX = re.compile(r"^\s*language\s+[^<>]*<asr_text>\s*", re.IGNORECASE)


def _base() -> str:
    return config.ASR_BASE_URL or DEFAULT_BASE.get(config.ASR_PROVIDER, "")


def available() -> bool:
    return config.ASR_PROVIDER in DEFAULT_BASE and bool(_base())


def _payload_text(body: object) -> str:
    """各家返回形状不一样：{text}、{transcript}、{results/segments:[{text}]}、[{text}]、纯文本。"""

    def joined(items: list) -> str:
        return "".join(str(item.get("text") or "") for item in items if isinstance(item, dict))

    if isinstance(body, str):
        return body
    if isinstance(body, list):
        return joined(body)
    if isinstance(body, dict):
        for key in ("text", "transcript"):
            value = body.get(key)
            if isinstance(value, str) and value.strip():
                return value
        for key in ("results", "segments", "data"):
            value = body.get(key)
            if isinstance(value, list):
                text = joined(value)
                if text.strip():
                    return text
            elif isinstance(value, dict):
                text = _payload_text(value)
                if text.strip():
                    return text
    return ""


def transcribe(filename: str, data: bytes) -> str:
    if not available():
        raise ProviderError("未配置 ASR（ASR_PROVIDER）")
    headers = (
        {"Authorization": f"Bearer {config.ASR_API_KEY}"} if config.ASR_API_KEY else {}
    )
    files = {"file": (filename or "recording.wav", data, "audio/wav")}
    if config.ASR_PROVIDER == "deepseek":
        url = api_url(_base(), "/v1/tools/asr")
        payload = None
    else:
        url = api_url(_base(), "/v1/audio/transcriptions")
        payload = {"model": config.ASR_MODEL}
    with client(300) as http:
        response = http.post(url, files=files, data=payload, headers=headers)
    if response.status_code != 200:
        raise ProviderError(f"ASR 返回 {response.status_code}：{detail(response)}")
    try:
        body: object = response.json()
    except ValueError:
        body = response.text
    text = _payload_text(body).strip()
    if not text:
        raise ProviderError("ASR 响应里找不到文本（试过 text / results / segments）")
    return _ASR_PREFIX.sub("", text).strip()


def health() -> dict:
    return {"ok": available(), "provider": config.ASR_PROVIDER}
