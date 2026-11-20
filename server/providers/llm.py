"""LLM 上游协议适配：Anthropic 兼容（/v1/messages）与 OpenAI 兼容（/v1/chat/completions）。

上层（server/ai.py）始终按 Anthropic 事件流处理；OpenAI 上游的请求在这里改写、
流式响应在这里翻译成同样的事件，工具调用、引用、思考块等逻辑两条路共用一套。

OpenAI 兼容覆盖：OpenAI、DeepSeek、Ollama、LM Studio、vLLM、llama.cpp 及各类网关。
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import AsyncGenerator

import httpx

import config
from providers.common import api_url, detail

ZERO_USAGE = {
    "input_tokens": 0,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "output_tokens": 0,
}

_OPENAI_ALIASES = {"openai", "openai-compatible", "openai_compatible", "openai兼容"}


class LLMError(RuntimeError):
    pass


def normalize_provider(value: object) -> str:
    text = str(value or "").strip().lower()
    return "openai" if text in _OPENAI_ALIASES else "anthropic"


def provider() -> str:
    return normalize_provider(getattr(config, "LLM_PROVIDER", "anthropic"))


_PLACEHOLDER = re.compile(r"\{(\w+)\}")


def _fill(template: str, values: dict[str, str]) -> str:
    """占位符只替换一次，避免正文里的 {key} 之类被二次替换。"""
    return _PLACEHOLDER.sub(lambda match: values.get(match.group(1), match.group(0)), template)


def _first_user_text(messages: object) -> str:
    for message in messages or []:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            text = "".join(
                str(block.get("text") or "")
                for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            )
            if text:
                return text
    return ""


def session_id(explicit: str, messages: object = None) -> str:
    """会话 ID：优先用前端传来的；没有就按第一条用户消息派生，同一对话保持稳定。

    统一成 ses_ 前缀，兼容要求形如 ses_... 的路由/缓存优化。"""
    token = re.sub(r"[^A-Za-z0-9_-]", "", str(explicit or ""))[:128]
    if not token:
        text = _first_user_text(messages).strip()
        if text:
            token = hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]
    if not token:
        return ""
    return token if token.startswith("ses_") else f"ses_{token}"


def headers(
    prov: str,
    key: str = "",
    extra: dict | None = None,
    context: dict | None = None,
) -> dict[str, str]:
    if prov == "openai":
        result = {"Content-Type": "application/json"}
        if key:
            result["Authorization"] = f"Bearer {key}"
    else:
        result = {"anthropic-version": "2023-06-01", "Content-Type": "application/json"}
        if key:
            result["x-api-key"] = key
    values = {
        "key": key,
        "session": str((context or {}).get("session") or ""),
        "model": str((context or {}).get("model") or ""),
    }
    for name, value in (extra or {}).items():
        # 自定义头最后合并：既是补充（api-key、x-api-version），也能覆盖上面的默认头
        filled = _fill(str(value), values)
        # 占位符没值（例如探测请求没有会话）就不发这个头，避免把 "{session}" 原样送出去
        if _PLACEHOLDER.search(filled):
            continue
        result[str(name)] = filled
    return result


def messages_url(base: str, prov: str) -> str:
    if prov == "openai":
        return api_url(base, "/v1/chat/completions")
    # Anthropic 保持原样：DeepSeek 的端点是 base(/anthropic) + /v1/messages
    return f"{base.rstrip('/')}/v1/messages"


def models_url(base: str, prov: str) -> str:
    if prov == "openai":
        return api_url(base, "/v1/models")
    return f"{base.rstrip('/')}/v1/models"


def _blocks_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        str(block.get("text") or "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    )


def _image_part(block: dict) -> dict | None:
    source = block.get("source") or {}
    if source.get("type") != "base64":
        return None
    mime = source.get("media_type") or "image/png"
    data = source.get("data") or ""
    if not data:
        return None
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}}


def to_openai(payload: dict) -> dict:
    """Anthropic 请求体 → OpenAI chat/completions 请求体。"""
    messages: list[dict] = []

    system = payload.get("system")
    if isinstance(system, str) and system.strip():
        messages.append({"role": "system", "content": system})
    elif isinstance(system, list):
        text = _blocks_text(system).strip()
        if text:
            messages.append({"role": "system", "content": text})

    for message in payload.get("messages") or []:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        if role == "assistant":
            text = _blocks_text(content)
            calls = [
                block
                for block in (content if isinstance(content, list) else [])
                if isinstance(block, dict) and block.get("type") == "tool_use"
            ]
            item: dict = {"role": "assistant", "content": text or None}
            if calls:
                item["tool_calls"] = [
                    {
                        "id": call.get("id") or "tool_call",
                        "type": "function",
                        "function": {
                            "name": call.get("name") or "",
                            "arguments": json.dumps(call.get("input") or {}, ensure_ascii=False),
                        },
                    }
                    for call in calls
                ]
            messages.append(item)
            continue
        if role != "user":
            continue

        if isinstance(content, str):
            if content:
                messages.append({"role": "user", "content": content})
            continue
        if not isinstance(content, list):
            continue

        parts: list[dict] = []
        has_image = False
        for block in content:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "tool_result":
                # 工具结果在 OpenAI 协议里是独立的 tool 消息，必须紧跟在带 tool_calls 的助手消息后
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": block.get("tool_use_id") or "tool_call",
                        "content": _blocks_text(block.get("content")) or "（空结果）",
                    }
                )
                continue
            if kind == "text":
                parts.append({"type": "text", "text": str(block.get("text") or "")})
            elif kind == "image":
                image = _image_part(block)
                if image:
                    parts.append(image)
                    has_image = True
        if not parts:
            continue
        if has_image:
            messages.append({"role": "user", "content": parts})
        else:
            text = "\n".join(part["text"] for part in parts if part["text"])
            if text:
                messages.append({"role": "user", "content": text})

    body: dict = {"model": payload.get("model") or "", "messages": messages}
    if payload.get("max_tokens") is not None:
        body["max_tokens"] = int(payload["max_tokens"])
    if payload.get("temperature") is not None:
        body["temperature"] = float(payload["temperature"])
    tools = payload.get("tools") or []
    if tools:
        body["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": tool.get("name") or "",
                    "description": tool.get("description") or "",
                    "parameters": tool.get("input_schema") or {"type": "object", "properties": {}},
                },
            }
            for tool in tools
            if isinstance(tool, dict)
        ]
    body["stream"] = bool(payload.get("stream"))
    if body["stream"]:
        # 不要求服务端返回用量（部分自建服务不认 stream_options），有就收
        body["stream_options"] = {"include_usage": True}
    return body


def _start_event() -> dict:
    return {
        "type": "message_start",
        "message": {"usage": dict(ZERO_USAGE)},
    }


def _block_start(index: int, block: dict) -> dict:
    return {"type": "content_block_start", "index": index, "content_block": block}


def _delta(index: int, delta: dict) -> dict:
    return {"type": "content_block_delta", "index": index, "delta": delta}


def _block_stop(index: int) -> dict:
    return {"type": "content_block_stop", "index": index}


def _map_usage(usage: object) -> dict:
    if not isinstance(usage, dict):
        return dict(ZERO_USAGE)
    cached = 0
    details = usage.get("prompt_tokens_details")
    if isinstance(details, dict):
        try:
            cached = int(details.get("cached_tokens") or 0)
        except (TypeError, ValueError):
            cached = 0
    try:
        return {
            "input_tokens": int(usage.get("prompt_tokens") or 0),
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": cached,
            "output_tokens": int(usage.get("completion_tokens") or 0),
        }
    except (TypeError, ValueError):
        return dict(ZERO_USAGE)


def _stop_reason(finish: object) -> str:
    if finish in ("tool_calls", "function_call"):
        return "tool_use"
    if finish in ("length", "max_tokens"):
        return "max_tokens"
    return "end_turn"


def _finish_events(finish: object, usage: object) -> list[dict]:
    return [
        {
            "type": "message_delta",
            "delta": {"stop_reason": _stop_reason(finish), "stop_sequence": None},
            "usage": _map_usage(usage),
        },
        {"type": "message_stop"},
    ]


class _BlockBuilder:
    """按出现顺序分配 Anthropic 内容块下标，保证块与下标严格对应。"""

    def __init__(self) -> None:
        self.index = -1
        self.kind: str | None = None
        self.tools: dict[int, int] = {}

    def close(self) -> dict | None:
        if self.kind is None:
            return None
        event = _block_stop(self.index)
        self.kind = None
        self.index += 1
        return event


def _json_events(data: dict) -> list[dict]:
    """服务端不认 stream 时（直接回 JSON），按同样的事件形状补一条完整回复。"""
    choices = data.get("choices") or []
    choice = choices[0] if choices and isinstance(choices[0], dict) else {}
    message = choice.get("message") or {}
    events: list[dict] = []
    index = 0
    reasoning = message.get("reasoning_content") or message.get("reasoning")
    if isinstance(reasoning, str) and reasoning:
        events.append(_block_start(index, {"type": "thinking", "thinking": ""}))
        events.append(_delta(index, {"type": "thinking_delta", "thinking": reasoning}))
        events.append(_block_stop(index))
        index += 1
    text = message.get("content")
    if isinstance(text, str) and text:
        events.append(_block_start(index, {"type": "text", "text": ""}))
        events.append(_delta(index, {"type": "text_delta", "text": text}))
        events.append(_block_stop(index))
        index += 1
    for number, call in enumerate(message.get("tool_calls") or []):
        function = call.get("function") or {}
        events.append(
            _block_start(
                index,
                {
                    "type": "tool_use",
                    "id": call.get("id") or f"toolu_{number}",
                    "name": function.get("name") or "",
                    "input": {},
                },
            )
        )
        arguments = function.get("arguments")
        if isinstance(arguments, dict):
            arguments = json.dumps(arguments, ensure_ascii=False)
        if isinstance(arguments, str) and arguments:
            events.append(_delta(index, {"type": "input_json_delta", "partial_json": arguments}))
        events.append(_block_stop(index))
        index += 1
    events.extend(_finish_events(choice.get("finish_reason"), data.get("usage")))
    return events


async def _stream_openai(payload: dict, context: dict) -> AsyncGenerator[dict, None]:
    url = messages_url(config.LLM_BASE_URL, "openai")
    body = to_openai(payload)
    async with httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(None, connect=15)) as client:
        async with client.stream(
            "POST", url, json=body, headers=headers("openai", config.LLM_API_KEY, config.LLM_HEADERS, context)
        ) as response:
            if response.status_code != 200:
                raw = (await response.aread()).decode("utf-8", errors="replace")
                # 个别自建服务不认 stream_options，去掉后重试一次
                if response.status_code == 400 and "stream_options" in raw:
                    body.pop("stream_options", None)
                    async with client.stream(
                        "POST", url, json=body, headers=headers("openai", config.LLM_API_KEY, config.LLM_HEADERS, context)
                    ) as retry:
                        if retry.status_code != 200:
                            text = (await retry.aread()).decode("utf-8", errors="replace")
                            raise LLMError(f"模型接口返回 {retry.status_code}：{text[:400]}")
                        async for event in _read_openai_stream(retry):
                            yield event
                    return
                raise LLMError(f"模型接口返回 {response.status_code}：{raw[:400]}")
            async for event in _read_openai_stream(response):
                yield event


async def _read_openai_stream(response: httpx.Response) -> AsyncGenerator[dict, None]:
    yield _start_event()
    if "text/event-stream" not in (response.headers.get("content-type") or "").lower():
        raw = (await response.aread()).decode("utf-8", errors="replace")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            raise LLMError(f"模型接口返回了无法解析的内容：{raw[:300]}")
        for event in _json_events(data if isinstance(data, dict) else {}):
            yield event
        return

    blocks = _BlockBuilder()
    usage: object = None
    finish: object = None
    async for line in response.aiter_lines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue
        if not isinstance(chunk, dict):
            continue
        if chunk.get("error"):
            error = chunk["error"]
            text = error.get("message") if isinstance(error, dict) else error
            raise LLMError(str(text or error))
        if chunk.get("usage"):
            usage = chunk["usage"]
        for choice in chunk.get("choices") or []:
            if not isinstance(choice, dict):
                continue
            delta = choice.get("delta") or {}
            reasoning = delta.get("reasoning_content") or delta.get("reasoning")
            if isinstance(reasoning, str) and reasoning and blocks.kind != "text":
                if blocks.kind != "thinking":
                    closed = blocks.close()
                    if closed is not None:
                        yield closed
                    blocks.kind = "thinking"
                    yield _block_start(blocks.index, {"type": "thinking", "thinking": ""})
                yield _delta(blocks.index, {"type": "thinking_delta", "thinking": reasoning})
            text = delta.get("content")
            if isinstance(text, str) and text:
                if blocks.kind == "thinking":
                    closed = blocks.close()
                    if closed is not None:
                        yield closed
                if blocks.kind is None:
                    blocks.kind = "text"
                    yield _block_start(blocks.index, {"type": "text", "text": ""})
                yield _delta(blocks.index, {"type": "text_delta", "text": text})
            for number, call in enumerate(delta.get("tool_calls") or []):
                if not isinstance(call, dict):
                    continue
                key = call.get("index")
                if not isinstance(key, int):
                    key = number
                function = call.get("function") or {}
                if key not in blocks.tools:
                    closed = blocks.close()
                    if closed is not None:
                        yield closed
                    blocks.tools[key] = blocks.index
                    yield _block_start(
                        blocks.index,
                        {
                            "type": "tool_use",
                            "id": call.get("id") or f"toolu_{key}",
                            "name": function.get("name") or "",
                            "input": {},
                        },
                    )
                    blocks.index += 1
                target = blocks.tools[key]
                arguments = function.get("arguments")
                if isinstance(arguments, dict):
                    arguments = json.dumps(arguments, ensure_ascii=False)
                if isinstance(arguments, str) and arguments:
                    yield _delta(target, {"type": "input_json_delta", "partial_json": arguments})
            if choice.get("finish_reason"):
                finish = choice["finish_reason"]

    closed = blocks.close()
    if closed is not None:
        yield closed
    for key in sorted(blocks.tools):
        yield _block_stop(blocks.tools[key])
    for event in _finish_events(finish, usage):
        yield event


async def _stream_anthropic(payload: dict, context: dict) -> AsyncGenerator[dict, None]:
    url = messages_url(config.LLM_BASE_URL, "anthropic")
    async with httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(None, connect=15)) as client:
        async with client.stream(
            "POST", url, json=payload, headers=headers("anthropic", config.LLM_API_KEY, config.LLM_HEADERS, context)
        ) as response:
            if response.status_code != 200:
                raw = (await response.aread()).decode("utf-8", errors="replace")
                raise LLMError(f"模型接口返回 {response.status_code}：{raw[:400]}")
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                try:
                    event = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
                kind = event.get("type")
                if kind in ("ping", None):
                    continue
                if kind == "error":
                    raise LLMError(str((event.get("error") or {}).get("message") or event))
                yield event
                if kind == "message_stop":
                    return


async def stream(payload: dict, session: str = "") -> AsyncGenerator[dict, None]:
    context = {
        "model": str(payload.get("model") or ""),
        "session": session_id(session, payload.get("messages")),
    }
    if provider() == "openai":
        async for event in _stream_openai(payload, context):
            yield event
    else:
        async for event in _stream_anthropic(payload, context):
            yield event


async def complete(
    system: str,
    user: str,
    max_tokens: int,
    temperature: float | None = None,
    timeout: float = 60,
    session: str = "",
) -> str:
    """非流式一次性调用（生成标题、压缩摘要）。"""
    prov = provider()
    if prov == "openai":
        body: dict = {
            "model": config.LLM_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": max_tokens,
            "stream": False,
        }
        if temperature is not None:
            body["temperature"] = temperature
    else:
        body = {
            "model": config.LLM_MODEL,
            "system": system,
            "messages": [{"role": "user", "content": user}],
            "thinking": {"type": "disabled"},
            "max_tokens": max_tokens,
            "stream": False,
        }
        if temperature is not None:
            body["temperature"] = temperature
    async with httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(timeout, connect=15)) as client:
        response = await client.post(
            messages_url(config.LLM_BASE_URL, prov), json=body, headers=headers(prov, config.LLM_API_KEY, config.LLM_HEADERS, {"model": config.LLM_MODEL, "session": session_id(session)})
        )
    if response.status_code != 200:
        raise LLMError(f"模型接口返回 {response.status_code}：{response.text[:400]}")
    data = response.json()
    if prov == "openai":
        choices = data.get("choices") or []
        message = (choices[0] or {}).get("message") if choices and isinstance(choices[0], dict) else {}
        return str((message or {}).get("content") or "").strip()
    return "".join(
        block.get("text", "")
        for block in data.get("content") or []
        if isinstance(block, dict) and block.get("type") == "text"
    ).strip()


async def probe(base: str, key: str = "", prov: str = "anthropic", extra: dict | None = None) -> dict:
    """探测 Base URL 是否可用，并尽量列出模型。"""
    prov = normalize_provider(prov)
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(8, connect=5)) as client:
            response = await client.get(models_url(base, prov), headers=headers(prov, key, extra, {"model": ""}))
        models = []
        if response.status_code == 200:
            payload = response.json()
            models = [item.get("id") for item in payload.get("data") or [] if item.get("id")]
        return {
            "ok": response.status_code < 500,
            "status": response.status_code,
            "models": models,
            "detail": "" if response.status_code < 500 else response.text[:300],
        }
    except Exception as error:
        return {"ok": False, "status": 0, "models": [], "detail": str(error)}
