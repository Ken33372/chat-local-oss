"""语音朗读（仅自建后端）：四种接口形状 + 一个通用模板，覆盖常见自建 TTS 服务。

音频推理服务没有统一协议，能对齐的只有两件事：输入是"一段文字"，输出是"一段能播的音频"。
所以这里按请求形状分四档，实测遇到新形状就加一档，而不是让用户去改服务：
- openai：{model, input, voice, response_format} → /v1/audio/speech。
  llama.cpp / audio.cpp / vLLM / TGI / Kokoro-FastAPI 以及大多数套壳 fork 都抄这个形状。
- deepseek：官方 /v1/tools/tts，{text, voice_id, format, filter_markdown}，返回 24 kHz 裸 PCM。
- engine：用 engine 字段选模型的那一类（模型控制台、部分自带 FastAPI 的推理服务），
  {engine, input, voice, response_format}，地址原样使用，不拼接标准路径。
- template：完全自定义。URL、请求体 JSON 模板、取音方式（响应体 / base64 字段 / 音频 URL）
  都由用户填，覆盖"自己用 FastAPI 包了一层"的任何服务。

音频容器一律按响应的 MIME 判断：DeepSeek 给裸 PCM（audio/L16，24 kHz），
其余通常给 wav/mp3/opus，采样率写在容器头里，不能假设。
正文先在本机清洗（剥代码块/表格/公式/引用角标），再按句切段：
各家对单次输入都有长度上限，一次塞整篇会直接报错，分段后可以逐段请求、逐段播放。
"""
from __future__ import annotations

import base64
import json
import re

import config
from providers.common import ProviderError, api_url, client, detail

DEFAULT_BASE = {"deepseek": "https://api.deepseek.com", "openai": "https://api.openai.com"}
PROVIDERS = ("deepseek", "openai", "engine", "template")
# 各家都认的名称只是几个示例，实际可填的音色由服务自己决定，本项目不做校验
KNOWN_VOICES = {
    "deepseek": ("stella", "tide"),
    "openai": ("alloy", "nova", "onyx"),
}


def _base() -> str:
    if config.TTS_PROVIDER == "template":
        return (config.TTS_TEMPLATE_URL or config.TTS_BASE_URL or "").rstrip("/")
    return (config.TTS_BASE_URL or DEFAULT_BASE.get(config.TTS_PROVIDER, "")).rstrip("/")


def available() -> bool:
    return config.TTS_PROVIDER in PROVIDERS and bool(_base())


def _url(path: str) -> str:
    """engine / template 的地址由用户填到接口级，原样请求；其余按 api_url 的规则补标准路径。"""
    return _base() if config.TTS_PROVIDER in ("engine", "template") else api_url(_base(), path)


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {config.TTS_API_KEY}"} if config.TTS_API_KEY else {}


def _post(
    url: str, payload: object, timeout: float, headers: dict | None = None
) -> tuple[bytes, str]:
    with client(timeout) as http:
        response = http.post(url, json=payload, headers=headers or _headers())
    if response.status_code != 200:
        raise ProviderError(f"TTS 返回 {response.status_code}：{detail(response)}")
    if not response.content:
        raise ProviderError("TTS 返回空音频")
    return response.content, _mime(response)


def _format_mime() -> str:
    return {"pcm": "audio/L16", "mp3": "audio/mpeg", "opus": "audio/opus"}.get(
        config.TTS_RESPONSE_FORMAT, "audio/wav"
    )


def _mime(response) -> str:
    given = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
    if given.startswith("audio/"):
        return given
    return _format_mime()


def _deepseek(text: str, voice: str) -> tuple[bytes, str]:
    payload = {
        "text": text,
        "voice_id": voice,
        "format": "pcm",
        # 服务端自带正文清洗，比本机规则更懂它自己的音色断句
        "filter_markdown": True,
    }
    audio, given = _post(_url("/v1/tools/tts"), payload, 180)
    return audio, "audio/L16" if given in ("", "audio/l16") else given


def _openai(text: str, voice: str) -> tuple[bytes, str]:
    payload = {
        "model": config.TTS_MODEL,
        "input": text,
        "voice": voice,
        "response_format": config.TTS_RESPONSE_FORMAT,
    }
    return _post(_url("/v1/audio/speech"), payload, 300)


