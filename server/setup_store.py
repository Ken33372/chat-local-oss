"""首次运行向导写入的本地配置：data/config.json。

只保存自建后端的 provider 配置；不保存云端模式的浏览器 Key。
文件权限尽量设为 600；Windows 上 chmod 仅作尽力而为。
"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

CONFIG_NAME = "config.json"

LLM_FIELDS = ("base_url", "api_key", "model", "context_limit", "max_output_tokens")
PROVIDER_BLOCKS = {
    "search": ("provider", "base_url", "api_key", "results"),
    "asr": ("provider", "base_url", "api_key", "model"),
    "ocr": ("provider", "base_url", "api_key", "model"),
    # 重排只在搜索走 SearXNG 时起作用，配置项与其他自建后端同构
    "rerank": ("provider", "base_url", "api_key", "model"),
    # 朗读多两个字段：音色名与返回容器（wav/mp3/opus/pcm）
    "tts": ("provider", "base_url", "api_key", "model", "voice", "response_format"),
}


def config_path(data_dir: Path) -> Path:
    return data_dir / CONFIG_NAME


def load(data_dir: Path) -> dict:
    path = config_path(data_dir)
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return body if isinstance(body, dict) else {}


def _text(value: object, limit: int = 500) -> str:
    return str(value).strip()[:limit] if value is not None else ""


def normalize(body: dict, previous: dict | None = None) -> dict:
    """校验并只保留已知字段；api_key 为 null 时沿用旧值，空字符串表示清空。"""
    previous = previous or {}
    result: dict = {}
    llm = body.get("llm") if isinstance(body.get("llm"), dict) else {}
    old_llm = previous.get("llm") if isinstance(previous.get("llm"), dict) else {}
    base = _text(llm.get("base_url")).rstrip("/")
    if base and not base.startswith(("http://", "https://")):
        raise ValueError("LLM_BASE_URL 必须以 http:// 或 https:// 开头")
    context_limit = _int(llm.get("context_limit"), old_llm.get("context_limit"), 131072)
    max_output = _int(llm.get("max_output_tokens"), old_llm.get("max_output_tokens"), 8192)
    if context_limit < 1024:
        raise ValueError("上下文上限至少 1024 tokens")
    if max_output < 128 or max_output > context_limit:
        raise ValueError("最大输出需在 128 到上下文上限之间")
    result["llm"] = {
        "base_url": base,
        "model": _text(llm.get("model"), 200),
        "api_key": _key(llm.get("api_key"), old_llm.get("api_key")),
        "context_limit": context_limit,
        "max_output_tokens": max_output,
    }
    for name, fields in PROVIDER_BLOCKS.items():
        block = body.get(name) if isinstance(body.get(name), dict) else {}
        old = previous.get(name) if isinstance(previous.get(name), dict) else {}
        provider = _text(block.get("provider"), 32).lower() or "none"
        base_value = _text(block.get("base_url")).rstrip("/")
        if base_value and not base_value.startswith(("http://", "https://")):
            raise ValueError(f"{name.upper()}_BASE_URL 必须以 http:// 或 https:// 开头")
        item = {
            "provider": provider,
            "base_url": base_value,
            "api_key": _key(block.get("api_key"), old.get("api_key")),
        }
        if name == "search":
            results = block.get("results", 6)
            try:
                item["results"] = max(1, min(10, int(results)))
            except (TypeError, ValueError):
                item["results"] = 6
        else:
            item["model"] = _text(block.get("model"), 200)
        if name == "tts":
            item["voice"] = _text(block.get("voice"), 100)
            audio_format = _text(block.get("response_format"), 20).lower() or "wav"
            if audio_format not in ("wav", "mp3", "opus", "pcm"):
                raise ValueError("朗读返回格式只能是 wav / mp3 / opus / pcm")
            item["response_format"] = audio_format
        result[name] = item
    return result


def _int(value: object, previous: object, default: int) -> int:
    candidate = value if value is not None else previous
    try:
        return int(candidate)
    except (TypeError, ValueError):
        return default


def _key(value: object, previous: object) -> str:
    if value is None:
        return _text(previous, 500)
    return _text(value, 500)


def save(data_dir: Path, body: dict) -> dict:
    data_dir.mkdir(parents=True, exist_ok=True)
    previous = load(data_dir)
    normalized = normalize(body, previous)
    path = config_path(data_dir)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return normalized


def clear(data_dir: Path) -> None:
    config_path(data_dir).unlink(missing_ok=True)
