<p align="right"><b>English</b> | <a href="README.zh-CN.md">简体中文</a></p>

# chat-local

> **Positioning: faithfully recreate the core DeepSeek web chat experience while keeping conversations and attachments on your machine; bring that frontend to more models through an Anthropic-compatible API.**

Built on [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo). "Recreate" here covers the core chat loop: chat, thinking, web and deep search, citations, attachments, and voice. It does not include DeepSeek accounts, cloud conversation sync, or every operational feature of the website.

**Who it is for:** people who want DeepSeek-web-style chat, local history, and the ability to plug in their own model backend.

**Who it is not for:** people who need agents, plugins, RAG knowledge bases, multi-user support, or mobile apps; use a platform built for those. This project intentionally stays a pure chat frontend.

## Project status

This is a **community snapshot (v0.1.0)**, not a continuously maintained product.

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
| Model | Official DeepSeek API | Any Anthropic-compatible model |
| Requires | A DeepSeek API key | Base URL + API key + model name |
| Web search | DeepSeek server-side tools | Your configured search provider |
| Voice input | DeepSeek `/v1/tools/asr` | Your configured ASR provider |
| Read-aloud | DeepSeek `/v1/tools/tts` | Not supported; no UI entry |
| History | Local SQLite | Local SQLite |

## Configuration

Configuration has two sources, in descending priority:

1. Environment variables / `.env` in the project root (suitable for deployment)
2. `data/config.json` written by the first-run wizard (suitable for regular users)

Nothing is read from other projects.

| Variable | Description |
|---|---|
| `DEEPSEEK_API_KEY` | Automatically points LLM, ASR, and OCR at DeepSeek |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Anthropic-compatible endpoint for the self-hosted backend |
| `LLM_CONTEXT_LIMIT` / `LLM_MAX_OUTPUT_TOKENS` | Input limit and max output per request; defaults 131072 / 8192 |
| `ASR_PROVIDER` | `none` / `deepseek` / `openai` |
| `ASR_BASE_URL` / `ASR_API_KEY` / `ASR_MODEL` | Speech recognition; the OpenAI-compatible default model is `whisper-1` |
| `OCR_PROVIDER` | `none` / `deepseek` / `openai` |
| `OCR_BASE_URL` / `OCR_API_KEY` / `OCR_MODEL` | Document/image OCR; the OpenAI-compatible path supports images only |
| `SEARCH_PROVIDER` | `none` / `tavily` / `anysearch` / `searxng` |
| `SEARCH_BASE_URL` / `SEARCH_API_KEY` / `SEARCH_RESULTS` | Web search; AnySearch keys may be empty (anonymous rate limits); Tavily requires a key |
| `CHAT_LOCAL_IMAGE_MODE` | `vision` / `auto` / `ocr` |

Unconfigured capabilities are hidden in the UI (for example, no ASR means no microphone button), so users do not hit buttons that are guaranteed to fail.

### Example: DeepSeek model + Tavily search

```env
DEEPSEEK_API_KEY=sk-xxx
SEARCH_PROVIDER=tavily
SEARCH_API_KEY=tvly-xxx
```

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
```

## Features

### Conversations and data

- **Local storage:** FastAPI + SQLite store chats and attachments in `data/chat.db` and `data/files/`.
- **History import/export:** import the official DeepSeek ZIP export (`export_format_version: 3`) using replace, merge-skip-duplicates, or merge-as-copy; optionally discard tool records or image files on import.
- **Archive and restore:** archive from the session menu; open or restore archived chats under Settings → Data management → View archive.
- **Chat cleanup:** delete chats older than N years/months or inside a date range; remove tool-call records and image originals from all chats.

### Context and tools (self-hosted only)

- **Context management:** usage indicator, local compression, and configurable context/output limits. Cloud mode only shows usage; its limit is fixed by DeepSeek.
- **Tool rounds:** adjust the maximum number of web-tool rounds per answer. In cloud mode DeepSeek controls this server-side, and the client does not send the parameter.

### UI and configuration

- **First-run wizard:** available in both modes, but it only writes self-hosted backend configuration.
- **Capability detection:** unconfigured search, ASR, and similar entries are hidden automatically.
- **UI fixes:** dark-mode select menus, session menu positioning, cleanup statistics, and related issues.

## Capability matrix

| Capability | DeepSeek Cloud | Self-hosted backend |
|---|---|---|
| Chat / thinking / stop / continue | DeepSeek API | Anthropic-compatible endpoint |
| Web search and page reading | DeepSeek server-side tools; the tools themselves are not billed | Your configured search provider |
| Voice input | DeepSeek `/v1/tools/asr` | `deepseek` or OpenAI-compatible ASR |
| Read-aloud | DeepSeek `/v1/tools/tts` | Not supported |
| Images | Sent directly to DeepSeek | Vision first; optional OCR fallback |
| PDF / Word / PPT | DeepSeek Files API | DeepSeek OCR or disabled |

Read-aloud (TTS) is available only in DeepSeek Cloud mode; the self-hosted backend has no read-aloud entry. Cloud TTS has not been tested against the real service and falls under "not broadly tested."

## Limitations

- This project has not been broadly tested; see Project status above.
- The self-hosted LLM currently supports only the Anthropic-compatible protocol (DeepSeek's `/anthropic` endpoint and other compatible services). OpenAI-compatible LLMs are not supported yet.
- OpenAI-compatible OCR handles images only; use DeepSeek OCR for PDF/Word/PPT or convert them to images first.
- Import/export currently supports only the DeepSeek export format.
- The self-hosted backend has no TTS.

## Security and privacy

- The server listens on `127.0.0.1` by default; write endpoints require the `X-Chat-Local: 1` header.
- Chats and attachments live in local `data/`, independent of a DeepSeek account or cloud conversation sync. Cloud mode still sends conversation content to the DeepSeek API; only self-hosted mode keeps inference on the model endpoint you configure.
- When web search, ASR, or OCR is enabled, the corresponding content is sent to the provider you chose. Disable anything you do not need.
- Self-hosted secrets live only in `.env` or `data/config.json` and are never returned in plaintext. Both locations are excluded by `.gitignore`.
- The setup write endpoints accept only loopback requests. If the server listens on `0.0.0.0`, the wizard is read-only and you must use `.env`.
- In cloud mode the API key is stored in browser localStorage, as in the original chat-demo.

## AI-assisted development disclosure

Substantial parts of the code, documentation, and refactoring were generated or modified with **DeepSeek in Qoder**, then reviewed, run, and accepted or rejected by a human. AI-generated code may contain bugs, omissions, or security issues; evaluate it before use. This project is not affiliated with DeepSeek.

## License

MIT. See [LICENSE](LICENSE). The UI and message protocol come from [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) (MIT).
