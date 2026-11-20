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
    # 重排只在搜索走 SearXNG 时起作用，配置项与其他自建后端同构
    "rerank": ("provider", "base_url", "api_key", "model"),
    # 朗读多两个字段：音色名与返回容器（wav/mp3/opus/pcm）
    "tts": ("provider", "base_url", "api_key", "model", "voice", "response_format"),
    # 向量：只支持 OpenAI 兼容；dim 由用户按模型填，服务返回的维度会与它校验
    "embedding": ("provider", "base_url", "api_key", "model", "dim"),
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
    provider = _text(llm.get("provider"), 32).lower() or _text(old_llm.get("provider"), 32).lower() or "anthropic"
    if provider in ("openai-compatible", "openai_compatible", "openai兼容"):
        provider = "openai"
    if provider not in ("anthropic", "openai"):
        raise ValueError("LLM 协议只能是 anthropic（Anthropic 兼容）或 openai（OpenAI 兼容）")
    context_limit = _int(llm.get("context_limit"), old_llm.get("context_limit"), 131072)
    max_output = _int(llm.get("max_output_tokens"), old_llm.get("max_output_tokens"), 8192)
    if context_limit < 1024:
        raise ValueError("上下文上限至少 1024 tokens")
    if max_output < 128 or max_output > context_limit:
        raise ValueError("最大输出需在 128 到上下文上限之间")
    result["llm"] = {
        "provider": provider,
        "base_url": base,
        "model": _text(llm.get("model"), 200),
        "api_key": _key(llm.get("api_key"), old_llm.get("api_key")),
        "headers": _header_map(llm.get("headers"), old_llm.get("headers")),
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
                item["results"] = max(1, min(12, int(results)))
            except (TypeError, ValueError):
                item["results"] = 6
        else:
            item["model"] = _text(block.get("model"), 200)
        if name == "embedding":
            dim = _int(block.get("dim"), old.get("dim"), 0)
            if dim < 0 or dim > 16384:
                raise ValueError("向量维度需在 0 到 16384 之间（0 表示未填）")
            item["dim"] = dim
        if name == "tts":
            item["voice"] = _text(block.get("voice"), 100)
            audio_format = _text(block.get("response_format"), 20).lower() or "wav"
            if audio_format not in ("wav", "mp3", "opus", "pcm"):
                raise ValueError("朗读返回格式只能是 wav / mp3 / opus / pcm")
            item["response_format"] = audio_format
        result[name] = item
    # 记忆只影响本地/自建后端；向导不传这个分块时沿用旧值，避免一次保存把开关清掉
    memory = body.get("memory") if isinstance(body.get("memory"), dict) else {}
    old_memory = previous.get("memory") if isinstance(previous.get("memory"), dict) else {}
    inject_mode = (
        _text(memory.get("inject_mode"), 16).lower()
        or _text(old_memory.get("inject_mode"), 16).lower()
        or _text(memory.get("inject"), 16).lower()
        or _text(old_memory.get("inject"), 16).lower()
        or "recent"
    )
    if inject_mode not in ("off", "recent", "keyword", "embedding"):
        raise ValueError("记忆注入模式只能是 off / recent / keyword / embedding")
    search_mode = (
        _text(memory.get("search_mode"), 16).lower()
        or _text(old_memory.get("search_mode"), 16).lower()
        or "score"
    )
    if search_mode not in ("keyword", "score", "embedding"):
        raise ValueError("记忆检索模式只能是 keyword / score / embedding")
    write = _text(memory.get("write"), 16).lower() or _text(old_memory.get("write"), 16).lower() or "propose"
    if write not in ("propose", "off"):
        raise ValueError("记忆写入方式只能是 propose（提议待确认）或 off")
    count = _int(memory.get("inject_count"), old_memory.get("inject_count"), 5)
    result["memory"] = {
        "enabled": _bool(memory.get("enabled"), old_memory.get("enabled"), False),
        "inject": "off" if inject_mode == "off" else "recent",
        "inject_mode": inject_mode,
        "search_mode": search_mode,
        "inject_count": max(1, min(10, count)),
        "tools": _bool(memory.get("tools"), old_memory.get("tools"), True),
        "write": write,
    }
    # 附件解析：图片/文档各选一种方式；OpenAI 兼容与 DeepSeek 两套凭据分开存
    parsing = body.get("parsing") if isinstance(body.get("parsing"), dict) else {}
    old_parsing = previous.get("parsing") if isinstance(previous.get("parsing"), dict) else {}
    legacy_old = previous.get("ocr") if isinstance(previous.get("ocr"), dict) else {}
    legacy_body = body.get("ocr") if isinstance(body.get("ocr"), dict) else {}
    legacy_provider = (
        _text(legacy_body.get("provider"), 32).lower()
        or _text(legacy_old.get("provider"), 32).lower()
    )
    image_mode = (
        _text(parsing.get("image"), 16).lower() or _text(old_parsing.get("image"), 16).lower()
    )
    if not image_mode:
        # 旧配置默认图片跟随模型；要 OCR 需在新界面明确选择
        image_mode = "vision" 
    if image_mode not in ("vision", "openai", "deepseek"):
        raise ValueError("图片解析方式只能是 vision / openai / deepseek")
    doc_mode = (
        _text(parsing.get("document"), 16).lower()
        or _text(old_parsing.get("document"), 16).lower()
    )
    if not doc_mode:
        doc_mode = "deepseek" if legacy_provider == "deepseek" else "python"
    if doc_mode not in ("python", "deepseek"):
        raise ValueError("文档解析方式只能是 python / deepseek")
    result["parsing"] = {"image": image_mode, "document": doc_mode}
    for name, provider_name in (("ocr_openai", "openai"), ("ocr_deepseek", "deepseek")):
        supplied = body.get(name) if isinstance(body.get(name), dict) else {}
        old = previous.get(name) if isinstance(previous.get(name), dict) else {}
        source = supplied or old
        if not source:
            if legacy_body and _text(legacy_body.get("provider"), 32).lower() == provider_name:
                source = legacy_body
            elif _text(legacy_old.get("provider"), 32).lower() == provider_name:
                source = legacy_old
        base_value = _text(source.get("base_url")).rstrip("/")
        if base_value and not base_value.startswith(("http://", "https://")):
            raise ValueError(f"{name.upper()}_BASE_URL 必须以 http:// 或 https:// 开头")
        result[name] = {
            "base_url": base_value,
            "api_key": _key(supplied.get("api_key") if supplied else None, source.get("api_key")),
            "model": _text(source.get("model"), 200),
        }
    return result


def _bool(value: object, previous: object, default: bool) -> bool:
    candidate = value if value is not None else previous
    if isinstance(candidate, bool):
        return candidate
    if candidate is None or not str(candidate).strip():
        return default
    return str(candidate).strip().lower() in ("1", "true", "yes", "on")


def _int(value: object, previous: object, default: int) -> int:
    candidate = value if value is not None else previous
    try:
        return int(candidate)
    except (TypeError, ValueError):
        return default


def _header_map(value: object, previous: object) -> dict[str, str]:
    """额外请求头：前端传 JSON 串或对象；空白沿用旧值，{} 表示清空。"""
    old = previous if isinstance(previous, dict) else None
    if value is None:
        return {str(k): str(v) for k, v in (old or {}).items()}
    if isinstance(value, dict):
        raw = value
    else:
        text = _text(value, 8000)
        if not text:
            return {str(k): str(v) for k, v in (old or {}).items()}
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as error:
            raise ValueError(f"额外请求头不是合法 JSON：{error}")
    if not isinstance(raw, dict):
        raise ValueError('额外请求头必须是 JSON 对象，例如 {"api-key": "xxx"}')
    if len(raw) > 32:
        raise ValueError("额外请求头最多 32 项")
    result: dict[str, str] = {}
    for name, item in raw.items():
        name = str(name).strip()
        item = str(item).strip()
        if not name or ":" in name:
            raise ValueError(f"请求头名称不合法：{name}")
        if len(name) > 100 or len(item) > 2000:
            raise ValueError(f"请求头 {name} 过长")
        if any(char in name + item for char in "\r\n"):
            raise ValueError(f"请求头 {name} 不能包含换行")
        result[name] = item
    return result


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
