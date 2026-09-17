from __future__ import annotations

import asyncio

from bunjang_mcp.service import BunjangService

PRODUCT_DETAIL = {
    "data": {
        "product": {
            "description": "판매자가 작성한 상품 설명",
            "imageUrl": "https://media.bunjang.co.kr/product/431514555_{cnt}_stamp_w{res}.jpg",
            "imageCount": 2,
        },
        "shop": {},
    }
}


def _product(product_id: int, price: int) -> dict:
    return {
        "pid": product_id,
        "name": f"상품 {product_id}",
        "price": price,
        "productImage": f"https://media.bunjang.co.kr/product/{product_id}_1_stamp_w{{res}}.jpg",
        "type": "PRODUCT",
    }


def _initial_payload(
    products: list[dict], *, total_count: int, cursor: str | None
) -> dict:
    return {
        "data": {
            "searchSpec": {
                "uiBlockList": [
                    {
                        "blockType": "productList.grid.main",
                        "searchResponse": {
                            "totalCount": total_count,
                            "cursor": cursor,
                            "data": products,
                        },
                    }
                ]
            }
        }
    }


def _continuation_payload(
    products: list[dict], *, total_count: int, cursor: str | None
) -> dict:
    return {
        "data": {
            "responses": {
                "mainGrid": {
                    "searchResponse": {
                        "totalCount": total_count,
                        "cursor": cursor,
                        "data": products,
                    }
                }
            }
        }
    }


class FakeClient:
    def __init__(self) -> None:
        self.search_cursors: list[str | None] = []
        self.detail_calls: list[int] = []

    def build_search_url(self, search_word: str) -> str:
        return f"https://m.bunjang.co.kr/keywords/{search_word}"

    async def fetch_search(
        self, search_word: str, *, cursor: str | None = None
    ) -> tuple[str, dict]:
        self.search_cursors.append(cursor)
        payload = _initial_payload(
            [_product(431514555, 430000)], total_count=1, cursor=None
        )
        return self.build_search_url(search_word), payload

    async def fetch_product_detail(self, product_id: int) -> dict:
        self.detail_calls.append(product_id)
        return PRODUCT_DETAIL

    async def aclose(self) -> None:
        return None


class PaginatedFakeClient(FakeClient):
    async def fetch_search(
        self, search_word: str, *, cursor: str | None = None
    ) -> tuple[str, dict]:
        self.search_cursors.append(cursor)
        if cursor is None:
            payload = _initial_payload(
                [_product(1, 100), _product(2, 200), _product(3, 300)],
                total_count=6,
                cursor="page-2",
            )
        elif cursor == "page-2":
            payload = _continuation_payload(
                [
                    _product(3, 300),
                    _product(4, 400),
                    _product(5, 500),
                    _product(6, 600),
                ],
                total_count=6,
                cursor=None,
            )
        else:
            raise AssertionError(f"unexpected cursor: {cursor}")
        return self.build_search_url(search_word), payload


def test_search_enriches_details_and_reuses_both_caches() -> None:
    async def run() -> None:
        client = FakeClient()
        service = BunjangService(client)  # type: ignore[arg-type]

        first = await service.search(query="아이폰 14 프로")
        second = await service.search(query="아이폰 14 프로")

        assert first.from_cache is False
        assert second.from_cache is True
        assert first.listings[0].description == "판매자가 작성한 상품 설명"
        assert first.listings[0].image_urls == [
            "https://media.bunjang.co.kr/product/431514555_1_stamp.jpg",
            "https://media.bunjang.co.kr/product/431514555_2_stamp.jpg",
        ]
        assert client.search_cursors == [None]
        assert client.detail_calls == [431514555]

    asyncio.run(run())


def test_search_can_skip_detail_requests() -> None:
    async def run() -> None:
        client = FakeClient()
        service = BunjangService(client)  # type: ignore[arg-type]

        result = await service.search(query="아이폰 14 프로", include_details=False)

        assert result.listings[0].description is None
        assert client.detail_calls == []

    asyncio.run(run())


def test_offset_crosses_upstream_page_boundary_and_returns_next_offset() -> None:
    async def run() -> None:
        client = PaginatedFakeClient()
        service = BunjangService(client)  # type: ignore[arg-type]

        result = await service.search(
            query="아이폰",
            offset=2,
            max_listings=3,
            include_details=False,
        )

        assert [listing.product_id for listing in result.listings] == [3, 4, 5]
        assert result.offset == 2
        assert result.next_offset == 5
        assert result.has_more is True
        assert result.summary.sample_size == 3
        assert result.summary.average_price_krw == 400
        assert client.search_cursors == [None, "page-2"]

        final = await service.search(
            query="아이폰",
            offset=result.next_offset,
            max_listings=3,
            include_details=False,
        )
        assert [listing.product_id for listing in final.listings] == [6]
        assert final.next_offset is None
        assert final.has_more is False
        assert final.from_cache is True
        assert client.search_cursors == [None, "page-2"]

    asyncio.run(run())
