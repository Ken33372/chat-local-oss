# Interface compatibility and configuration examples

The README covers "should I use it, how do I run it". This document holds the details: copy-paste configuration examples, and how the project talks to each kind of inference server.

## Configuration examples

Everything can go into the project's `.env`, or be written to `data/config.json` by the first-run wizard (environment variables win). Capabilities are independent: anything unconfigured simply has no UI entry.

**Minimum for each capability**

| Capability | Required | Optional (has a default) |
|---|---|---|
| Chat | `LLM_BASE_URL`, `LLM_MODEL` | `LLM_PROVIDER` (default `anthropic`; use `openai` for OpenAI-compatible), `LLM_API_KEY` (local servers may not need one), `LLM_CONTEXT_LIMIT`, `LLM_MAX_OUTPUT_TOKENS` |
| Search | `SEARCH_PROVIDER`; `SEARCH_BASE_URL` when using `searxng` | Base URL for Tavily / AnySearch, `SEARCH_RESULTS` (1–12, default 6) |
| Rerank | `RERANK_PROVIDER` **and** `RERANK_BASE_URL` — both | `RERANK_MODEL`, `RERANK_API_KEY`, `RERANK_TIMEOUT` |
| Voice input | `ASR_PROVIDER`, `ASR_BASE_URL` | `ASR_MODEL` (default `whisper-1`), `ASR_API_KEY` |
| OCR | `OCR_PROVIDER`, `OCR_BASE_URL` | `OCR_MODEL` (default `gpt-4o-mini`), `OCR_API_KEY` |
| Read-aloud | `TTS_PROVIDER`, `TTS_BASE_URL`; `TTS_VOICE` too when the provider is `engine` | `TTS_MODEL` (default `tts-1`), `TTS_RESPONSE_FORMAT`, `TTS_MAX_CHARS` |

Setting only `RERANK_BASE_URL` does **not** turn reranking on: `RERANK_PROVIDER` defaults to `none`, so both are required.

The embedding endpoint is used only by advanced memory retrieval, and **the dimension must be filled in and match the model**; a mismatch is reported and retrieval falls back to local scoring.

### Example 1: model only (smallest working setup)

```env
# The base URL stops before /v1 — the server appends /v1/messages itself
LLM_BASE_URL=http://127.0.0.1:8000
LLM_MODEL=qwen3
# local servers such as llama.cpp or Ollama usually ignore the key
LLM_API_KEY=
```

You get chat, thinking, history and context management. Search, voice, OCR and read-aloud have no UI entry.

