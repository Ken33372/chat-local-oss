<p align="right"><b>English</b> | <a href="README.zh-CN.md">简体中文</a></p>

# chat-local

> **Positioning: faithfully recreate the core DeepSeek web chat experience while keeping conversations and attachments on your machine; bring that chat experience to more models through an Anthropic-compatible API.**

Built on [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo). "Recreate" here covers the core chat loop: chat, thinking, web and deep search, citations, attachments, and voice. It does not include DeepSeek accounts, cloud conversation sync, or every operational feature of the website.

**Who it is for:** people who want DeepSeek-web-style chat, local history, and the ability to plug in their own model backend.

**Who it is not for:** people who need agents, plugins, RAG knowledge bases, multi-user support, or mobile apps; use a platform built for those. This project intentionally stays a pure chat tool.

## Project status

This is a **community snapshot (v0.1.1)**, not a continuously maintained product.

- The UI, message protocol, and DeepSeek Cloud path are inherited from [chat-demo](https://github.com/deepseek-ai/chat-demo); core features are preserved. The self-hosted path has been smoke-tested.
- **Not broadly tested:** DeepSeek Cloud, ASR, OCR, TTS, different model backends, and different operating systems are left mainly to community verification.
- Issues and PRs are best-effort. Back up `data/` before upgrading; do not treat it as your only copy.
- When reporting a problem, include your OS, model provider, reproduction steps, and relevant logs.

## Relationship to chat-demo

**In DeepSeek Cloud mode, the cloud chat features match [chat-demo](https://github.com/deepseek-ai/chat-demo):** chat, thinking, web/deep search, link reading, attachment upload, voice input, and read-aloud use the same official DeepSeek endpoints and interaction model. The cloud request path has not been rewritten.

The main differences are local SQLite storage and the features listed below. Anything marked "self-hosted only" is unavailable in cloud mode.

## Quick start

Requirements: Python 3.10+ and Node.js 20+.

Windows x64 users can also download the portable ZIP from [Releases](https://github.com/Ken33372/chat-local-oss/releases), unzip it, and run `start.bat` — no Python or Node installation is required.

> **The prebuilt portable ZIP is not guaranteed to be the latest version.** It is packaged at release time and normally lags behind `main`; for the newest features run from source or build it yourself with `build.bat`.

```bash
pip install -r requirements.txt

cd web && npm install && npm run build && cd ..

python -m uvicorn main:app --app-dir server --host 127.0.0.1 --port 17865
```

On Windows you can also run `build.bat` and then `start.bat`. Open `http://127.0.0.1:17865/`.

The first visit shows a setup wizard:

- **DeepSeek Cloud:** switch to cloud mode, then enter your DeepSeek API key in Settings.
- **Self-hosted backend:** enter the base URL, API key, and model name; configure search, ASR, and OCR under Advanced.

Saved settings go to `data/config.json` and take effect immediately, with no restart. You can skip the wizard and copy `.env.example` to `.env` instead; environment variables take precedence over values saved by the wizard.

> Cloud mode still requires the local backend to be running, because chats and attachments are stored in local SQLite rather than synced to a DeepSeek account.

## Two modes

| | DeepSeek Cloud | Self-hosted backend |
|---|---|---|
| LLM | Official DeepSeek API | Any Anthropic-compatible model (fully configurable) |
| Requires | A DeepSeek API key | Base URL + API key + model name |
| Web search | DeepSeek server-side tools | Your configured search provider |
| Voice input | DeepSeek `/v1/tools/asr` | Your configured ASR provider |
| Read-aloud | DeepSeek `/v1/tools/tts` | Your configured TTS provider (DeepSeek or OpenAI-compatible `/v1/audio/speech`) |
| History | Local SQLite | Local SQLite |

## Configuration

Configuration has two sources, in descending priority:

1. Environment variables / `.env` in the project root (suitable for deployment)
2. `data/config.json` written by the first-run wizard (suitable for regular users)

Nothing is read from other projects.

| Variable | Description |
|---|---|
| `DEEPSEEK_API_KEY` | Automatically points LLM, ASR, and OCR at DeepSeek; a `deepseek` read-aloud provider reuses this key (you still have to enable `TTS_PROVIDER`) |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Anthropic-compatible endpoint for the self-hosted backend |
| `LLM_CONTEXT_LIMIT` / `LLM_MAX_OUTPUT_TOKENS` | Input limit and max output per request; defaults 131072 / 8192 |
| `ASR_PROVIDER` | `none` / `deepseek` / `openai` |
| `ASR_BASE_URL` / `ASR_API_KEY` / `ASR_MODEL` | Speech recognition; the OpenAI-compatible default model is `whisper-1`. A root URL gets `/v1/audio/transcriptions` appended, a full URL is used as-is; responses may be `{text}`, `[{text}]`, `{segments:[{text}]}` or plain text |
| `OCR_PROVIDER` | `none` / `deepseek` / `openai` |
| `OCR_BASE_URL` / `OCR_API_KEY` / `OCR_MODEL` | Document/image OCR; the OpenAI-compatible path supports images only. A root URL gets `/v1/chat/completions` appended, a full URL is used as-is |
| `TTS_PROVIDER` | `none` / `deepseek` / `openai` / `engine` / `template`; no read-aloud button unless it is set |
| `TTS_BASE_URL` / `TTS_API_KEY` / `TTS_MODEL` | Read-aloud endpoint. With `deepseek` the base URL can be omitted and `DEEPSEEK_API_KEY` is reused; `openai` means the OpenAI-compatible `/v1/audio/speech`, so self-hosted engines point at their own address (default model name `tts-1`). A base URL that already carries a path — for example `http://host:8090/api/tts/speech` — is requested as-is instead of having the standard path appended |
| `TTS_VOICE` | Voice name; leave empty for the service default (DeepSeek: `stella`; OpenAI: `alloy`) |
| `TTS_RESPONSE_FORMAT` | `wav` (default) / `mp3` / `opus` / `pcm`; only applies to the OpenAI-compatible path |
| `TTS_MAX_CHARS` | Character budget per synthesis request (4000 by default); longer replies are split at sentence boundaries and synthesized segment by segment |
| `TTS_TEMPLATE_URL` / `_BODY` / `_AUDIO` / `_HEADERS` | `template` only: exact endpoint URL, JSON body template, how to extract audio (`body` / `base64:<field>` / `url:<field>`), extra request headers |
| `SEARCH_PROVIDER` | `none` / `tavily` / `anysearch` / `searxng` |
| `SEARCH_BASE_URL` / `SEARCH_API_KEY` / `SEARCH_RESULTS` | Web search. `SEARCH_BASE_URL` is optional for Tavily (`https://api.tavily.com`) and AnySearch (`https://api.anysearch.com`), but required for SearXNG. Tavily requires a key; AnySearch keys may be empty (anonymous rate limits) |
| `RERANK_PROVIDER` / `RERANK_BASE_URL` / `RERANK_API_KEY` / `RERANK_MODEL` / `RERANK_TIMEOUT` | Optional rerank endpoint — for example `llama-server --reranking` or HuggingFace text-embeddings-inference. A root URL gets `/v1/rerank` appended, a full URL (TEI's `/rerank`) is used as-is; both `{"results":[...]}` and a top-level `[{index,score}]` array are accepted. Only takes effect with `SEARCH_PROVIDER=searxng`; details in [docs/search.md](docs/search.md) |
| `SEARCH_CANDIDATE_TARGET` / `SEARCH_CANDIDATE_MAX` / `SEARCH_MAX_PAGES` / `SEARCH_SNIPPET_CHARS` | SearXNG aggregation tuning (20 / 60 / 5 / 500 by default) |
| `SEARCH_ALLOWED_DOMAINS` / `SEARCH_BLOCKED_DOMAINS` | Comma-separated site rules. `example.com` also covers its subdomains; `example.com/docs` additionally restricts the path prefix |
| `CHAT_LOCAL_IMAGE_MODE` | `vision` / `auto` / `ocr`. Defaults to `vision`, which sends images to the model and **requires vision/multimodal support**; `auto` falls back to OCR when the model rejects the image; `ocr` never sends images and uses OCR only. **If your model is not multimodal, set this to `auto` or `ocr`; otherwise sending an image returns an upstream error.** |

Unconfigured capabilities are hidden in the UI (for example, no ASR means no microphone button), so users do not hit buttons that are guaranteed to fail.

### More detail

- Two copy-paste configuration examples, plus interface compatibility notes for read-aloud / ASR / OCR / rerank: [docs/providers.md](docs/providers.md)
- SearXNG result quality, the rerank switch, paging aggregation and measured timings: [docs/search.md](docs/search.md)

## Features

### Per-capability self-hosted configuration

LLM, search, ASR, and OCR are configured independently:

- **LLM:** model name, base URL, API key, context limit, and max output are yours to set; the protocol is Anthropic-compatible (for example, DeepSeek's `/anthropic` endpoint).
- **ASR:** DeepSeek `/v1/tools/asr` or an OpenAI-compatible `/v1/audio/transcriptions` endpoint.
- **OCR:** DeepSeek `/v1/tools/ocr` (documents and images) or an OpenAI-compatible vision endpoint (images only).
- **Search:** Tavily, AnySearch, SearXNG, or off. With SearXNG you can add your own reranker to enable multi-page aggregation and relevance ordering; without one, search stays single-page.
- Unconfigured capabilities are hidden automatically. OpenAI-compatible LLMs are not supported yet.

### Conversations and data

- **Local storage:** FastAPI + SQLite store chats and attachments in `data/chat.db` and `data/files/`.
- **History import/export:** import the official DeepSeek ZIP export (`export_format_version: 3`) using replace, merge-skip-duplicates, or merge-as-copy; optionally discard tool records or image files on import.
- **Chat search:** search message text from the sidebar; results are grouped by chat with matching snippets. Archived chats are excluded.
- **Archive and restore:** archive from the session menu; open, restore, or permanently delete archived chats under Settings → Data management → View archive.
- **Chat cleanup:** delete chats older than N years/months or inside a date range; remove tool-call records and image originals from all chats.

### Context and tools (self-hosted only)

- **Context management:** usage indicator, local compression, and configurable context/output limits. Cloud mode only shows usage; its limit is fixed by DeepSeek.
- **Auto-generated titles:** optional and off by default. After the first reply, the local backend makes one extra model request using the first visible user/assistant turn. Cloud mode keeps DeepSeek's built-in title.
- **Tool rounds:** adjust the maximum number of web-tool rounds per answer. In cloud mode DeepSeek controls this server-side, and the client does not send the parameter.

### UI and configuration

- **First-run wizard:** available in both modes, but it only writes self-hosted backend configuration. Choosing SearXNG as the search provider reveals a rerank group (Base URL / API Key / Model); filling in the Base URL is what turns on multi-page aggregation. Under Advanced you can also configure read-aloud: provider, base URL, key, model, voice and response format.
- **Capability detection:** unconfigured search, ASR, and similar entries are hidden automatically.
- **UI fixes:** dark-mode select menus, session menu positioning, cleanup statistics, and related issues.

## Capability matrix

| Capability | DeepSeek Cloud | Self-hosted backend |
|---|---|---|
| Chat / thinking / stop / continue | DeepSeek API | Anthropic-compatible endpoint |
| Web search and page reading | DeepSeek server-side tools; the tools themselves are not billed | Your configured search provider |
| Voice input | DeepSeek `/v1/tools/asr` | `deepseek` or OpenAI-compatible ASR |
| Read-aloud | DeepSeek `/v1/tools/tts` | `deepseek` or OpenAI-compatible `/v1/audio/speech` |
| Images | Sent directly to DeepSeek | Vision first; optional OCR fallback |
| PDF / Word / PPT | DeepSeek Files API | DeepSeek OCR or disabled |

Self-hosted read-aloud supports four request shapes (`openai` / `deepseek` / `engine` / `template`) covering common self-hosted TTS servers; the shape table, the four `template` settings and what is explicitly out of scope (e.g. ComfyUI async workflows) are in [docs/providers.md](docs/providers.md#the-four-read-aloud-request-shapes).

## Limitations

- This project has not been broadly tested; see Project status above.
- The self-hosted LLM currently supports only the Anthropic-compatible protocol (DeepSeek's `/anthropic` endpoint and other compatible services). OpenAI-compatible LLMs are not supported yet.
- OpenAI-compatible OCR handles images only; use DeepSeek OCR for PDF/Word/PPT or convert them to images first.
- Import/export currently supports only the DeepSeek export format.
- Read-aloud has not been verified by listening on either path; whether self-hosted read-aloud works depends on your service actually implementing `/v1/audio/speech`.
- The two known SearXNG pitfalls (Brave jump links, upstream engine rate limits) are documented in [docs/search.md](docs/search.md#two-known-sources-of-dirty-data).

## Security and privacy

- The server listens on `127.0.0.1` by default; write endpoints require the `X-Chat-Local: 1` header.
- Chats and attachments live in local `data/`, independent of a DeepSeek account or cloud conversation sync. Cloud mode still sends conversation content to the DeepSeek API; only self-hosted mode keeps inference on the model endpoint you configure.
- When web search, ASR, or OCR is enabled, the corresponding content is sent to the provider you chose. Disable anything you do not need.
- Self-hosted secrets live only in `.env` or `data/config.json` and are never returned in plaintext. Both locations are excluded by `.gitignore`.
- The setup write endpoints accept only loopback requests. If the server listens on `0.0.0.0`, the wizard is read-only and you must use `.env`.
- In cloud mode the API key is stored in browser localStorage, as in the original chat-demo.

## AI-assisted development disclosure

Substantial parts of the code, documentation, and refactoring were generated or modified with **DeepSeek in Qoder**, then reviewed, run, and accepted or rejected by a human. AI-generated code may contain bugs, omissions, or security issues; evaluate it before use. This project is not affiliated with DeepSeek.

## Acknowledgements

The SearXNG result-quality work — paging aggregation with `pageno` (candidate target and ceiling, stop rules), cross-page de-duplication, snippet cleaning, domain allow/block rules, and reranking the aggregate instead of dumping it into the context — was informed by the search tool of [DdogezD/claudium](https://github.com/DdogezD/claudium), whose default values (20 candidates, 5 pages, 500-character snippets) are reused here.

That repository declares no license, so nothing was copied from it: the ideas were reimplemented in this project's own code, and claudium is not a dependency here.

## License

MIT. See [LICENSE](LICENSE). The UI and message protocol come from [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) (MIT).
