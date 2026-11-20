"""联网搜索与网页正文提取。

provider：
- tavily    POST {base}/search（key 可空，走 keyless 限流）
- anysearch POST {base}/v1/search（key 可空）
- searxng   GET  {base}/search?format=json（自建，无 key）
- none      关闭

三条路都给结果做同一套清洗：剥高亮标签、解 HTML 实体、折空白、按字数截断，并丢掉拿不到可用链接的条目。
SearXNG 只出标题和摘要（它没有正文提取接口），所以这一路额外做两件事：
翻页聚合去重（最多 SEARCH_MAX_PAGES 页，攒够 SEARCH_CANDIDATE_TARGET 条），
以及交给用户自配的 /v1/rerank 接口排序。没配重排就不翻页——
一堆没人排序的候选全塞进上下文，只会挤掉真正有用的部分。
Brave 经 SearXNG 吐出的 /go/ 跳转链会从缩略图代理串里还原原站地址，还原不出来的（解出一张图片）丢弃，
不把它当来源链接交给模型。
"""
from __future__ import annotations

import base64
import re
import time
from html.parser import HTMLParser
from urllib.parse import urlsplit

import config
from providers import rerank as rerank_provider
from providers.common import ProviderError, client, detail, join

DEFAULT_BASES = {
    "tavily": "https://api.tavily.com",
    "anysearch": "https://api.anysearch.com",
}

def _provider() -> str:
    return config.SEARCH_PROVIDER


def is_searxng() -> bool:
    """这一轮搜索实际走的是 searxng 吗？上层据此决定加不加聚合器特有的纪律提示。"""
    return _provider() == "searxng"


def _web(url: object) -> bool:
    """必须是带域名的 http(s) 链接；SearXNG 偶尔吐出 http:///go/v1/… 这种畸形串。"""
    if not isinstance(url, str):
        return False
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(parts.netloc)


_B64_TAIL_RE = re.compile(r"g:ce/([A-Za-z0-9+/=]+)")
_ASSET_RE = re.compile(
    r"\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|css|js|mp4|mp3|pdf|zip)(\?|#|$)", re.I
)


def _thumb_origin(item: dict) -> str:
    """Brave 的结果经 SearXNG 吐出时可能是 http:///go/v1/<token> 跳转链，本机解不开
    （跟随重定向只到一个中间页）。同一条结果的缩略图走 brave 的图片代理，路径尾巴是"被代理资源"
    的 base64：图标类结果解出来就是本页地址，可用；og:image 类解出来是一张图片，不能当来源链接。"""
    for key in ("thumbnail", "img_src"):
        match = _B64_TAIL_RE.search(str(item.get(key) or ""))
        if not match:
            continue
        blob = match.group(1).replace("/", "")
        try:
            origin = base64.b64decode(blob + "=" * (-len(blob) % 4)).decode("utf-8")
        except Exception:
            continue
        if _web(origin) and not _ASSET_RE.search(urlsplit(origin.strip()).path or ""):
            return origin.strip()
    return ""


def _result_link(item: dict) -> str:
    """取可用链接：正常用 url，畸形跳转链退回缩略图里解出的原站地址；解不出就返回空（丢弃该条）。"""
    link = str(item.get("url") or "").strip()
    return link if _web(link) else _thumb_origin(item)


def _base() -> str:
    return config.SEARCH_BASE_URL or DEFAULT_BASES.get(config.SEARCH_PROVIDER, "")


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {config.SEARCH_API_KEY}"} if config.SEARCH_API_KEY else {}


def _available() -> bool:
    if config.SEARCH_PROVIDER == "tavily":
        return bool(config.SEARCH_API_KEY)
    if config.SEARCH_PROVIDER == "anysearch":
        return True
    return config.SEARCH_PROVIDER == "searxng" and bool(config.SEARCH_BASE_URL)


# ---------------- 结果清洗与域名规则 ----------------

_TAG_RE = re.compile(r"<[^>]*>")
_WS_RE = re.compile(r"\s+")
_ENTITY_RE = re.compile(r"&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);")
_NAMED_ENTITIES = {
    "amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": " ",
    "hellip": "…", "mdash": "—", "ndash": "–", "lsquo": "‘", "rsquo": "’",
    "ldquo": "“", "rdquo": "”", "middot": "·", "bull": "•", "times": "×",
    "minus": "−", "deg": "°", "euro": "€", "pound": "£", "yen": "¥", "copy": "©",
    "reg": "®", "trade": "™",
}


