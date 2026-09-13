from __future__ import annotations

from urllib.parse import quote

import httpx

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
)


class BunjangFetchError(RuntimeError):
    pass


class BunjangClient:
    def __init__(
        self,
        *,
        base_url: str = "https://m.bunjang.co.kr",
        api_base_url: str = "https://api.bunjang.co.kr",
        timeout_seconds: float = 20.0,
        user_agent: str | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_base_url = api_base_url.rstrip("/")
        self._http = httpx.AsyncClient(
            follow_redirects=True,
            http2=True,
            timeout=timeout_seconds,
            headers={
                "Accept": "application/json",
                "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
                "Origin": self._base_url,
                "Referer": f"{self._base_url}/",
                "User-Agent": user_agent or DEFAULT_USER_AGENT,
            },
        )

    def build_search_url(self, search_word: str) -> str:
        return f"{self._base_url}/keywords/{quote(search_word.strip(), safe='')}"

    async def fetch_search(
        self, search_word: str, *, cursor: str | None = None
    ) -> tuple[str, dict]:
        if not search_word.strip():
            raise BunjangFetchError("search_word must not be blank")
        source_url = self.build_search_url(search_word)
        if cursor is None:
            api_url = f"{self._api_base_url}/api/search/v8/pw/product/specs/keyword"
            params = {"q": search_word}
        else:
            api_url = f"{self._api_base_url}/api/search/v8/web/search"
            params = {
                "q": search_word,
                "policyKey": "pw.product.keyword",
                "cursor": cursor,
                "size": "60",
            }
        payload = await self._get_json(api_url, params=params)
        return source_url, payload

    async def fetch_product_detail(self, product_id: int) -> dict:
        url = f"{self._api_base_url}/api/pms/v1/products/{product_id}/detail/web"
        return await self._get_json(url)

    async def _get_json(
        self, url: str, *, params: dict[str, str] | None = None
    ) -> dict:
        try:
            response = await self._http.get(url, params=params)
        except httpx.HTTPError as exc:
            raise BunjangFetchError(
                f"Could not fetch Bunjang API endpoint {url}"
            ) from exc
        if response.status_code != 200:
            raise BunjangFetchError(
                f"Bunjang returned HTTP {response.status_code} for {url}"
            )
        if "application/json" not in response.headers.get("content-type", ""):
            raise BunjangFetchError(f"Bunjang returned non-JSON content for {url}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise BunjangFetchError(f"Bunjang returned invalid JSON for {url}") from exc
        if not isinstance(payload, dict):
            raise BunjangFetchError(f"Bunjang returned an invalid response for {url}")
        return payload

    async def aclose(self) -> None:
        await self._http.aclose()
