# Interface compatibility and configuration examples

The README covers "should I use it, how do I run it". This document holds the details: copy-paste configuration examples, and how the project talks to each kind of inference server.

## Configuration examples

Everything can go into the project's `.env`, or be written to `data/config.json` by the first-run wizard (environment variables win). Capabilities are independent: anything unconfigured simply has no UI entry.

**Minimum for each capability**

| Capability | Required | Optional (has a default) |
|---|---|---|
| Chat | `LLM_BASE_URL`, `LLM_MODEL` | `LLM_API_KEY` (local servers may not need one), `LLM_CONTEXT_LIMIT`, `LLM_MAX_OUTPUT_TOKENS` |
| Search | `SEARCH_PROVIDER`; `SEARCH_BASE_URL` when using `searxng` | Base URL for Tavily / AnySearch, `SEARCH_RESULTS` |
| Rerank | `RERANK_PROVIDER` **and** `RERANK_BASE_URL` — both | `RERANK_MODEL`, `RERANK_API_KEY`, `RERANK_TIMEOUT` |
| Voice input | `ASR_PROVIDER`, `ASR_BASE_URL` | `ASR_MODEL` (default `whisper-1`), `ASR_API_KEY` |
| OCR | `OCR_PROVIDER`, `OCR_BASE_URL` | `OCR_MODEL` (default `gpt-4o-mini`), `OCR_API_KEY` |
| Read-aloud | `TTS_PROVIDER`, `TTS_BASE_URL`; `TTS_VOICE` too when the provider is `engine` | `TTS_MODEL` (default `tts-1`), `TTS_RESPONSE_FORMAT`, `TTS_MAX_CHARS` |

Setting only `RERANK_BASE_URL` does **not** turn reranking on: `RERANK_PROVIDER` defaults to `none`, so both are required.

### Example 1: model only (smallest working setup)

```env
# The base URL stops before /v1 — the server appends /v1/messages itself
LLM_BASE_URL=http://127.0.0.1:8000
LLM_MODEL=qwen3
# local servers such as llama.cpp or Ollama usually ignore the key
LLM_API_KEY=
```

You get chat, thinking, history and context management. Search, voice, OCR and read-aloud have no UI entry.

The model endpoint must speak the **Anthropic-compatible protocol** (`POST /v1/messages`). llama.cpp's OpenAI endpoint (`/v1/chat/completions`) is not enough; put an Anthropic-compatible gateway in front of it.

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

### Example 3: one DeepSeek key

```env
DEEPSEEK_API_KEY=sk-xxx
# read-aloud is not enabled by the key alone; opt in explicitly (URL and key are reused)
TTS_PROVIDER=deepseek
```

What happens automatically:

- LLM → `https://api.deepseek.com/anthropic` with model `deepseek-flash`;
- voice input → DeepSeek `/v1/tools/asr`;
- OCR → DeepSeek `/v1/tools/ocr` (documents and images);
- read-aloud → only after you set `TTS_PROVIDER=deepseek` (URL and key are reused).

**Search is not enabled by this key.** In the self-hosted backend, web search runs through the local tool loop, so you must configure `SEARCH_PROVIDER` (Tavily / AnySearch / SearXNG) yourself; only DeepSeek Cloud mode uses server-side search.

Any single value can be overridden by setting its environment variable, which takes precedence over the defaults this key provides.

## The four read-aloud request shapes

Self-hosted read-aloud has four request shapes. Audio inference servers share no protocol — all you can align on is "text in, audio out" — so pick the shape that matches your server:

| provider | Request body | URL rule | Typical servers |
|---|---|---|---|
| `openai` | `{model, input, voice, response_format}` | Root URL gets `/v1/audio/speech` appended; any other path is used as-is | llama.cpp, audio.cpp, vLLM, TGI, Kokoro-FastAPI and most forks |
| `deepseek` | `{text, voice_id, format, filter_markdown}` | Official `/v1/tools/tts` | DeepSeek |
| `engine` | `{engine, input, voice, response_format}` | Full endpoint URL, used as-is (voice required) | Servers that pick the model with an `engine` field, e.g. a self-hosted model console |
| `template` | Your own JSON template with `{text}` / `{voice}` / `{model}` / `{format}` placeholders | The exact URL you provide | Anything you wrapped in PyTorch + FastAPI; also handles base64 audio fields and audio URLs |

`template` is configured with `TTS_TEMPLATE_URL` / `_BODY` / `_AUDIO` / `_HEADERS` (see `.env.example`); it is env-only.

**Out of scope:** async workflow servers such as ComfyUI (submit a graph → poll a task → download an artifact). That would need a polling adapter per workflow graph. Put an HTTP audio endpoint in front of it, or open an issue describing your workflow.

Self-hosted read-aloud follows the provider you configure: `deepseek` calls the official `/v1/tools/tts` (24 kHz raw PCM), `openai` calls `/v1/audio/speech` and returns whatever `TTS_RESPONSE_FORMAT` asks for (wav/mp3/opus/pcm). Before requesting audio, the backend strips the reply down to speakable text (code blocks, tables, formulas and citation markers removed) and splits it at sentence boundaries, then fetches each segment while the previous one plays — so long replies are read in full rather than truncated. `TTS_MAX_CHARS` is the per-request budget. Voice names and supported formats belong to your service; this project does not validate them.

Without `TTS_PROVIDER` the read-aloud button is hidden. Cloud read-aloud is unchanged. Neither path has been verified by listening to real output, so both fall under "not broadly tested."

## ASR / OCR / rerank

Audio and OCR servers likewise have no shared protocol, so the project aligns on the smallest common contract:

| Capability | Request shape | Response shape | URL rule |
|---|---|---|---|
| ASR | Standard multipart (`file` + `model`), accepted by whisper.cpp and most forks | `{text}` / `{transcript}` / `{results\|segments:[{text}]}` / `[{text}]` / plain text | Root URL gets `/v1/audio/transcriptions`; a full URL is used as-is |
| OCR | DeepSeek uses `/v1/tools/ocr` (documents and images); OpenAI-compatible uses vision chat/completions (images only) | The reply text, either way | Same rule: root URL gets the standard path appended |
| Rerank | `{model, query, documents}` | `{"results":[{index,relevance_score}]}` or a top-level `[{index,score}]` array (TEI style); a wrapping `data` object is also accepted | Root URL gets `/v1/rerank`; TEI's `/rerank` is used as-is |

Dedicated OCR servers (PaddleOCR, MinerU, Surya) have no common protocol and are not integrated; use an OpenAI-compatible vision endpoint or DeepSeek OCR instead.

ComfyUI-style async workflow servers are out of scope; see the end of the previous section.
