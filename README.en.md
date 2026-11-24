<p align="right"><a href="README.md">简体中文</a> | <b>English</b></p>

# chat-local

> **Positioning: faithfully recreate the core DeepSeek web chat experience while keeping conversations and attachments on your machine; bring that chat experience to more models through an Anthropic-compatible API.**

Built on [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo). "Recreate" here covers the core chat loop: chat, thinking, web and deep search, citations, attachments, and voice. It does not include DeepSeek accounts, cloud conversation sync, or every operational feature of the website.

**Who it is for:** people who want DeepSeek-web-style chat, local history, and the ability to plug in their own model backend.

**Who it is not for:** people who need agents, plugins, RAG knowledge bases, multi-user support, or mobile apps; use a platform built for those. This project intentionally stays a pure chat tool.

## Project status

This is a **community snapshot (v0.1.3)**, not a continuously maintained product.

- The UI, message protocol, and DeepSeek Cloud path are inherited from [chat-demo](https://github.com/deepseek-ai/chat-demo); core features are preserved. The self-hosted core paths have offline regression tests, which do not replace testing in real environments.
- **Not broadly tested:** DeepSeek Cloud, ASR, OCR, TTS, different model backends, and different operating systems are left mainly to community verification.
- **`main` contains reliability fixes and new features added after v0.1.3** (session saving, import, usage accounting, tool execution, web-fetch boundaries, workspace role cards and streaming performance work); the v0.1.3 portable ZIP on the Releases page predates them. Run from source or build it yourself for the latest code.
- Issues and PRs are best-effort. Back up `data/` before upgrading; do not treat it as your only copy.
- When reporting a problem, include your OS, model provider, reproduction steps, and relevant logs.

## Relationship to chat-demo

**In DeepSeek Cloud mode, the cloud chat features match [chat-demo](https://github.com/deepseek-ai/chat-demo):** chat, thinking, web/deep search, link reading, attachment upload, voice input, and read-aloud use the same official DeepSeek endpoints and interaction model. The cloud request path has not been rewritten.

The main differences are local SQLite storage and the features listed below. Anything marked "self-hosted only" is unavailable in cloud mode.

## Quick start

### Option 1: run from source

1. **Requirements**: Python 3.10+ and Node.js 20+ (`python --version` and `node --version` should print versions).
2. **Get the source**:

   ```bash
   git clone https://github.com/Ken33372/chat-local-oss.git
   cd chat-local-oss
   ```

   No git? Download the repository ZIP and unzip it — same result.
3. **Install backend dependencies and build the frontend** (from the project root):

   ```bash
   pip install -r requirements.txt
   cd web && npm install && npm run build && cd ..
   ```

   To isolate Python packages, run `python -m venv .venv`, activate it, then `pip install`.
4. **Start the backend**:

   ```bash
   python -m uvicorn main:app --app-dir server --host 127.0.0.1 --port 17865
   ```
5. **Verify**: open `http://127.0.0.1:17865/`; `http://127.0.0.1:17865/api/health` returning JSON means the server is up.

On Windows, the frontend half of step 3 and step 4 can be replaced by the provided scripts: run `pip install -r requirements.txt` once yourself, then double-click `build.bat` (installs frontend dependencies and builds), then `start.bat` (starts the server and opens the browser); `stop.bat` stops it.

### Option 2: portable ZIP (no environment needed)

Windows x64 users can download the portable ZIP from [Releases](https://github.com/Ken33372/chat-local-oss/releases), unzip it, and run `start.bat` — no Python or Node installation is required.

> **The prebuilt portable ZIP is not guaranteed to be the latest version.** It is packaged at release time and normally lags behind `main`; for the newest features run from source or build it yourself with `build.bat`.

### First run

If nothing is configured yet, the first visit shows a step-by-step wizard: pick **DeepSeek Cloud** (enter an API key and you are done; it jumps straight to Data management) or **self-hosted backend**. For self-hosted, configure the model first, then tick the extras you want (search, attachment parsing, voice, rerank and embeddings); every later step can be skipped. Changes take effect immediately.

If you already configured everything through `.env`, skip the wizard. The precedence of the two sources, the wizard entry point and every variable are documented under [Configuration](#configuration).

### Development and tests

The repository includes offline regression tests that do not read `.env` or `data/` and need no real model or API key:

```bash
python -m unittest discover -s tests
cd web && npm test && npm run type && npm run lint
```

For a production frontend build, use `cd web && npm run build` (or `build.bat` in the repository root).

## Two modes

| | DeepSeek Cloud | Self-hosted backend |
|---|---|---|
| LLM | Official DeepSeek API | Any Anthropic-compatible model (fully configurable) |
| Requires | A DeepSeek API key | Base URL + API key + model name |
| History | Local SQLite | Local SQLite |

Where each capability comes from is listed in the [capability matrix](#capability-matrix).

> Cloud mode still needs the local backend running: conversations and attachments live in local SQLite, not in DeepSeek cloud sync.

## Configuration

Configuration has two sources, in descending priority:

1. Environment variables / `.env` in the project root (suitable for advanced users; you can skip the wizard entirely — restart after editing)
2. `data/config.json` written by the first-run wizard (suitable for regular users; takes effect immediately)

The wizard only appears when no model is configured; to reopen it later: Settings → General → Service configuration. Nothing is read from other projects.

| Variable | Description |
|---|---|
| `DEEPSEEK_API_KEY` | Automatically points LLM, ASR and the DeepSeek OCR profile at DeepSeek; a `deepseek` read-aloud provider reuses this key (you still have to enable `TTS_PROVIDER`). **This shortcut only works from `.env` or system environment variables** — the first-run wizard has no such field |
| `LLM_PROVIDER` | `anthropic` (default, `POST /v1/messages`) or `openai` (`POST /v1/chat/completions`, e.g. Ollama, LM Studio, vLLM). Search, citations, thinking, attachments, titles and compression behave the same under both; see [docs/providers.md](docs/providers.md#the-two-llm-protocols) |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Model endpoint for the self-hosted backend; Anthropic-compatible accepts a prefix like `/anthropic` or a full `/v1/messages` endpoint, OpenAI-compatible accepts a root, a URL ending in `/v1`, or a full endpoint |
| `LLM_HEADERS` | Extra request headers as a JSON object. Placeholders: `{key}` is `LLM_API_KEY`, `{session}` is the current conversation ID (like `ses_...`), `{model}` is the model name. Covers Azure-style auth, identity declaration and session IDs (e.g. `{"User-Agent": "chat-local-oss/0.1.3", "x-session-id": "{session}"}`); custom headers override defaults with the same name |
| `LLM_EXTRA_BODY` | Extra request-body fields as a JSON object, shallow-merged into the upstream request (both protocols); `messages` and `stream` are generated locally and ignored if present. **Only works from `.env` or system environment variables** — not exposed in the wizard |
| `LLM_CONTEXT_LIMIT` / `LLM_MAX_OUTPUT_TOKENS` | Input limit and max output per request; defaults 131072 / 8192 |
| `ASR_PROVIDER` | `none` / `deepseek` / `openai` |
| `ASR_BASE_URL` / `ASR_API_KEY` / `ASR_MODEL` | Speech recognition; the OpenAI-compatible default model is `whisper-1`. A root URL, or any URL ending in `/v1` (including prefixed ones such as `/api/v1`), gets `/v1/audio/transcriptions` appended; a full URL is used as-is; responses may be `{text}`, `[{text}]`, `{segments:[{text}]}` or plain text |
| `CHAT_LOCAL_IMAGE_PARSER` | `vision` (follow the model, default) / `openai` / `deepseek`: how images are parsed. When the model rejects an image it falls back to OCR |
| `CHAT_LOCAL_DOC_PARSER` | `python` (default) / `deepseek`: how documents are parsed. `python` extracts the text layer of PDF/docx/pptx locally; if nothing comes out (scans), it falls back to DeepSeek OCR when configured |
| `OCR_OPENAI_BASE_URL` / `OCR_OPENAI_API_KEY` / `OCR_OPENAI_MODEL` | Used when images are set to `openai`; images only, a root URL gets `/v1/chat/completions` |
| `OCR_DEEPSEEK_BASE_URL` / `OCR_DEEPSEEK_API_KEY` / `OCR_DEEPSEEK_MODEL` | Used when images or documents are set to `deepseek`; an empty URL means `https://api.deepseek.com` |
| `TTS_PROVIDER` | `none` / `deepseek` / `openai` / `engine` / `template`; no read-aloud button unless it is set |
| `TTS_BASE_URL` / `TTS_API_KEY` / `TTS_MODEL` | Read-aloud endpoint. With `deepseek` the base URL can be omitted and `DEEPSEEK_API_KEY` is reused; `openai` means the OpenAI-compatible `/v1/audio/speech`, so self-hosted engines point at their own address (default model name `tts-1`). A base URL that already carries a path — for example `http://host:8090/api/tts/speech` — is requested as-is instead of having the standard path appended |
| `TTS_VOICE` | Voice name; leave empty for the service default (DeepSeek: `stella`; OpenAI: `alloy`) |
| `TTS_RESPONSE_FORMAT` | `wav` (default) / `mp3` / `opus` / `pcm`; only applies to the OpenAI-compatible path |
| `TTS_MAX_CHARS` | Character budget per synthesis request (4000 by default); longer replies are split at sentence boundaries and synthesized segment by segment |
| `TTS_TEMPLATE_URL` / `_BODY` / `_AUDIO` / `_HEADERS` | `template` only: exact endpoint URL, JSON body template, how to extract audio (`body` / `base64:<field>` / `url:<field>`), extra request headers |
| `SEARCH_PROVIDER` | `none` / `tavily` / `anysearch` / `searxng` |
| `SEARCH_BASE_URL` / `SEARCH_API_KEY` / `SEARCH_RESULTS` | Web search. `SEARCH_BASE_URL` is optional for Tavily (`https://api.tavily.com`) and AnySearch (`https://api.anysearch.com`), but required for SearXNG. Tavily requires a key; AnySearch keys may be empty (anonymous rate limits). `SEARCH_RESULTS` ranges from 1 to 12 (default 6) and is editable in the wizard |
| `RERANK_PROVIDER` / `RERANK_BASE_URL` / `RERANK_API_KEY` / `RERANK_MODEL` / `RERANK_TIMEOUT` | Optional rerank endpoint — for example `llama-server --reranking` or HuggingFace text-embeddings-inference. A root URL or any URL ending in `/v1` gets `/v1/rerank` appended, a full URL (TEI's `/rerank`) is used as-is; both `{"results":[...]}` and a top-level `[{index,score}]` array are accepted. Shared by SearXNG search aggregation and advanced memory retrieval; see [docs/search.md](docs/search.md) and [docs/context.md](docs/context.md) |
| `EMBEDDING_PROVIDER` / `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` | Optional embedding endpoint (OpenAI-compatible `/v1/embeddings`) used only by advanced memory retrieval. `EMBEDDING_DIM` must match the model (1024 for Qwen3-Embedding-0.6B); changing the model or dimension re-embeds everything. If unconfigured or failing, retrieval falls back to local scoring. Advanced retrieval adds one embedding request per turn, plus one rerank request when configured (roughly 1–2 s measured locally). |
| `SEARCH_CANDIDATE_TARGET` / `SEARCH_CANDIDATE_MAX` / `SEARCH_MAX_PAGES` / `SEARCH_SNIPPET_CHARS` | SearXNG aggregation tuning (20 / 60 / 5 / 500 by default) |
| `SEARCH_ALLOWED_DOMAINS` / `SEARCH_BLOCKED_DOMAINS` | Comma-separated site rules. `example.com` also covers its subdomains; `example.com/docs` additionally restricts the path prefix |
| `CHAT_LOCAL_IMAGE_MODE` | Legacy, migration only: when `CHAT_LOCAL_IMAGE_PARSER` is absent, `ocr` maps to the old OCR service and anything else means `vision`. Use `CHAT_LOCAL_IMAGE_PARSER` for new setups |

Unconfigured capabilities are hidden in the UI (for example, no ASR means no microphone button), so users do not hit buttons that are guaranteed to fail.

### More detail

- Two copy-paste configuration examples, plus interface compatibility notes for read-aloud / ASR / attachment parsing / rerank: [docs/providers.md](docs/providers.md)
- SearXNG result quality, the rerank switch, paging aggregation and measured timings: [docs/search.md](docs/search.md)

## Features

### Per-capability self-hosted configuration

LLM, search, ASR and attachment parsing are configured independently:

- **LLM:** model name, base URL, API key, context limit, and max output are yours to set; the protocol is either Anthropic-compatible (for example, DeepSeek's `/anthropic` endpoint) or OpenAI-compatible (Ollama, LM Studio, vLLM, hosted APIs).
- **ASR:** DeepSeek `/v1/tools/asr` or an OpenAI-compatible `/v1/audio/transcriptions` endpoint.
- **Attachment parsing:** images can follow the model, an OpenAI-compatible OCR, or DeepSeek; documents can use local Python text extraction or DeepSeek OCR. Python extraction reads the text layer of PDF/docx/pptx locally; scans fall back to DeepSeek OCR when configured.
- **Search:** Tavily, AnySearch, SearXNG, or off. With SearXNG you can add your own reranker to enable multi-page aggregation and relevance ordering; without one, search stays single-page.
- Unconfigured capabilities are hidden automatically.

### Conversations and data

- **Local storage:** FastAPI + SQLite store chats, workspaces and attachments in `data/chat.db` and `data/files/`.
- **Workspaces:** create, rename and delete them in Settings → Workspaces. Filter the sidebar by workspace; new chats started there belong to it automatically. Move chats from the session menu. Unassigned chats appear in the fixed “Unassigned workspace” item. Deleting a workspace moves its chats there and never deletes them.
- **History import/export:** import the official DeepSeek ZIP export (`export_format_version: 3`) using replace, merge-skip-duplicates, or merge-as-copy; optionally discard tool records or image files on import. ZIP files contain chats and attachments only, not workspaces or role cards; imported chats appear in “Unassigned workspace”.
- **Chat search:** search message text from the sidebar; results are grouped by chat with matching snippets. Archived chats are excluded.
- **Archive and restore:** archive from the session menu; open, restore, or permanently delete archived chats under Settings → Data management → View archive.
- **Chat cleanup:** delete chats older than N years/months or inside a date range; remove tool-call records and image originals from all chats.

### Context and tools (self-hosted only)

- **Context management:** usage indicator, local compression, and configurable context/output limits. Cloud mode only shows usage; its limit is fixed by DeepSeek.
- **Auto-generated titles:** optional and off by default. After the first reply, the local backend makes one extra model request using the first visible user/assistant turn. Cloud mode keeps DeepSeek's built-in title.
- **Tool rounds:** adjust the maximum number of web-tool rounds per answer. In cloud mode DeepSeek controls this server-side, and the client does not send the parameter.
- **Tool switches:** once search is configured, link reading is always declared (whether a body can actually be fetched still depends on the provider); the search toggle only controls web search and in-page find (the latter also needs thinking). If the model calls a tool that is disabled for the round, that call is skipped and the reply continues instead of being aborted.
- **Long-term memory (self-hosted only, off by default):** Settings → Memory. Memories live in the local `chat.db`; entries are injected using one of three modes (pinned+recent, local keywords, or embeddings with optional rerank), the model can search them and propose new or edited entries, a proposal only takes effect after you confirm it, each entry can carry a short matching description, and near-duplicates can be merged by hand. Export to txt and import txt/JSON (duplicates are skipped). Automatic conversation summaries are not implemented yet. Injection rules, switches and caps: [docs/context.md](docs/context.md).

- **Prompts (role cards):** Settings → Prompts. Named cards with exactly one active globally; the body is appended after the built-in rules. Up to 30 cards and 8000 characters each, stored in `data/prompts.json`. Self-hosted mode can bind a different card to each workspace, with priority “workspace card → global card”; unbound workspaces, legacy chats and missing cards fall back to the global card. Cloud mode can organize chats into workspaces but does not bind role cards.

### UI and configuration

- **First-run wizard:** choose DeepSeek Cloud or a custom backend first; Cloud finishes as soon as the key is saved and jumps to data management. Custom goes through model → optional features (search, attachment parsing, voice, rerank and embeddings), and every later step can be skipped; rerank, embedding and read-aloud live in that flow. Saving takes effect immediately, and you can reopen it from Settings → General.
- **Capability detection:** unconfigured search, ASR, and similar entries are hidden automatically.
- **Usage statistics:** Settings → Usage. Totals for requests, input / cache-read / output tokens, cache hit rate and estimated cost over 7 / 30 / 90 days, broken down by model; unit prices are per million tokens and 0 means free. Chat requests only, stored in the local `chat.db`; self-hosted requests are recorded by the backend across all tool rounds, while cloud requests are reported by the client and queued for retry on failure.
- **Debug panel:** click the sidebar title five times within 1.5 s. Status shows configuration and vector coverage per service, plus the active prompt card and its length, the memory similarity threshold, the enabled search engine count and the read-aloud voice; Logs shows the last 800 backend lines including request timings; Probes make one real request to LLM / Embedding / Rerank / Search / memory retrieval / speech input / read-aloud and report result and latency.
- **UI fixes:** dark-mode select menus, session menu positioning, cleanup statistics, and related issues.
- **Streaming performance work:** the active chat subscribes separately so every token does not rerender the whole app; context estimates are throttled to roughly 250 ms; long messages and session lists use browser deferred rendering; incomplete code, math and diagrams are highlighted only after closing or stopping; attachment originals are cached by file ID, URLs still in use are retained, and the idle cache is bounded. This reduces long-chat jank but cannot guarantee smooth performance on every device.

## Capability matrix

| Capability | DeepSeek Cloud | Self-hosted backend |
|---|---|---|
| Chat / thinking / stop / continue | DeepSeek API | Anthropic- or OpenAI-compatible endpoint |
| Web search and page reading | DeepSeek server-side tools; the tools themselves are not billed | Your configured search provider |
| Voice input | DeepSeek `/v1/tools/asr` | `deepseek` or OpenAI-compatible ASR |
| Read-aloud | DeepSeek `/v1/tools/tts` | `deepseek` or OpenAI-compatible `/v1/audio/speech` |
| Images | Sent directly to DeepSeek | Follow the model / OpenAI-compatible OCR / DeepSeek |
| PDF / Word / PPT | DeepSeek Files API | Python text extraction / DeepSeek OCR |

Self-hosted read-aloud supports four request shapes (`openai` / `deepseek` / `engine` / `template`) covering common self-hosted TTS servers; the shape table, the four `template` settings and what is explicitly out of scope (e.g. ComfyUI async workflows) are in [docs/providers.md](docs/providers.md#the-four-read-aloud-request-shapes).

## Limitations

- This project has not been broadly tested; see Project status above.
- OpenAI-compatible OCR handles images only; PDF/Word/PPT are parsed locally by default, scans need DeepSeek OCR, and legacy `.doc` files should be saved as `.docx`.
- Import/export currently supports only the DeepSeek export format.
- Read-aloud has not been verified by listening on either path; whether self-hosted read-aloud works depends on your service actually implementing `/v1/audio/speech`.
- Usage statistics cover chat requests only; title generation, attachment parsing, embeddings and rerank are excluded, and unit prices are estimates rather than your provider's bill.
- The two known SearXNG pitfalls (Brave jump links, upstream engine rate limits) are documented in [docs/search.md](docs/search.md#two-known-sources-of-dirty-data).

## Security and privacy

- The server listens on `127.0.0.1` by default; write endpoints require the `X-Chat-Local: 1` header.
- Chats and attachments live in local `data/`, independent of a DeepSeek account or cloud conversation sync. Cloud mode still sends conversation content to the DeepSeek API; only self-hosted mode keeps inference on the model endpoint you configure.
- When web search, ASR or attachment parsing is enabled, the corresponding content is sent to the provider you chose. Disable anything you do not need.
- When reading a page through SearXNG in self-hosted mode, loopback, private and reserved addresses (including redirect targets) are rejected, and the body size per page is capped. Tavily and AnySearch extract content on their own servers instead.
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