def _engine(text: str, voice: str) -> tuple[bytes, str]:
    """用 engine 字段选模型的这一类服务：模型名就是引擎名，地址填到接口级。"""
    payload = {
        "engine": config.TTS_MODEL,
        "input": text,
        "voice": voice,
        "response_format": config.TTS_RESPONSE_FORMAT,
    }
    return _post(_url(""), payload, 300)


def _dig(body: object, path: str) -> object:
    node = body
    for part in path.split("."):
        if not part:
            continue
        if isinstance(node, list):
            try:
                node = node[int(part)]
            except (IndexError, ValueError):
                return None
        elif isinstance(node, dict):
            node = node.get(part)
        else:
            return None
    return node


def _fill(template: str, values: dict[str, str]) -> str:
    """按 JSON 字符串转义替换占位符，正文里的引号/换行不会把请求体弄坏。"""
    out = template
    for name, value in values.items():
        out = out.replace("{" + name + "}", json.dumps(value, ensure_ascii=False)[1:-1])
    return out


def _template(text: str, voice: str) -> tuple[bytes, str]:
    raw = config.TTS_TEMPLATE_BODY or (
        '{"input": "{text}", "voice": "{voice}", "response_format": "{format}"}'
    )
    filled = _fill(
        raw,
        {
            "text": text,
            "voice": voice,
            "model": config.TTS_MODEL,
            "format": config.TTS_RESPONSE_FORMAT,
        },
    )
    try:
        payload = json.loads(filled)
    except ValueError as error:
        raise ProviderError(f"TTS_TEMPLATE_BODY 不是合法 JSON：{error}")
    headers = _headers()
    if config.TTS_TEMPLATE_HEADERS:
        try:
            extra = json.loads(_fill(config.TTS_TEMPLATE_HEADERS, {"key": config.TTS_API_KEY}))
        except ValueError as error:
            raise ProviderError(f"TTS_TEMPLATE_HEADERS 不是合法 JSON：{error}")
        if isinstance(extra, dict):
            headers.update({str(key): str(value) for key, value in extra.items()})
    audio, mime = _post(_url(""), payload, 300, headers)
    pick = (config.TTS_TEMPLATE_AUDIO or "body").strip()
    kind, _, path = pick.partition(":")
    if kind not in ("body", "base64", "url"):
        raise ProviderError("TTS_TEMPLATE_AUDIO 只能是 body / base64:<字段路径> / url:<字段路径>")
    if kind == "base64":
        node = _dig(json.loads(audio.decode("utf-8", "replace")), path)
        if not isinstance(node, str) or not node:
            raise ProviderError(f"响应里找不到 base64 音频字段 {path}")
        return base64.b64decode(node), _format_mime()
    if kind == "url":
        node = _dig(json.loads(audio.decode("utf-8", "replace")), path)
        if not isinstance(node, str) or not node.startswith(("http://", "https://")):
            raise ProviderError(f"响应里找不到音频 URL 字段 {path}")
        with client(300) as http:
            got = http.get(node, headers=headers)
        if got.status_code != 200 or not got.content:
            raise ProviderError(f"下载音频失败：{got.status_code}")
        return got.content, _mime(got)
    return audio, mime


def synthesize(text: str, voice: str = "") -> tuple[bytes, str]:
    if not available():
        raise ProviderError("未配置朗读（TTS_PROVIDER）")
    if not text.strip():
        raise ProviderError("没有可朗读的内容")
    provider = config.TTS_PROVIDER
    use_voice = voice or config.TTS_VOICE or KNOWN_VOICES.get(provider, ("",))[0]
    if provider == "engine":
        if not use_voice:
            raise ProviderError("engine 接口需要填音色名（TTS_VOICE），常见的是服务音色库里的名字")
        return _engine(text, use_voice)
    if provider == "deepseek":
        return _deepseek(text, use_voice)
    if provider == "template":
        return _template(text, use_voice)
    return _openai(text, use_voice)


# ---------------- 正文清洗与分段 ----------------

