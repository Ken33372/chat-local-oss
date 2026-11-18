"""联网搜索与网页正文提取。

provider：
- tavily    POST {base}/search（key 可空，走 keyless 限流）
- anysearch POST {base}/v1/search（key 可空）
- searxng   GET  {base}/search?format=json（自建，无 key）
- none      关闭
"""
from __future__ import annotations

from html.parser import HTMLParser

import config
from providers.common import ProviderError, client, detail, join

DEFAULT_BASES = {
    "tavily": "https://api.tavily.com",
    "anysearch": "https://api.anysearch.com",
}


def _web(url: str | None) -> bool:
    return isinstance(url, str) and url.startswith(("http://", "https://"))


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


def _clean_results(items: list) -> list[dict]:
    results: list[dict] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if not _web(url):
            continue
        results.append(
            {
                "title": str(item.get("title") or url),
                "url": url,
                "snippet": str(item.get("content") or item.get("snippet") or "").strip(),
            }
        )
    return results


def _search_tavily(query: str, limit: int) -> list[dict]:
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
    return _clean_results(body.get("results") if isinstance(body, dict) else [])


def _search_anysearch(query: str, limit: int) -> list[dict]:
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
    return _clean_results((data or {}).get("results") or [])


def _search_searxng(query: str, limit: int) -> list[dict]:
    with client(60) as http:
        response = http.get(
            join(_base(), "/search"),
            params={"q": query, "format": "json", "language": "auto"},
        )
    if response.status_code != 200:
        raise ProviderError(f"SearXNG 返回 {response.status_code}：{detail(response)}")
    body = response.json()
    return _clean_results(body.get("results") if isinstance(body, dict) else [])[:limit]


def search(query: str, max_results: int | None = None) -> list[dict]:
    if not _available():
        raise ProviderError("搜索未配置（SEARCH_PROVIDER）")
    limit = max(1, min(10, max_results or config.SEARCH_RESULTS))
    provider = config.SEARCH_PROVIDER
    if provider == "tavily":
        return _search_tavily(query, limit)
    if provider == "anysearch":
        return _search_anysearch(query, limit)
    if provider == "searxng":
        return _search_searxng(query, limit)
    raise ProviderError(f"未知搜索 provider：{provider}")


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
    with client(60) as http:
        response = http.get(url, follow_redirects=True)
    if response.status_code != 200:
        raise ProviderError(f"网页返回 {response.status_code}")
    parser = _PageText()
    parser.feed(response.text)
    return {
        "url": url,
        "title": parser.title or url,
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
        "title": item.get("title") or url,
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
        "title": (data or {}).get("title") or url,
        "content": str((data or {}).get("content") or "")[:max_chars],
    }


def extract(url: str, max_chars: int = 8000) -> dict:
    if not _available():
        raise ProviderError("搜索未配置（SEARCH_PROVIDER）")
    provider = config.SEARCH_PROVIDER
    if provider == "tavily":
        return _extract_tavily(url, max_chars)
    if provider == "anysearch":
        return _extract_anysearch(url, max_chars)
    if provider == "searxng":
        return _fetch_html(url, max_chars)
    raise ProviderError(f"未知搜索 provider：{provider}")


def health() -> dict:
    return {
        "ok": _available(),
        "provider": config.SEARCH_PROVIDER,
        "base": _base() if _available() else "",
    }
