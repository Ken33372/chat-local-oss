"""运行配置：环境变量 / .env 优先，其次是首次运行向导写入的 data/config.json。

本地/自建后端按能力分别配置：
- LLM：Anthropic 兼容（DeepSeek 的 /anthropic 端点等）或 OpenAI 兼容（Ollama、vLLM、各家云服务）
- ASR / OCR：DeepSeek 工具接口或 OpenAI 兼容接口，未配置即关闭
- 搜索：Tavily / AnySearch / SearXNG，未配置即关闭

只填 DEEPSEEK_API_KEY 时，自动把 LLM、ASR、OCR 指向 DeepSeek；
搜索不会自动开启，云端模式的联网搜索由 DeepSeek 服务端完成，本地模式需要单独配置。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import setup_store

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_env(path: Path) -> None:
    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip().strip('"').strip("'")


_load_env(Path(os.getenv("CHAT_LOCAL_ENV", BASE_DIR / ".env")))


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _int_env(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


DATA_DIR = Path(_env("CHAT_LOCAL_DATA", str(BASE_DIR / "data")))
WEB_DIST = Path(_env("CHAT_LOCAL_WEB", str(BASE_DIR / "web" / "dist")))

HOST = _env("CHAT_LOCAL_HOST", "127.0.0.1")
PORT = _int_env("CHAT_LOCAL_PORT", 17865)

MAX_TOOL_ROUNDS = _int_env("CHAT_LOCAL_MAX_TOOL_ROUNDS", 5)
MAX_TOOL_RESULT_CHARS = _int_env("CHAT_LOCAL_MAX_TOOL_RESULT_CHARS", 12000)
MAX_IMAGE_BYTES = _int_env("CHAT_LOCAL_MAX_IMAGE_BYTES", 20 * 1024 * 1024)
IMAGE_MODE = _env("CHAT_LOCAL_IMAGE_MODE", "vision").lower()
DEFAULT_SYSTEM = "该助手由用户自行配置的模型提供。"

_saved: dict = {}


def _pick(name: str, file_value: object, default: str = "") -> str:
    """环境变量优先；空字符串视为未设置。"""
    env = os.getenv(name)
    if env is not None and env.strip():
        return env.strip()
    if file_value is not None and str(file_value).strip():
        return str(file_value).strip()
    return default


def _block(name: str) -> dict:
    value = _saved.get(name)
    return value if isinstance(value, dict) else {}


def _domains(name: str, file_value: object) -> list[str]:
    """站点规则：环境变量是逗号串，config.json 里可以是数组，两种都收。"""
    raw = file_value if isinstance(file_value, (list, tuple)) else _env(name).replace("\n", ",")
    return [str(item).strip().lower() for item in raw if str(item).strip()]


def _headers(name: str, file_value: object) -> dict[str, str]:
    """额外请求头：环境变量是 JSON 串，config.json 里是对象；只留干净的键值对。"""
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        raw = file_value
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "{}")
        except ValueError:
            return {}
    if not isinstance(raw, dict):
        return {}
    result: dict[str, str] = {}
    for key, value in list(raw.items())[:32]:
        key = str(key).replace("\r", "").replace("\n", "").strip()
        value = str(value).replace("\r", "").replace("\n", "").strip()
        if key and value and ":" not in key:
            result[key] = value
    return result


def _default_base(provider: str, key: str) -> str:
    if provider == "deepseek" or (key and provider == "none"):
        return "https://api.deepseek.com"
    if provider == "openai":
        return "https://api.openai.com"
    return ""


def _compute() -> dict:
    deepseek_key = _env("DEEPSEEK_API_KEY")
    llm = _block("llm")
    search = _block("search")
    asr = _block("asr")
    ocr = _block("ocr")

    llm_provider = _pick("LLM_PROVIDER", llm.get("provider"), "anthropic").lower()
    if llm_provider in ("openai-compatible", "openai_compatible", "openai兼容"):
        llm_provider = "openai"
    if llm_provider not in ("anthropic", "openai"):
        llm_provider = "anthropic"
    if deepseek_key:
        llm_default_base = (
            "https://api.deepseek.com" if llm_provider == "openai" else "https://api.deepseek.com/anthropic"
        )
    else:
        llm_default_base = ""
    llm_base = _pick("LLM_BASE_URL", llm.get("base_url"), llm_default_base).rstrip("/")
    llm_key = _pick("LLM_API_KEY", llm.get("api_key"), deepseek_key)
    llm_model = _pick(
        "LLM_MODEL", llm.get("model"), "deepseek-flash" if deepseek_key else ""
    )
    llm_headers = _headers("LLM_HEADERS", llm.get("headers"))
    try:
        context_limit = int(_pick("LLM_CONTEXT_LIMIT", llm.get("context_limit"), "131072"))
    except ValueError:
        context_limit = 131072
    try:
        max_output = int(
            _pick("LLM_MAX_OUTPUT_TOKENS", llm.get("max_output_tokens"), "8192")
        )
    except ValueError:
        max_output = 8192

    asr_provider = _pick(
        "ASR_PROVIDER", asr.get("provider"), "deepseek" if deepseek_key else "none"
    ).lower()
    asr_base = _pick(
        "ASR_BASE_URL", asr.get("base_url"), _default_base(asr_provider, deepseek_key)
    ).rstrip("/")
    asr_key = _pick(
        "ASR_API_KEY", asr.get("api_key"), deepseek_key if asr_provider == "deepseek" else ""
    )
    asr_model = _pick("ASR_MODEL", asr.get("model"), "whisper-1")

    ocr_provider = _pick(
        "OCR_PROVIDER", ocr.get("provider"), "deepseek" if deepseek_key else "none"
    ).lower()
    ocr_base = _pick(
        "OCR_BASE_URL", ocr.get("base_url"), _default_base(ocr_provider, deepseek_key)
    ).rstrip("/")
    ocr_key = _pick(
        "OCR_API_KEY", ocr.get("api_key"), deepseek_key if ocr_provider == "deepseek" else ""
    )
    ocr_model = _pick("OCR_MODEL", ocr.get("model"), "gpt-4o-mini")

    # 朗读：仅自建后端使用；云端模式的朗读走 DeepSeek 官方工具接口，不看这几项
    tts = _block("tts")
    tts_provider = _pick("TTS_PROVIDER", tts.get("provider"), "none").lower()
    tts_base = _pick(
        "TTS_BASE_URL", tts.get("base_url"), _default_base(tts_provider, deepseek_key)
    ).rstrip("/")
    tts_key = _pick(
        "TTS_API_KEY", tts.get("api_key"), deepseek_key if tts_provider == "deepseek" else ""
    )
    tts_model = _pick("TTS_MODEL", tts.get("model"), "tts-1")
    tts_voice = _pick("TTS_VOICE", tts.get("voice"), "")
    tts_format = _pick("TTS_RESPONSE_FORMAT", tts.get("response_format"), "wav").lower()
    tts_max_chars = _int_env("TTS_MAX_CHARS", 4000)
    # template 模式：URL、请求体 JSON 模板、取音方式都可自定义，只能写在 .env 里
    tts_template_url = _env("TTS_TEMPLATE_URL").rstrip("/")
    tts_template_body = _env("TTS_TEMPLATE_BODY")
    tts_template_audio = _env("TTS_TEMPLATE_AUDIO") or "body"
    tts_template_headers = _env("TTS_TEMPLATE_HEADERS")

    try:
        search_results = int(_pick("SEARCH_RESULTS", search.get("results"), "6") or 6)
    except ValueError:
        search_results = 6

    # 重排：只有配了接口，SearXNG 这一路才翻页聚合候选（见 providers/rerank.py）
    rerank = _block("rerank")
    rerank_provider = _pick("RERANK_PROVIDER", rerank.get("provider"), "none").lower()
    rerank_base = _pick("RERANK_BASE_URL", rerank.get("base_url"), "").rstrip("/")
    rerank_key = _pick("RERANK_API_KEY", rerank.get("api_key"), "")
    rerank_model = _pick("RERANK_MODEL", rerank.get("model"), "")
    try:
        rerank_timeout = float(_env("RERANK_TIMEOUT", "20"))
    except ValueError:
        rerank_timeout = 20.0

    return {
        "DEEPSEEK_API_KEY": deepseek_key,
        "LLM_PROVIDER": llm_provider,
        "LLM_BASE_URL": llm_base,
        "LLM_API_KEY": llm_key,
        "LLM_MODEL": llm_model,
        "LLM_HEADERS": llm_headers,
        "LLM_CONTEXT_LIMIT": context_limit,
        "LLM_MAX_OUTPUT_TOKENS": max_output,
        "ASR_PROVIDER": asr_provider,
        "ASR_BASE_URL": asr_base,
        "ASR_API_KEY": asr_key,
        "ASR_MODEL": asr_model,
        "OCR_PROVIDER": ocr_provider,
        "OCR_BASE_URL": ocr_base,
        "OCR_API_KEY": ocr_key,
        "OCR_MODEL": ocr_model,
        "TTS_PROVIDER": tts_provider,
        "TTS_BASE_URL": tts_base,
        "TTS_API_KEY": tts_key,
        "TTS_MODEL": tts_model,
        "TTS_VOICE": tts_voice,
        "TTS_RESPONSE_FORMAT": tts_format,
        "TTS_MAX_CHARS": tts_max_chars,
        "TTS_TEMPLATE_URL": tts_template_url,
        "TTS_TEMPLATE_BODY": tts_template_body,
        "TTS_TEMPLATE_AUDIO": tts_template_audio,
        "TTS_TEMPLATE_HEADERS": tts_template_headers,
        "SEARCH_PROVIDER": _pick("SEARCH_PROVIDER", search.get("provider"), "none").lower(),
        "SEARCH_BASE_URL": _pick("SEARCH_BASE_URL", search.get("base_url"), "").rstrip("/"),
        "SEARCH_API_KEY": _pick("SEARCH_API_KEY", search.get("api_key"), ""),
        "SEARCH_RESULTS": search_results,
        # 站点规则与候选聚合参数：环境变量或 config.json 均可，向导界面不暴露
        "SEARCH_ALLOWED_DOMAINS": _domains(
            "SEARCH_ALLOWED_DOMAINS", search.get("allowed_domains")
        ),
        "SEARCH_BLOCKED_DOMAINS": _domains(
            "SEARCH_BLOCKED_DOMAINS", search.get("blocked_domains")
        ),
        "SEARCH_CANDIDATE_TARGET": _int_env("SEARCH_CANDIDATE_TARGET", 20),
        "SEARCH_CANDIDATE_MAX": _int_env("SEARCH_CANDIDATE_MAX", 60),
        "SEARCH_MAX_PAGES": _int_env("SEARCH_MAX_PAGES", 5),
        "SEARCH_SNIPPET_CHARS": _int_env("SEARCH_SNIPPET_CHARS", 500),
        "RERANK_PROVIDER": rerank_provider,
        "RERANK_BASE_URL": rerank_base,
        "RERANK_API_KEY": rerank_key,
        "RERANK_MODEL": rerank_model,
        "RERANK_TIMEOUT": rerank_timeout,
    }


def reload() -> None:
    """向导保存后热加载；端口、数据目录等启动参数不变。"""
    global _saved
    _saved = setup_store.load(DATA_DIR)
    globals().update(_compute())


_saved = setup_store.load(DATA_DIR)
globals().update(_compute())


def capabilities() -> dict:
    search_ready = (
        SEARCH_PROVIDER == "anysearch"
        or (SEARCH_PROVIDER == "tavily" and bool(SEARCH_API_KEY))
        or (SEARCH_PROVIDER == "searxng" and bool(SEARCH_BASE_URL))
    )
    return {
        "llm": bool(LLM_BASE_URL and LLM_MODEL),
        "search": search_ready,
        "asr": ASR_PROVIDER in ("deepseek", "openai") and bool(ASR_BASE_URL),
        "ocr": OCR_PROVIDER in ("deepseek", "openai") and bool(OCR_BASE_URL),
        "tts": (TTS_PROVIDER in ("deepseek", "openai", "engine") and bool(TTS_BASE_URL))
        or (TTS_PROVIDER == "template" and bool(TTS_TEMPLATE_URL or TTS_BASE_URL)),
    }