The model endpoint can speak either protocol, selected with `LLM_PROVIDER`: the default `anthropic` posts to `/v1/messages` (for example DeepSeek's `/anthropic` endpoint); `openai` posts to `/v1/chat/completions`, so Ollama, LM Studio, vLLM, llama.cpp and hosted APIs connect directly without an extra gateway. See "The two LLM protocols" below.

### Example 2: everything local (model + search + voice + read-aloud)

```env
# ---- model ----
LLM_BASE_URL=http://127.0.0.1:8000
LLM_API_KEY=
LLM_MODEL=qwen3
LLM_CONTEXT_LIMIT=65536
LLM_MAX_OUTPUT_TOKENS=4096

# ---- search: self-hosted SearXNG, no key ----
SEARCH_PROVIDER=searxng
SEARCH_BASE_URL=http://127.0.0.1:8080

# ---- rerank: optional, but SearXNG paging aggregation depends on it ----
# Needs an OpenAI-compatible /v1/rerank (llama-server --reranking, TEI's /rerank)
RERANK_PROVIDER=openai
RERANK_BASE_URL=http://127.0.0.1:8081
RERANK_MODEL=bge-reranker-v2-m3

# ---- embeddings: optional, used only by advanced memory retrieval ----
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=http://127.0.0.1:8080
EMBEDDING_MODEL=Qwen3-Embedding-0.6B-Q8_0
EMBEDDING_DIM=1024

# ---- voice input: OpenAI-compatible ASR such as whisper.cpp ----
ASR_PROVIDER=openai
ASR_BASE_URL=http://127.0.0.1:9000
ASR_MODEL=whisper-1
ASR_API_KEY=

# ---- OCR: skip it if images go straight to a vision model; PDF/Word/PPT need DeepSeek OCR ----
OCR_PROVIDER=openai
OCR_BASE_URL=http://127.0.0.1:9001
OCR_MODEL=gpt-4o-mini
OCR_API_KEY=

# ---- read-aloud ----
TTS_PROVIDER=openai
TTS_BASE_URL=http://127.0.0.1:9002
TTS_MODEL=tts-1
TTS_VOICE=alloy
TTS_RESPONSE_FORMAT=wav
```

Every block can be deleted on its own: the corresponding feature disappears from the UI and nothing else is affected. The SearXNG tuning variables (candidate counts, pages, snippet length) work with their defaults; details in [search.md](search.md).

### Example 3: one DeepSeek key (`.env` only)

This shortcut works **only from `.env` or system environment variables**; the first-run wizard has no "DeepSeek key" field. Wizard users must pick `deepseek` in the LLM, voice and OCR blocks and paste the key three times — or just use `.env`.

```env
DEEPSEEK_API_KEY=sk-xxx
# read-aloud is not enabled by the key alone; opt in explicitly (URL and key are reused)
TTS_PROVIDER=deepseek
```

What happens automatically:

- LLM → `https://api.deepseek.com/anthropic` with model `deepseek-flash` (with `LLM_PROVIDER=openai` the default base becomes `https://api.deepseek.com`, the OpenAI-compatible endpoint);
- voice input → DeepSeek `/v1/tools/asr`;
- OCR → DeepSeek `/v1/tools/ocr` (documents and images);
- read-aloud → only after you set `TTS_PROVIDER=deepseek` (URL and key are reused).

**Search is not enabled by this key.** In the self-hosted backend, web search runs through the local tool loop, so you must configure `SEARCH_PROVIDER` (Tavily / AnySearch / SearXNG) yourself; only DeepSeek Cloud mode uses server-side search.

Any single value can be overridden by setting its environment variable, which takes precedence over the defaults this key provides.

## The two LLM protocols

`LLM_PROVIDER` decides which request the backend sends upstream. Under both protocols, web search, page reading, citation numbers, thinking, attachments (images / OCR), auto titles and context compression use the same logic — nothing extra to configure.

| `LLM_PROVIDER` | Upstream endpoint | Handling | Typical services |
|---|---|---|---|
| `anthropic` (default) | `POST /v1/messages`: roots, `/anthropic` and `/v1` prefixes get the standard path; a full endpoint ending in `/messages` (any path, e.g. `/gw/v1/messages`) is used as-is | forwarded as-is | DeepSeek's `/anthropic` endpoint, Anthropic-compatible gateways mounted anywhere |
| `openai` | `POST /v1/chat/completions` (same URL rules as ASR / rerank: roots or URLs ending in `/v1` get the standard path, full endpoints are used as-is) | request rewritten into OpenAI shape, streamed reply translated back into Anthropic events | OpenAI, DeepSeek, Ollama, LM Studio, vLLM, llama.cpp and gateways |

What the OpenAI path covers:

- **Thinking**: both `reasoning_content` (DeepSeek / vLLM) and `reasoning` fields are recognized and shown as a thinking block; no field means no block.
- **Tool calls**: `tools` become function calling; returned `tool_calls` run web_search / read_url locally and are sent back as `role: tool` messages. Search cards and citation numbers keep working.
- **Usage**: `prompt_tokens` / `completion_tokens` feed the context meter; `prompt_tokens_details.cached_tokens` counts as cache hits.
- **Images**: base64 images become `image_url` data URLs. The upstream model must support vision; otherwise set `CHAT_LOCAL_IMAGE_MODE=auto` to fall back to OCR.
- **Fallbacks**: if the server rejects `stream_options` it is retried once without it; servers that ignore `stream` and return plain JSON also work.
- **Custom headers**: set `LLM_HEADERS` to a JSON object to add or override request headers (the default `User-Agent` is python-httpx, so declare your own identity here). Works under both protocols, including title and compression requests. Placeholders:

  | Placeholder | Value |
  |---|---|
  | `{key}` | `LLM_API_KEY` |
  | `{session}` | Current conversation ID, normalized to `ses_...` |
  | `{model}` | Model name |

  `{session}` uses the conversation ID the frontend sends; when calling the API directly without one, it is derived from the first user message so it stays stable within a conversation. Probe requests (health check, test connection) have no conversation, so headers containing `{session}` or `{model}` are skipped rather than sending the literal placeholder.

Some providers require an agent identity and a stable per-conversation session ID (declare your own `User-Agent` and put `ses_...` in a custom header):

```env
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.example.com/v1
LLM_MODEL=your-model
LLM_API_KEY=sk-xxx
LLM_HEADERS={"User-Agent": "chat-local-oss/0.1.2", "x-session-id": "{session}"}
```

Every request for the same conversation (chat, tool rounds, auto title, compression) carries the same `ses_...`.

- **Extra request-body fields**: set `LLM_EXTRA_BODY` to a JSON object, shallow-merged into the upstream request under both protocols, e.g. `{"top_k": 40, "metadata": {"user_id": "u1"}}`. `messages` and `stream` are generated locally and ignored; nested objects are replaced rather than deep-merged. Only read from `.env` / system environment variables (not exposed in the wizard); invalid JSON fails the request loudly instead of being dropped.

Ollama:

```env
LLM_PROVIDER=openai
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=qwen3:8b
LLM_API_KEY=
```

DeepSeek's OpenAI endpoint (same key):

```env
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
LLM_API_KEY=sk-xxx
```

Services that need an `api-key` header and `api-version` query parameter, such as Azure OpenAI, connect with a full endpoint URL plus custom headers — no extra gateway:

```env
LLM_PROVIDER=openai
LLM_BASE_URL=https://RESOURCE.openai.azure.com/openai/deployments/DEPLOYMENT/chat/completions?api-version=2024-10-21
LLM_MODEL=DEPLOYMENT
LLM_API_KEY=your-azure-key
LLM_HEADERS={"api-key": "{key}"}
```

A URL that already contains a full path is used as-is, so the query string survives. Azure has no `/v1/models`; the wizard's "Test connection" may show 404/405, but chat is unaffected, and the health check treats those responses as reachable.

## The four read-aloud request shapes

Self-hosted read-aloud has four request shapes. Audio inference servers share no protocol — all you can align on is "text in, audio out" — so pick the shape that matches your server:

| provider | Request body | URL rule | Typical servers |
|---|---|---|---|
| `openai` | `{model, input, voice, response_format}` | A root URL, or any URL ending in `/v1` (including prefixed ones such as `/api/v1`), gets `/v1/audio/speech` appended; any other path is used as-is | llama.cpp, audio.cpp, vLLM, TGI, Kokoro-FastAPI and most forks |
| `deepseek` | `{text, voice_id, format, filter_markdown}` | Official `/v1/tools/tts` | DeepSeek |
| `engine` | `{engine, input, voice, response_format}` | Full endpoint URL, used as-is (voice required) | Servers that pick the model with an `engine` field, e.g. a self-hosted model console |
| `template` | Your own JSON template with `{text}` / `{voice}` / `{model}` / `{format}` placeholders | The exact URL you provide | Anything you wrapped in PyTorch + FastAPI; also handles base64 audio fields and audio URLs |

`template` is configured with `TTS_TEMPLATE_URL` / `_BODY` / `_AUDIO` / `_HEADERS` (see `.env.example`); it is env-only.

Placeholders are substituted in a single pass, so literal text such as `{voice}` inside a reply is sent untouched.

**Out of scope:** async workflow servers such as ComfyUI (submit a graph → poll a task → download an artifact). That would need a polling adapter per workflow graph. Put an HTTP audio endpoint in front of it, or open an issue describing your workflow.

Self-hosted read-aloud follows the provider you configure: `deepseek` calls the official `/v1/tools/tts` (24 kHz raw PCM), `openai` calls `/v1/audio/speech` and returns whatever `TTS_RESPONSE_FORMAT` asks for (wav/mp3/opus/pcm). Before requesting audio, the backend strips the reply down to speakable text (code blocks, tables, formulas and citation markers removed) and splits it at sentence boundaries, then fetches each segment while the previous one plays — so long replies are read in full rather than truncated. `TTS_MAX_CHARS` is the per-request budget. Voice names and supported formats belong to your service; this project does not validate them.

Without `TTS_PROVIDER` the read-aloud button is hidden. Cloud read-aloud is unchanged. Neither path has been verified by listening to real output, so both fall under "not broadly tested."

## ASR / OCR / rerank / embeddings

Audio and OCR servers likewise have no shared protocol, so the project aligns on the smallest common contract:

| Capability | Request shape | Response shape | URL rule |
|---|---|---|---|
| ASR | Standard multipart (`file` + `model`), accepted by whisper.cpp and most forks | `{text}` / `{transcript}` / `{results\|segments:[{text}]}` / `[{text}]` / plain text; long base64 blobs are skipped | A root URL or any URL ending in `/v1` gets `/v1/audio/transcriptions`; a full URL is used as-is |
| OCR | DeepSeek uses `/v1/tools/ocr` (documents and images); OpenAI-compatible uses vision chat/completions (images only) | The reply text, either way | Same rule: root URL gets the standard path appended |
| Rerank | `{model, query, documents}` | `{"results":[{index,relevance_score}]}` or a top-level `[{index,score}]` array (TEI style); a wrapping `data` object is also accepted | A root URL or any URL ending in `/v1` gets `/v1/rerank`; TEI's `/rerank` is used as-is |
| Embedding | `{model, input:[...]}` | `{data:[{index, embedding:[...]}]}` (OpenAI shape) | A root URL or any URL ending in `/v1` gets `/v1/embeddings`; full endpoints are used as-is |

Dedicated OCR servers (PaddleOCR, MinerU, Surya) have no common protocol and are not integrated; use an OpenAI-compatible vision endpoint or DeepSeek OCR instead.

ComfyUI-style async workflow servers are out of scope; see the end of the previous section.
