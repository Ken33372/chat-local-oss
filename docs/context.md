# Context injection: what goes into a request

This document describes what the self-hosted backend adds to the model context before each request, where it is placed, which switches control it, and what is not implemented yet. Cloud mode (the browser talks to DeepSeek directly) bypasses the local backend, so none of this applies there.

## Two slots

| Slot | Contents | Why |
|---|---|---|
| System prefix | Built-in rules, date reminder, compression summary, web-tool instructions | Stable within a conversation, so the engine's prefix cache can be reused |
| Inside the latest user message (tail) | Long-term memory, confirmation receipt | Changes per question; placing it in the tail invalidates only the current turn, leaving the system prefix and earlier history cached |

The memory block is prepended to the latest user message at send time, behind a marker line: "【系统自动附加，不是用户说的话】" (attached automatically by the system, not something the user said). The stored message stays clean and the UI never shows this text; only the request sent to the model is affected.

Why not in the system prompt: the prefix cache matches only an identical prefix from the very start. A per-turn memory block in the system prompt invalidates everything after it — summary, rules and the whole history — so long conversations would be re-encoded every turn.

## What is in the system prompt now

Fixed order:

1. Built-in identity line (`DEFAULT_SYSTEM`)
2. Current-date reminder
3. Prompt card (only when one is selected)
4. Compression summary of earlier turns (if compression has run)
5. Web-tool instructions (when search is on, including the citation rule)
6. Fixed rules: answer in the user's language; report attachment failures honestly

## Prompts (role cards)

Settings → Prompts. Either no card or exactly one active card. There is no separate free-text field: to tweak the persona, create another card.

- Card fields: name (≤40 chars), description (≤200, optional), body (≤8000); up to 30 cards, names must be unique
- One card is active globally for every chat; switching or editing applies to the next request immediately
- The body is appended after the built-in identity and date, before the summary and web-tool rules; it **cannot override built-in rules**
- Stored in `data/prompts.json`, separate from `config.json`, so the setup wizard never overwrites it
- Cloud mode bypasses the local backend; the settings page only shows a notice

Prefix cache: the card is fixed text, stable within a conversation; it invalidates the prefix once when you switch or edit it.

## What goes into the tail

Long-term memory block (when memory is enabled and injection is on):

```
【系统自动附加，不是用户说的话】
以下是我对用户的长期记忆，可能过时，与本轮无关就忽略：
- ...
```

When the user accepts or rejects a memory the model proposed, the next request in that conversation appends a one-time receipt to the same block:

```
用户在设置里处理了你之前提议的记忆：
- 已确认：...（已存入长期记忆）
- 已忽略：...（不要再重复提交这一条）
```

For edit proposals the receipt reads "已确认修改：「old」改为「new」" or "已忽略修改：「old」保持不变".

The receipt is delivered once per proposal, then marked as notified.

## Long-term memory

### Switches (Settings → Memory, off by default)

| Setting | Values | Default |
|---|---|---|
| Enable long-term memory | on / off | off |
| Injection mode | pinned + recent / relevance (local keywords) / advanced (embeddings, optional rerank) / off | pinned + recent |
| Memory search mode | keywords / relevance (local scoring) / advanced (embeddings, optional rerank) | relevance (local scoring) |
| Injected items | 1–10 | 5 |
| Allow model search and proposals | on / off | on |
| Write mode | propose for confirmation / block model writes | propose |

Environment variables: `CHAT_LOCAL_MEMORY`, `CHAT_LOCAL_MEMORY_INJECT_MODE`, `CHAT_LOCAL_MEMORY_SEARCH_MODE`, `CHAT_LOCAL_MEMORY_COUNT`, `CHAT_LOCAL_MEMORY_TOOLS`, `CHAT_LOCAL_MEMORY_WRITE`, `CHAT_LOCAL_MEMORY_SIM_THRESHOLD` (minimum cosine for embedding injection, default 0.42) (env wins over `data/config.json`).

### Selection

Pinned entries are always kept (up to the slot count); the rest are chosen by the injection mode:

| Mode | How the remaining slots are filled | Requires |
|---|---|---|
| Pinned + recent | Most recently updated first | Nothing |
| Relevance (local keywords) | Word/character overlap with the latest user message; description hits count double, body hits single | Nothing |
| Advanced (embeddings) | Description and body are embedded together and ranked by cosine, optionally re-sorted by rerank | `EMBEDDING_*`; rerank optional |