def _decode_entities(text: str) -> str:
    def replace(match: re.Match) -> str:
        entity = match.group(1)
        if entity[0] == "#":
            base = 16 if entity[1] in "xX" else 10
            try:
                return chr(int(entity[2:] if base == 16 else entity[1:], base))
            except (ValueError, OverflowError):
                return match.group(0)
        return _NAMED_ENTITIES.get(entity.lower(), match.group(0))

    return _ENTITY_RE.sub(replace, text)


def clean_text(value: object, max_chars: int | None = None) -> str:
    """先剥标签再解实体：反过来的话，实体解码可能把 &lt;b&gt; 这类文本还原成真标签再被误读。"""
    text = _decode_entities(_TAG_RE.sub(" ", str(value or "")))
    text = _WS_RE.sub(" ", text).strip()
    if max_chars and len(text) > max_chars:
        return f"{text[:max_chars].rstrip()}…"
    return text


def _dedupe_key(url: str) -> str:
    parts = urlsplit(url.strip())
    return f"{parts.netloc.lower()}{(parts.path or '/').rstrip('/') or '/'}?{parts.query}"


def _domain_match(url: str, rule: str) -> bool:
    """规则写 example.com 连子域一起算；写 example.com/docs 再限定路径前缀。"""
    rule = rule.strip().lower().lstrip(".")
    if not rule:
        return False
    name, _, path_rule = rule.partition("/")
    host = (urlsplit(url).hostname or "").lower()
    if host != name and not host.endswith(f".{name}"):
        return False
    if not path_rule:
        return True
    return (urlsplit(url).path or "").lower().startswith(f"/{path_rule.strip('/')}")


def _filter_domains(results: list[dict], allow: list[str], block: list[str]) -> list[dict]:
    allow = [rule for rule in (allow or []) if str(rule).strip()]
    block = [rule for rule in (block or []) if str(rule).strip()]
    if not allow and not block:
        return results
    kept: list[dict] = []
    for item in results:
        url = item["url"]
        if block and any(_domain_match(url, rule) for rule in block):
            continue
        if allow and not any(_domain_match(url, rule) for rule in allow):
            continue
        kept.append(item)
    return kept


def _rules(allowed: list[str] | None, blocked: list[str] | None) -> tuple[list[str], list[str]]:
    return (
        [*(allowed or []), *config.SEARCH_ALLOWED_DOMAINS],
        [*(blocked or []), *config.SEARCH_BLOCKED_DOMAINS],
    )


def _clean_results(items: list, proxied: bool = False) -> list[dict]:
    results: list[dict] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        # SearXNG 的 brave 结果可能是 /go/ 跳转链，只有这一路需要还原原站地址
        url = _result_link(item) if proxied else str(item.get("url") or "").strip()
        if not _web(url):
            continue
        results.append(
            {
                "title": clean_text(item.get("title"), 200) or url,
                "url": url,
                "snippet": clean_text(
                    item.get("content") or item.get("snippet"), config.SEARCH_SNIPPET_CHARS
                ),
            }
        )
    return results


# ---------------- tavily / anysearch ----------------


def _search_tavily(query: str, limit: int, allow: list[str], block: list[str]) -> list[dict]:
    with client(60) as http:
        response = http.post(
            join(_base(), "/search"),
            json={
                "query": query,
                "max_results": limit,
                "include_answer": False,
                "include_raw_content": False,
            },
            headers=_auth(),
        )
    if response.status_code != 200:
        raise ProviderError(f"Tavily 返回 {response.status_code}：{detail(response)}")
    body = response.json()
    results = _filter_domains(_clean_results(body.get("results") if isinstance(body, dict) else []), allow, block)
    return results[:limit]


def _search_anysearch(query: str, limit: int, allow: list[str], block: list[str]) -> list[dict]:
    with client(90) as http:
        response = http.post(
            join(_base(), "/v1/search"),
            json={"query": query, "max_results": max(1, min(10, limit))},
            headers=_auth(),
        )
    if response.status_code != 200:
        raise ProviderError(f"AnySearch 返回 {response.status_code}：{detail(response)}")
    body = response.json()
    if isinstance(body, dict) and body.get("code") not in (0, None):
        raise ProviderError(f"AnySearch 错误：{body.get('message') or body.get('code')}")
    data = body.get("data") if isinstance(body, dict) else {}
    # 云端接口没有站点参数，规则只能对已经返回的列表做本地过滤（命中少就少给几条）
    results = _filter_domains(_clean_results((data or {}).get("results") or []), allow, block)
    return results[:limit]


