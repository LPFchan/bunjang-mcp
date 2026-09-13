from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import UTC, datetime

from bunjang_mcp.client import BunjangClient, BunjangFetchError
from bunjang_mcp.models import BunjangSearchResult, Listing, ListingDetails
from bunjang_mcp.normalize import normalize_search_word
from bunjang_mcp.parser import (
    BunjangParseError,
    parse_product_detail,
    parse_search_response,
)


@dataclass(slots=True)
class _SearchCacheEntry:
    expires_at: float
    result: BunjangSearchResult


@dataclass(slots=True)
class _DetailCacheEntry:
    expires_at: float
    details: ListingDetails


class BunjangService:
    def __init__(self, client: BunjangClient, *, cache_ttl_seconds: int = 300) -> None:
        self._client = client
        self._cache_ttl_seconds = cache_ttl_seconds
        self._search_cache: dict[str, _SearchCacheEntry] = {}
        self._detail_cache: dict[int, _DetailCacheEntry] = {}
        self._detail_semaphore = asyncio.Semaphore(8)
        self._lock = asyncio.Lock()

    async def search(
        self,
        *,
        query: str,
        search_word: str | None = None,
        max_listings: int = 20,
        include_details: bool = True,
        force_refresh: bool = False,
    ) -> BunjangSearchResult:
        if max_listings < 1 or max_listings > 60:
            raise ValueError("max_listings must be between 1 and 60")

        effective_search_word = (
            search_word.strip() if search_word else normalize_search_word(query)
        )
        now = time.monotonic()
        async with self._lock:
            entry = self._search_cache.get(effective_search_word)
            if entry and entry.expires_at <= now:
                self._search_cache.pop(effective_search_word, None)
                entry = None
            if not force_refresh and entry:
                result = self._limit_result(entry.result, max_listings, from_cache=True)
            else:
                result = None

        if result is None:
            source_url, payload = await self._client.fetch_search(effective_search_word)
            result = parse_search_response(
                payload,
                query=query,
                search_word=effective_search_word,
                source_url=source_url,
                fetched_at=datetime.now(UTC).isoformat(),
            )
            async with self._lock:
                self._search_cache[effective_search_word] = _SearchCacheEntry(
                    expires_at=time.monotonic() + self._cache_ttl_seconds,
                    result=result.model_copy(deep=True),
                )
            result = self._limit_result(result, max_listings, from_cache=False)

        if include_details:
            await self._enrich_listings(result.listings, force_refresh=force_refresh)
        return result

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _enrich_listings(
        self, listings: list[Listing], *, force_refresh: bool
    ) -> None:
        product_ids = list(dict.fromkeys(listing.product_id for listing in listings))
        details = await asyncio.gather(
            *(
                self._get_listing_details(product_id, force_refresh)
                for product_id in product_ids
            )
        )
        details_by_id = dict(zip(product_ids, details, strict=True))
        for listing in listings:
            detail = details_by_id[listing.product_id]
            listing.description = detail.description
            if detail.image_urls:
                listing.image_urls = detail.image_urls.copy()
            listing.condition = detail.condition
            listing.category_name = detail.category_name
            listing.brand_name = detail.brand_name
            listing.seller_name = detail.seller_name
            listing.view_count = detail.view_count
            listing.free_shipping = detail.free_shipping
            listing.in_person = detail.in_person

    async def _get_listing_details(
        self, product_id: int, force_refresh: bool
    ) -> ListingDetails:
        now = time.monotonic()
        async with self._lock:
            entry = self._detail_cache.get(product_id)
            if entry and entry.expires_at <= now:
                self._detail_cache.pop(product_id, None)
                entry = None
            if not force_refresh and entry:
                return entry.details.model_copy(deep=True)

        try:
            async with self._detail_semaphore:
                payload = await self._client.fetch_product_detail(product_id)
            details = parse_product_detail(payload)
        except (BunjangFetchError, BunjangParseError):
            details = ListingDetails()

        async with self._lock:
            self._detail_cache[product_id] = _DetailCacheEntry(
                expires_at=time.monotonic() + self._cache_ttl_seconds,
                details=details.model_copy(deep=True),
            )
        return details

    @staticmethod
    def _limit_result(
        result: BunjangSearchResult, max_listings: int, *, from_cache: bool
    ) -> BunjangSearchResult:
        limited = result.model_copy(deep=True, update={"from_cache": from_cache})
        limited.listings = limited.listings[:max_listings]
        return limited