_FENCE_RE = re.compile(r"(?:```|~~~)[^\n]*\n?.*?(?:```|~~~)", re.S)
_LATEX_BLOCK_RE = re.compile(r"\$\$.*?\$\$", re.S)
_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_CITE_RE = re.compile(r"<detail\b[^>]*>.*?</detail>|<n>\s*\d+\s*</n>|\[\d+\]", re.S)
_MATH_INLINE_RE = re.compile(r"\$[^$\n]{1,400}\$")
_TAG_RE = re.compile(r"</?(?:br|p|div|span|b|i|em|strong|u|s|sub|sup|code|pre)\s*/?>", re.I)
_INLINE_CODE_RE = re.compile(r"`([^`\n]{1,600})`")
# 强调标记：只吃掉成对出现的下划线，标识符里的 snake_case 要原样念
_EMPHASIS_RE = re.compile(r"\*{1,3}|~{2}|(?<!\w)_(?=\w)|(?<=\w)_(?!\w)")
_TABLE_SEP_RE = re.compile(r"^\s*\|?[\s:|-]+\|[\s:|-]*$")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+")
_BULLET_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
_QUOTE_RE = re.compile(r"^\s*>\s?")
_WS_RE = re.compile(r"[ \t]+")
_STASH_MARK_RE = re.compile(r"\x00(\d+)\x00")
_UNIT_RE = re.compile(r"[^。！？；!?;\n]+[。！？；!?;]?|\n+")
_SENTENCE_ENDS = "。！？；!?;\n"


def _strip_line(line: str) -> str:
    return _BULLET_RE.sub("", _QUOTE_RE.sub("", _HEADING_RE.sub("", line)))


def plain_text(text: str) -> str:
    """把助手正文压成适合朗读的纯文本：删代码块/表格行/公式/引用角标，链接与行内代码只留文字。"""
    body = _FENCE_RE.sub(" ", str(text or ""))
    body = _LATEX_BLOCK_RE.sub(" ", body)
    body = _IMAGE_RE.sub(" ", body)
    body = _LINK_RE.sub(r"\1", body)
    body = _CITE_RE.sub(" ", body)
    body = _MATH_INLINE_RE.sub(" ", body)
    body = _TAG_RE.sub(" ", body)
    stashed: list[str] = []

    def stash(match: re.Match) -> str:
        stashed.append(match.group(1).strip())
        return f"\x00{len(stashed) - 1}\x00"

    body = _INLINE_CODE_RE.sub(stash, body)
    kept: list[str] = []
    for line in body.splitlines():
        if _TABLE_SEP_RE.match(line) or line.strip().startswith("|"):
            continue
        kept.append(_EMPHASIS_RE.sub("", _strip_line(line)))
    body = _WS_RE.sub(" ", "\n".join(kept))
    body = re.sub(r"\n\s*\n+", "\n", body)
    body = _STASH_MARK_RE.sub(lambda match: stashed[int(match.group(1))], body)
    return body.strip()


def _hard_split(piece: str, limit: int) -> list[str]:
    """单句超过上限时按逗号/空格找断点，实在没有就硬切，保证每段都 ≤ limit。"""
    out: list[str] = []
    rest = piece.strip()
    while len(rest) > limit:
        window = rest[:limit]
        cut = max(window.rfind("，"), window.rfind(","), window.rfind(" "), window.rfind("、"))
        if cut < limit * 0.5:
            cut = limit
        out.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        out.append(rest)
    return out


def split_segments(text: str, limit: int | None = None) -> list[str]:
    """按句子边界装填，每段不超过 limit 字。"""
    ceiling = max(200, int(limit or config.TTS_MAX_CHARS))
    segments: list[str] = []
    current = ""
    for unit in _UNIT_RE.findall(text or ""):
        piece = (unit or "").strip()
        if not piece:
            continue
        if len(piece) > ceiling:
            if current:
                segments.append(current)
                current = ""
            segments.extend(_hard_split(piece, ceiling))
            continue
        joiner = "" if not current or current.endswith(tuple(_SENTENCE_ENDS)) else " "
        if current and len(current) + len(joiner) + len(piece) > ceiling:
            segments.append(current)
            current = piece
        else:
            current = f"{current}{joiner}{piece}"
    if current:
        segments.append(current)
    return [item for item in segments if item]


def plan(text: str) -> dict:
    plain = plain_text(text)
    return {
        "plain": plain,
        "segments": split_segments(plain),
        "max_chars": config.TTS_MAX_CHARS,
        "provider": config.TTS_PROVIDER,
        "voice": config.TTS_VOICE,
    }


def health() -> dict:
    return {"ok": available(), "provider": config.TTS_PROVIDER, "voice": config.TTS_VOICE}
