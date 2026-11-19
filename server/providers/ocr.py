"""OCR：DeepSeek /v1/tools/ocr（文档与图片）或 OpenAI 兼容视觉接口（仅图片）。"""
from __future__ import annotations

import base64
import mimetypes
from pathlib import Path

import config
from providers.common import ProviderError, api_url, client, detail

DEFAULT_BASE = {"deepseek": "https://api.deepseek.com", "openai": "https://api.openai.com"}
IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"}


def _base() -> str:
    return config.OCR_BASE_URL or DEFAULT_BASE.get(config.OCR_PROVIDER, "")


def available() -> bool:
    return config.OCR_PROVIDER in DEFAULT_BASE and bool(_base())


def _deepseek(filename: str, data: bytes) -> str:
    headers = (
        {"Authorization": f"Bearer {config.OCR_API_KEY}"} if config.OCR_API_KEY else {}
    )
    with client(240) as http:
        response = http.post(
            api_url(_base(), "/v1/tools/ocr"),
            files={"file": (filename or "upload", data, "application/octet-stream")},
            data={"purpose": "text_recognition"},
            headers=headers,
        )
    if response.status_code != 200:
        raise ProviderError(f"OCR 返回 {response.status_code}：{detail(response)}")
    body = response.json()
    if isinstance(body, dict) and body.get("error"):
        raise ProviderError(f"OCR 失败：{detail(response)}")
    pages = body.get("pages") if isinstance(body, dict) else None
    if not isinstance(pages, list):
        raise ProviderError("OCR 响应缺少 pages")
    return "\n\n".join(
        str(page.get("text") or "").strip()
        for page in pages
        if isinstance(page, dict)
    ).strip()


def _openai(filename: str, data: bytes) -> str:
    ext = Path(filename or "").suffix.lower().lstrip(".")
    if ext not in IMAGE_EXT:
        raise ProviderError("OpenAI 兼容 OCR 只支持图片；文档请改用 DeepSeek OCR")
    mime = mimetypes.guess_type(filename or "")[0] or "image/png"
    data_url = f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
    headers = {
        "Authorization": f"Bearer {config.OCR_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": config.OCR_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "提取图片中的全部文字，只输出文字，不要解释。"},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    }
    with client(180) as http:
        response = http.post(
            api_url(_base(), "/v1/chat/completions"), json=payload, headers=headers
        )
    if response.status_code != 200:
        raise ProviderError(f"OCR 返回 {response.status_code}：{detail(response)}")
    body = response.json()
    try:
        content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ProviderError("OCR 响应格式不正确")
    if isinstance(content, list):
        content = "".join(
            str(item.get("text") or "")
            for item in content
            if isinstance(item, dict)
        )
    return str(content).strip()


def ocr(filename: str, data: bytes) -> str:
    if not available():
        raise ProviderError("未配置 OCR（OCR_PROVIDER）")
    if config.OCR_PROVIDER == "deepseek":
        return _deepseek(filename, data)
    return _openai(filename, data)


def health() -> dict:
    return {"ok": available(), "provider": config.OCR_PROVIDER}
