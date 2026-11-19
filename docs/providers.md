# Interface compatibility and configuration examples

The README covers "should I use it, how do I run it". This document holds the details: copy-paste configuration examples, and how the project talks to each kind of inference server.

## Configuration examples

### Example: self-hosted mode with DeepSeek's Anthropic endpoint + Tavily

Use this only in **self-hosted backend** mode. The model comes from DeepSeek, but web search is executed by this project's local tool loop, so it needs its own search provider.

```env
LLM_BASE_URL=https://api.deepseek.com/anthropic
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-flash

SEARCH_PROVIDER=tavily
SEARCH_API_KEY=tvly-xxx
# SEARCH_BASE_URL is optional; it defaults to https://api.tavily.com
```

In **DeepSeek Cloud** mode, web search is handled by DeepSeek server-side; do not configure `SEARCH_PROVIDER` for that mode.

### Example: fully self-hosted

```env
LLM_BASE_URL=http://127.0.0.1:8000
LLM_API_KEY=
LLM_MODEL=qwen3
LLM_CONTEXT_LIMIT=65536
LLM_MAX_OUTPUT_TOKENS=4096

SEARCH_PROVIDER=searxng
SEARCH_BASE_URL=http://127.0.0.1:8080

ASR_PROVIDER=openai
ASR_BASE_URL=http://127.0.0.1:9000
ASR_API_KEY=
ASR_MODEL=whisper-1

RERANK_BASE_URL=http://127.0.0.1:8080
RERANK_MODEL=bge-reranker-v2-m3
```

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
