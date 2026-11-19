# SearXNG 与重排

## SearXNG 的结果质量与重排开关

SearXNG 本身只是把各家引擎的标题和摘要聚合起来，它不做相关性排序，返回顺序取决于哪家引擎先给出结果。因此分两种行为：

**没配重排（默认）**：只取一页，把前 `SEARCH_RESULTS` 条交给模型，其余一切不变。

**配了重排**（填 `RERANK_BASE_URL`，或在首次运行向导里填重排的 Base URL）：

- 用 `pageno` 最多翻 `SEARCH_MAX_PAGES` 页，去重后攒够 `SEARCH_CANDIDATE_TARGET` 条候选就停（默认攒 20 条、最多 5 页）；
- 候选全部送进重排模型打分——所谓重排模型（cross-encoder）就是把"问题 + 一条摘要"一起喂进模型，它输出这条摘要的相关性分数——最后只把最相关的 `SEARCH_RESULTS` 条交给模型；
- 送排的候选数封顶在 `SEARCH_CANDIDATE_MAX`。同一页已经请求回来的结果不会被中途丢掉：有的引擎单页就有 40 多条，只留 20 条等于白丢，而多打分的开销很小。

两点需要说明：

- **就绪状态是探测出来的，不是假设的。** 每次搜索前，后端会拿两条空占位文本请求一次 `/v1/rerank`。请求失败（接口没起、模型没启动、或根本没填配置）就不翻页，行为和没配重排完全一致。失败的探测结果缓存 60 秒，避免重排模型停着的时候每次搜索都白等一次；搜索中途重排报错也不会让搜索失败，直接返回未排序的结果。
- **耗时。** 本机 `llama-server --reranking` + `bge-reranker-v2-m3` 实测：给 20 条候选打分约 0.5 秒（每条 24–26 毫秒，冷启动首次约 2.6 秒）。翻页聚合多花的时间主要出在 SearXNG 本身，不是重排。

`SEARCH_ALLOWED_DOMAINS` / `SEARCH_BLOCKED_DOMAINS` 两条路都生效，模型也能在单次搜索里自己传 `allowed_domains` / `blocked_domains`。走 SearXNG 时，规则在计数之前逐页过滤；走 Tavily 或 AnySearch 时只能过滤已经返回的那一份，白名单卡得紧时结果会少于预期条数。

不想看排序后的前 N 条、想要引擎原始顺序，把 `RERANK_PROVIDER=none` 即可。

## 已知的两类脏数据

- SearXNG 这一路，Brave 的结果常是 `http:///go/v1/<token>` 跳转链：实例本地没有 `/go` 路由（跟随重定向只到一个中间页），真实地址是从这条结果缩略图代理串的 base64 尾巴解出来的；解出来是图片而不是页面的，宁可丢弃也不会当来源链接交给模型。因此整批由 Brave 命中的查询，返回条数可能少于 `SEARCH_RESULTS`。
- SearXNG 会被上游引擎限流：请求够多就某个引擎被暂停，JSON 响应里的 `unresponsive_engines` 会写明原因（如 `Suspended: too many requests`、`CAPTCHA`），此时整个查询可能返回 0 条，要等它自己恢复。判断依据看这个字段，别只看结果条数。
