# Context injection: what goes into a request

This document describes what the self-hosted backend adds to the model context before each request, where it is placed, which switches control it, and what is not implemented yet. Cloud mode (the browser talks to DeepSeek directly) bypasses the local backend, so none of this applies there.

## Two slots

| Slot | Contents | Why |
|---|---|---|
| System prefix | Built-in rules, long-term memory, compression summary, web-tool instructions | Stable within a conversation, so the engine's prefix cache can be reused |
| Before the latest user message (tail) | Content recalled per question | May change every turn; changing the tail re-encodes only the tail |

Only the prefix is used today; the tail slot is reserved for future per-question recall.

## What is in the system prompt now

Fixed order:

1. Built-in identity line (`DEFAULT_SYSTEM`)
2. Current-date reminder
3. Long-term memory block (when memory is enabled and injection is on)
4. Compression summary of earlier turns (if compression has run)
5. Web-tool instructions (when search is on, including the citation rule)
6. Fixed rules: answer in the user's language; report attachment failures honestly

Memory block format:

```
以下是我对用户的长期记忆，可能过时，与本轮无关就忽略：
- ...
```

When the user accepts or rejects a memory the model proposed, the next request in that conversation appends a one-time receipt:

```
用户在设置里处理了你之前提议的记忆：
- 已确认：...（已存入长期记忆）
- 已忽略：...（不要再重复提交这一条）
```

The receipt is delivered once per proposal, then marked as notified.

## Long-term memory

### Switches (Settings → Memory, off by default)

| Setting | Values | Default |
|---|---|---|
| Enable long-term memory | on / off | off |
| Auto-inject | pinned + recent / off | pinned + recent |
| Injected items | 1–10 | 5 |
| Allow model search and proposals | on / off | on |
| Write mode | propose for confirmation / block model writes | propose |

Environment variables: `CHAT_LOCAL_MEMORY`, `CHAT_LOCAL_MEMORY_INJECT`, `CHAT_LOCAL_MEMORY_COUNT`, `CHAT_LOCAL_MEMORY_TOOLS`, `CHAT_LOCAL_MEMORY_WRITE` (env wins over `data/config.json`).

### Selection

Pinned first, then most recently updated, up to the configured count. Stored in the local `chat.db` (`memories` table).

### Tools

| Tool | Behaviour |
|---|---|
| `search_memory(query)` | Searches only items **not injected this turn**, returns at most 5 |
| `remember(text, pinned?)` | Never writes directly; creates a pending proposal |

Server-side guards for `remember`:

- More than 300 characters
- ≥ 80% character overlap with an existing memory
- More than 20 proposals in one day
- **Any web tool was used in the same turn** (`web_search` / `read_url` / `find_in_page`)

### Confirmation and visibility

- Accept or ignore proposals in Settings → Memory; a banner above the composer shows the pending count
- Accepted proposals become normal memories and join the injection pool
- Memory tool calls appear as a single line in the reply's step list: injected N memories / searched memory, found N / queued 1 memory / memory not written
- Export to txt, import txt/JSON; duplicates, oversized and over-cap entries are skipped
- Caps: 300 characters each, 200 memories total (manual, imported and model-proposed alike)

## Context usage and compression

- The composer shows an estimated usage; the limit comes from `LLM_CONTEXT_LIMIT` (default 131072), output from `LLM_MAX_OUTPUT_TOKENS`
- In local mode a Compress button appears at about 60% usage: earlier turns are summarised, the last 4 messages stay, originals are kept, and later requests use "summary + last 4"
- Compression is manual; automatic compression is not implemented

## Not implemented yet

| Item | Direction |
|---|---|
| Custom system prompt | Global default plus per-session override, appended rather than replacing built-in rules |
| Persona cards | Named presets with name/avatar/greeting, essentially reusable system presets |
| Cross-conversation summary cards | One short card per active conversation, injected into the tail slot |
| Vector recall | Embed memories/summaries, recall 2–3 per question, also in the tail slot |
| Memory tidying | Merge duplicates, drop stale items, flag conflicts; suggestions only |

## Troubleshooting

| Symptom | Check first |
|---|---|
| Model does not know a memory | Master switch, injection mode, and whether the item falls outside the injected count |
| Model still says "waiting for confirmation" | The receipt only goes to the original conversation and only once |
| Model cannot write a memory | Write mode, whether web tools were used this turn, duplicate check |
| Memory missing in cloud mode | By design: cloud mode bypasses the local backend |
