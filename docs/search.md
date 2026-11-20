# SearXNG and reranking

> The same `RERANK_*` settings are reused by advanced memory retrieval (when configured, vector candidates get a second ranking pass); see [context.md](context.md) for the memory side and its fallbacks.

## SearXNG result quality and the rerank switch

SearXNG only aggregates titles and snippets from other engines — it does no relevance ranking of its own, and a ranked answer depends on which engine returned a page first. So the behaviour splits in two:

**No reranker configured (default).** One page is fetched and the top `SEARCH_RESULTS` items are handed to the model. Nothing else changes.

**Reranker configured** (`RERANK_BASE_URL` filled, or the rerank fields completed in the first-run wizard):

- up to `SEARCH_MAX_PAGES` pages are fetched with `pageno`, stopping once `SEARCH_CANDIDATE_TARGET` de-duplicated candidates are collected (default: 20 items, max 5 pages);
- every candidate is scored by the reranker (a cross-encoder: the query and one snippet are fed through the model together and it outputs a relevance score) and only the most relevant `SEARCH_RESULTS` reach the model;
- the candidate list is capped at `SEARCH_CANDIDATE_MAX` so a page that was already fetched is never partially discarded — an engine often returns more items than the target on a single page, and dropping them would be pure waste.

Two details worth knowing:

- **Availability is probed, not assumed.** Before the first search the backend sends two dummy snippets to `/v1/rerank`. If that fails — endpoint unreachable, model not started, fields left empty — pagination stays off and you get exactly the default single-page behaviour. A failed probe is cached for 60 seconds, so a stopped reranker does not slow down every search. If the reranker dies mid-search, the un-reranked results are returned as-is rather than failing the request.
- **Cost.** On a local `llama-server --reranking` with `bge-reranker-v2-m3`, scoring 20 candidates measured about 0.5 seconds (24–26 ms per snippet; ~2.6 s on a cold model). The extra time from paginating comes from SearXNG itself, not the reranker.

`SEARCH_ALLOWED_DOMAINS` / `SEARCH_BLOCKED_DOMAINS` apply to both paths, and the model can also pass `allowed_domains` / `blocked_domains` per search call. With SearXNG the rules filter every page before candidates are counted; with Tavily and AnySearch they can only filter the list that was already returned, so a strict allowlist may yield fewer results than asked for.

If you would rather see raw engine output than a reranked top-N, set `RERANK_PROVIDER=none`.

## Two known sources of dirty data

- With SearXNG, Brave results often arrive as `http:///go/v1/<token>` jump links. The instance has no local `/go` route, so the target is recovered from the base64 tail of that result's thumbnail proxy path; when that decodes to an image rather than a page, the item is dropped instead of being cited with a bad link. A query served entirely by Brave can therefore return fewer items than `SEARCH_RESULTS`.
- SearXNG rate-limits its upstream engines: after enough requests an engine is suspended (`unresponsive_engines` in the JSON response says which and why, e.g. `Suspended: too many requests`, `CAPTCHA`) and the whole query can return zero results until it recovers. Judge by that field, not by the result count alone.