Keyword mode keeps only entries with a literal hit; embedding mode keeps only entries with cosine ≥ the threshold (default 0.42, adjustable via `CHAT_LOCAL_MEMORY_SIM_THRESHOLD`). Fewer hits means fewer items; with no hits only pinned entries remain — possibly none — and there is no fallback to most-recent filling. Stored in the local `chat.db` (`memories` table).

### Tools

| Tool | Behaviour |
|---|---|
| `search_memory(query)` | Searches only items **not injected this turn**, returns at most 5; ranking follows the memory search mode and can use rerank |
| `remember(text, description?, pinned?)` | Never writes directly; creates a pending proposal; the description is optional but the tool asks for 5–15 characters |
| `edit_memory(original, text, description?, pinned?)` | Never edits in place; creates a pending "old → new" proposal. `original` should match the stored text (a close match is accepted; ambiguity asks for `search_memory` first) |

### Embeddings and rerank

- Embedding endpoint: OpenAI-compatible `/v1/embeddings`, configured via `EMBEDDING_PROVIDER` / `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` / `EMBEDDING_DIM`
- **Dimension is required and must match the model** (1024 for Qwen3-Embedding-0.6B); changing the model or dimension re-embeds everything into `memory_vectors`
- Rerank reuses `RERANK_*` and only runs when configured
- On failure (service down, dimension mismatch, timeout) retrieval falls back to local scoring and the last error is shown at the top of Settings → Memory
- Cost: one embedding request per turn in advanced mode (about 0.3 s measured; identical text is cached), plus one rerank request when configured (about 1 s)

Server-side guards for `remember` / `edit_memory`:

- Body over 300 characters, or description over 30
- ≥ 80% character overlap with an existing memory (the edited entry itself is excluded)
- The same entry already has a pending edit
- More than 20 proposals in one day (adds and edits share the quota)
- **Any web tool was used in the same turn** (`web_search` / `read_url` / `find_in_page`)

### Confirmation and visibility

- Accept or ignore proposals in Settings → Memory; a banner above the composer shows the pending count
- Edit proposals show the old text (struck through) above the new text; accepting replaces in place, ignoring keeps the original
- Accepted proposals become normal memories and join the injection pool
- Memory tool calls appear as a single line in the reply's step list: injected N memories / searched memory, found N / queued 1 memory / memory not written
- Export to txt, import txt/JSON; duplicates, oversized and over-cap entries are skipped
- txt export writes `- body` per item and, when present, an indented `  说明：…` line; JSON items accept a `description` field
- Caps: 300 characters for the body, 30 for the description, 200 memories total (manual, imported and model-proposed alike)

### Manual tidy

Settings → Memory → Tidy. Finds near-duplicates by literal similarity: ≥80% for short entries, ≥60% for longer ones, at most 20 pairs. Keep one, delete the other; pinned state is merged. Suggestions only, nothing is changed automatically.

## Context usage and compression

- The composer shows an estimated usage; the limit comes from `LLM_CONTEXT_LIMIT` (default 131072), output from `LLM_MAX_OUTPUT_TOKENS`
- In local mode a Compress button appears at about 60% usage: earlier turns are summarised, the last 4 messages stay, originals are kept, and later requests use "summary + last 4"
- Compression is manual; automatic compression is not implemented

## Not implemented yet

| Item | Direction |
|---|---|
| Per-session override | Pick a card (or turn prompts off) for one chat without changing the global choice |
| Card extras | Greeting and avatar; the first version has name/description/body only |
| Cross-conversation summary cards | One short card per active conversation, injected into the tail slot |
| Vector recall for summaries | Embed summary cards, recall 2–3 per question, also in the tail slot (vector selection for memories themselves already ships) |
| Advanced tidying | Drop stale items and flag conflicts; duplicate merging already ships (manual) |

## Troubleshooting

| Symptom | Check first |
|---|---|
| Model does not know a memory | Master switch, injection mode, and whether the item falls outside the injected count |
| Model still says "waiting for confirmation" | The receipt only goes to the original conversation and only once |
| Model treats a memory as something the user said | Expected but should be contained: the latest user message should carry the "attached automatically by the system" marker; if it is missing, request assembly is wrong |
| Memory missing in cloud mode | By design: cloud mode bypasses the local backend |
| Model ignores the persona | Check whether a card is active; its body should describe style only, not "ignore the rules above" |
