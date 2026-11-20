"""附件 OCR：图片与文档分开选服务，两套凭据各存各的。

图片：vision（交给主模型）/ openai（OpenAI 兼容视觉）/ deepseek（DeepSeek OCR）
文档：python（本地文本抽取，不经过这里）/ deepseek
"""
from __future__ import annotations

import base64
import mimetypes
from pathlib import Path

import config
from providers.common import ProviderError, api_url, client, detail

IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"}
DEEPSEEK_DEFAULT = "https://api.deepseek.com"


def _deepseek_base() -> str:
    return (config.OCR_DEEPSEEK_BASE_URL or DEEPSEEK_DEFAULT).rstrip("/")


def openai_available() -> bool:
    return bool(config.OCR_OPENAI_BASE_URL)


def deepseek_available() -> bool:
    return bool(config.OCR_DEEPSEEK_BASE_URL)


def available() -> bool:
    return openai_available() or deepseek_available()


def _deepseek(filename: str, data: bytes) -> str:
    headers = (
        {"Authorization": f"Bearer {config.OCR_DEEPSEEK_API_KEY}"}
        if config.OCR_DEEPSEEK_API_KEY
        else {}
    )
    with client(240) as http:
        response = http.post(
            api_url(_deepseek_base(), "/v1/tools/ocr"),
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
        raise ProviderError("OpenAI 兼容 OCR 只支持图片；文档请用 Python 解析或 DeepSeek OCR")
    mime = mimetypes.guess_type(filename or "")[0] or "image/png"
    data_url = f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
    headers = {"Content-Type": "application/json"}
    if config.OCR_OPENAI_API_KEY:
        headers["Authorization"] = f"Bearer {config.OCR_OPENAI_API_KEY}"
    payload = {
        "model": config.OCR_OPENAI_MODEL,
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
            api_url(config.OCR_OPENAI_BASE_URL, "/v1/chat/completions"),
            json=payload,
            headers=headers,
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


def ocr_image(filename: str, data: bytes) -> str:
    mode = config.IMAGE_PARSER
    if mode == "openai":
        if not openai_available():
            raise ProviderError("图片解析选了 OpenAI 兼容 OCR，但没填地址")
        return _openai(filename, data)
    if mode == "deepseek":
        if not deepseek_available():
            raise ProviderError("图片解析选了 DeepSeek OCR，但没填地址或 Key")
        return _deepseek(filename, data)
    raise ProviderError("图片解析方式是跟随模型，不应该走 OCR")


def ocr_document(filename: str, data: bytes) -> str:
    if config.DOC_PARSER != "deepseek":
        raise ProviderError("文档解析方式不是 DeepSeek OCR")
    if not deepseek_available():
        raise ProviderError("文档解析选了 DeepSeek OCR，但没填地址或 Key")
    return _deepseek(filename, data)


def _any_image(filename: str, data: bytes) -> str:
    """显式调用 OCR 接口时（主模型视觉不可用的回退），按已配置的服务挑一个。"""
    if openai_available():
        return _openai(filename, data)
    if deepseek_available():
        return _deepseek(filename, data)
    raise ProviderError("没有可用的 OCR 服务")


def ocr(filename: str, data: bytes) -> str:
    ext = Path(filename or "").suffix.lower().lstrip(".")
    if ext in IMAGE_EXT:
        return _any_image(filename, data)
    return ocr_document(filename, data)


def health() -> dict:
    return {
        "ok": available(),
        "provider": config.IMAGE_PARSER,
        "image": config.IMAGE_PARSER,
        "document": config.DOC_PARSER,
        "openai": {
            "configured": openai_available(),
            "base_url": config.OCR_OPENAI_BASE_URL,
            "has_key": bool(config.OCR_OPENAI_API_KEY),
            "model": config.OCR_OPENAI_MODEL,
        },
        "deepseek": {
            "configured": deepseek_available(),
            "base_url": config.OCR_DEEPSEEK_BASE_URL,
            "has_key": bool(config.OCR_DEEPSEEK_API_KEY),
            "model": config.OCR_DEEPSEEK_MODEL,
        },
    }
