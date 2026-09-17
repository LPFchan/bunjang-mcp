from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from statistics import fmean

from bunjang_mcp.client import BunjangClient, BunjangFetchError
from bunjang_mcp.models import (
    BunjangSearchResult,
    Listing,
    ListingDetails,
    PriceSummary,
    SearchPage,
)
from bunjang_mcp.normalize import normalize_search_word
from bunjang_mcp.parser import (
    BunjangParseError,
    parse_product_detail,
    parse_search_response,
)


@dataclass(slots=True)
class _SearchCacheEntry:
    expires_at: float
    source_url: str
    fetched_at: str
    page: SearchPage


@dataclass(slots=True)
class _DetailCacheEntry:
    expires_at: float
    details: ListingDetails


class BunjangService:
    def __init__(self, client: BunjangClient, *, cache_ttl_seconds: int = 300) -> None:
        self._client = client
        self._cache_ttl_seconds = cache_ttl_seconds
        self._search_cache: dict[tuple[str, str | None], _SearchCacheEntry] = {}
        self._detail_cache: dict[int, _DetailCacheEntry] = {}
        self._detail_semaphore = asyncio.Semaphore(8)
        self._lock = asyncio.Lock()

    async def search(
        self,
        *,
        query: str,
        search_word: str | None = None,
        offset: int = 0,
        max_listings: int = 20,
        include_details: bool = True,
        force_refresh: bool = False,
    ) -> BunjangSearchResult:
        if offset < 0:
            raise ValueError("offset must not be negative")
        if max_listings < 1 or max_listings > 60:
            raise ValueError("max_listings must be between 1 and 60")

        effective_search_word = (
            search_word.strip() if search_word else normalize_search_word(query)
        )
        listings: list[Listing] = []
        seen_product_ids: set[int] = set()
        cursor: str | None = None
        seen_cursors: set[str] = set()
        target_count = offset + max_listings
        all_from_cache = True
        source_url = self._client.build_search_url(effective_search_word)
        fetched_at = datetime.now(UTC).isoformat()
        total_count = 0
        can_fetch_more = True

        while len(listings) < target_count and can_fetch_more:
            if cursor is not None:
                if cursor in seen_cursors:
                    break
                seen_cursors.add(cursor)

            entry, from_cache = await self._get_search_page(
                effective_search_word,
                cursor=cursor,
                force_refresh=force_refresh,
            )
            all_from_cache = all_from_cache and from_cache
            source_url = entry.source_url
            if not listings:
                fetched_at = entry.fetched_at
                total_count = entry.page.total_count
            for listing in entry.page.listings:
                if listing.product_id not in seen_product_ids:
                    seen_product_ids.add(listing.product_id)
                    listings.append(listing)
            cursor = entry.page.next_cursor
            can_fetch_more = cursor is not None and len(listings) < total_count

        selected = listings[offset:target_count]
        next_index = offset + len(selected)
        has_more = next_index < len(listings) or (
            can_fetch_more and next_index < total_count
        )
        result = BunjangSearchResult(
            query=query,
            search_word=effective_search_word,
            source_url=source_url,
            fetched_at=fetched_at,
            from_cache=all_from_cache,
            total_count=total_count,
            offset=offset,
            next_offset=next_index if has_more else None,
            has_more=has_more,
            summary=_summarize(selected),
            listings=[listing.model_copy(deep=True) for listing in selected],
        )

        if include_details:
            await self._enrich_listings(result.listings, force_refresh=force_refresh)
        return result

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _get_search_page(
        self,
        search_word: str,
        *,
        cursor: str | None,
        force_refresh: bool,
    ) -> tuple[_SearchCacheEntry, bool]:
        key = (search_word, cursor)
        now = time.monotonic()
        async with self._lock:
            entry = self._search_cache.get(key)
            if entry and entry.expires_at <= now:
                self._search_cache.pop(key, None)
                entry = None
            if not force_refresh and entry:
                return _copy_search_entry(entry), True

        source_url, payload = await self._client.fetch_search(
            search_word, cursor=cursor
        )
        entry = _SearchCacheEntry(
            expires_at=time.monotonic() + self._cache_ttl_seconds,
            source_url=source_url,
            fetched_at=datetime.now(UTC).isoformat(),
            page=parse_search_response(payload),
        )
        async with self._lock:
            self._search_cache[key] = _copy_search_entry(entry)
        return entry, False

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


def _copy_search_entry(entry: _SearchCacheEntry) -> _SearchCacheEntry:
    return _SearchCacheEntry(
        expires_at=entry.expires_at,
        source_url=entry.source_url,
        fetched_at=entry.fetched_at,
        page=entry.page.model_copy(deep=True),
    )


def _summarize(listings: list[Listing]) -> PriceSummary:
    prices = [listing.price_krw for listing in listings]
    return PriceSummary(
        sample_size=len(prices),
        average_price_krw=round(fmean(prices)) if prices else None,
        highest_price_krw=max(prices) if prices else None,
        lowest_price_krw=min(prices) if prices else None,
    )