# ---------------- searxng（自建，无 key） ----------------


def _searxng_page(query: str, page: int, timeout: float = 60) -> list[dict]:
    with client(timeout) as http:
        response = http.get(
            join(_base(), "/search"),
            params={"q": query, "format": "json", "language": "auto", "pageno": str(page)},
        )
    if response.status_code == 403:
        raise ProviderError(
            "SearXNG 拒绝了 json 输出：在 settings.yml 的 search.formats 里加上 json"
        )
    if response.status_code != 200:
        raise ProviderError(f"SearXNG 返回 {response.status_code}：{detail(response)}")
    body = response.json()
    return _clean_results(body.get("results") if isinstance(body, dict) else [], proxied=True)


def _rerank_results(query: str, results: list[dict], limit: int) -> list[dict]:
    """候选的标题+摘要交给重排接口排序，只留前 limit 条；调用失败按原序截断。"""
    docs = [f"{item['title']} — {item['snippet']}" for item in results]
    try:
        order = rerank_provider.rerank(query, docs)
    except Exception as error:
        rerank_provider.note_failure(f"重排调用失败，本次按聚合原序截断：{error}")
        return results[:limit]
    return [results[index] for index in order if 0 <= index < len(results)][:limit]


def _search_searxng(query: str, limit: int, allow: list[str], block: list[str]) -> list[dict]:
    # 重排就绪才翻页聚合：候选没有排序就全塞给模型，只会挤掉上下文
    use_rerank = rerank_provider.ready()[0]
    target = config.SEARCH_CANDIDATE_TARGET if use_rerank else limit
    pages = config.SEARCH_MAX_PAGES if use_rerank else 1
    ceiling = max(target, config.SEARCH_CANDIDATE_MAX) if use_rerank else limit

    collected: list[dict] = []
    seen: set[str] = set()
    for page in range(1, pages + 1):
        items = _searxng_page(query, page)
        if not items:
            break
        matched = _filter_domains(items, allow, block)
        fresh = 0
        for item in matched:
            key = _dedupe_key(item["url"])
            if key in seen:
                continue
            seen.add(key)
            collected.append(item)
            fresh += 1
            # 一页已经请求回来的不中途扔掉：留到 ceiling 条让重排挑，成本按段数线性涨
            if len(collected) >= ceiling:
                break
        # 整页都是已见过的链接才停；整页零命中不能停——那可能只是被域名规则滤掉了
        if matched and fresh == 0:
            break
        if len(collected) >= target:
            break
    if use_rerank and len(collected) > limit:
        return _rerank_results(query, collected, limit)
    return collected[:limit]


def search(
    query: str,
    max_results: int | None = None,
    allowed_domains: list[str] | None = None,
    blocked_domains: list[str] | None = None,
) -> list[dict]:
    if not _available():
        raise ProviderError("搜索未配置（SEARCH_PROVIDER）")
    limit = max(1, min(12, max_results or config.SEARCH_RESULTS))
    allow, block = _rules(allowed_domains, blocked_domains)
    provider = _provider()
    if provider == "tavily":
        return _search_tavily(query, limit, allow, block)
    if provider == "anysearch":
        return _search_anysearch(query, limit, allow, block)
    if provider == "searxng":
        return _search_searxng(query, limit, allow, block)
    raise ProviderError(f"未知搜索 provider：{provider}")


# ---------------- 正文提取 ----------------


class _PageText(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.parts: list[str] = []
        self.skip = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in ("script", "style", "noscript"):
            self.skip += 1
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style", "noscript") and self.skip:
            self.skip -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if not text:
            return
        if self._in_title:
            self.title = f"{self.title} {text}".strip()
        elif not self.skip:
            self.parts.append(text)


def _fetch_html(url: str, max_chars: int) -> dict:
    """SearXNG 只出摘要不出正文，读网页直接抓原站 HTML 去标签。"""
    with client(60) as http:
        response = http.get(url, follow_redirects=True)
    if response.status_code != 200:
        raise ProviderError(f"网页返回 {response.status_code}")
    parser = _PageText()
    parser.feed(response.text)
    return {
        "url": url,
        "title": clean_text(parser.title, 200) or url,
        "content": "\n".join(parser.parts)[:max_chars],
    }


def _extract_tavily(url: str, max_chars: int) -> dict:
    with client(90) as http:
        response = http.post(join(_base(), "/extract"), json={"urls": [url]}, headers=_auth())
    if response.status_code != 200:
        raise ProviderError(f"Tavily 返回 {response.status_code}：{detail(response)}")
    body = response.json()
    results = body.get("results") if isinstance(body, dict) else []
    if not results:
        raise ProviderError("Tavily 没有返回正文")
    item = results[0]
    return {
        "url": item.get("url") or url,
        "title": clean_text(item.get("title"), 200) or url,
        "content": str(item.get("raw_content") or "")[:max_chars],
    }


def _extract_anysearch(url: str, max_chars: int) -> dict:
    with client(120) as http:
        response = http.post(join(_base(), "/v1/extract"), json={"url": url}, headers=_auth())
    if response.status_code != 200:
        raise ProviderError(f"AnySearch 返回 {response.status_code}：{detail(response)}")
    body = response.json()
    if isinstance(body, dict) and body.get("code") not in (0, None):
        raise ProviderError(f"AnySearch 错误：{body.get('message') or body.get('code')}")
    data = body.get("data") if isinstance(body, dict) else {}
    return {
        "url": (data or {}).get("url") or url,
        "title": clean_text((data or {}).get("title"), 200) or url,
        "content": str((data or {}).get("content") or "")[:max_chars],
    }


def extract(url: str, max_chars: int = 8000) -> dict:
    if not _available():
        raise ProviderError("搜索未配置（SEARCH_PROVIDER）")
    provider = _provider()
    if provider == "tavily":
        return _extract_tavily(url, max_chars)
    if provider == "anysearch":
        return _extract_anysearch(url, max_chars)
    if provider == "searxng":
        return _fetch_html(url, max_chars)
    raise ProviderError(f"未知搜索 provider：{provider}")


# ---------------- 健康检查 ----------------


def _searxng_probe() -> dict:
    """存活探针走 /config：毫秒级返回；真搜索要先等各引擎超时，至少 5 秒。"""
    base = _base()
    ok = False
    error = ""
    engines = 0
    try:
        with client(3) as http:
            response = http.get(join(base, "/config"))
        ok = response.status_code == 200
        if not ok:
            error = f"HTTP {response.status_code}"
        else:
            body = response.json()
            engines = len([item for item in body.get("engines") or [] if item.get("enabled")])
    except Exception as exc:
        error = type(exc).__name__
    return {"ok": ok, "base": base, "error": error, "engines": engines}


def probe_query(query: str = "调试探针", timeout: float = 30) -> dict:
    """调试面板用：单页真实搜索，不做聚合与重排。"""
    started = time.perf_counter()
    items = _searxng_page(query, 1, timeout=timeout)
    return {
        "ok": True,
        "count": len(items),
        "ms": round((time.perf_counter() - started) * 1000),
    }


def _rerank_info() -> dict:
    """界面显示用的重排状态：只在本进程第一次问的时候探一次，之后吃缓存。"""
    if rerank_provider.configured() and not rerank_provider.status()["probed"]:
        rerank_provider.ready()
    info = dict(rerank_provider.status())
    aggregate = bool(info["configured"] and info["ok"])
    info["aggregate"] = aggregate
    info["deliver"] = config.SEARCH_RESULTS
    info["candidates"] = config.SEARCH_CANDIDATE_TARGET if aggregate else config.SEARCH_RESULTS
    info["candidate_max"] = config.SEARCH_CANDIDATE_MAX if aggregate else config.SEARCH_RESULTS
    info["pages"] = config.SEARCH_MAX_PAGES if aggregate else 1
    return info


def status() -> dict:
    """调试面板用：不联网，只报配置与重排已有的探测结果。"""
    return {
        "provider": _provider(),
        "available": _available(),
        "base": _base() if _available() else "",
        "searxng": _provider() == "searxng",
        "rerank": dict(rerank_provider.status()),
    }


def health() -> dict:
    provider = _provider()
    probe = _searxng_probe() if provider == "searxng" else {"ok": _available(), "base": _base(), "error": ""}
    return {
        "ok": _available(),
        "provider": provider,
        "base": _base() if _available() else "",
        "searxng": probe,
        "rerank": _rerank_info(),
    }
