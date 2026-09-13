from __future__ import annotations

import asyncio

from bunjang_mcp.service import BunjangService

SEARCH_PAYLOAD = {
    "data": {
        "searchSpec": {
            "uiBlockList": [
                {
                    "blockType": "productList.grid.main",
                    "searchResponse": {
                        "totalCount": 1,
                        "data": [
                            {
                                "pid": 431514555,
                                "name": "아이폰 14pro 판매 퍼플색상",
                                "price": 430000,
                                "productImage": "https://media.bunjang.co.kr/product/431514555_1_stamp_w{res}.jpg",
                                "type": "PRODUCT",
                            }
                        ],
                    },
                }
            ]
        }
    }
}

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


class FakeClient:
    def __init__(self) -> None:
        self.search_calls = 0
        self.detail_calls: list[int] = []

    async def fetch_search(self, search_word: str) -> tuple[str, dict]:
        self.search_calls += 1
        return f"https://m.bunjang.co.kr/keywords/{search_word}", SEARCH_PAYLOAD

    async def fetch_product_detail(self, product_id: int) -> dict:
        self.detail_calls.append(product_id)
        return PRODUCT_DETAIL

    async def aclose(self) -> None:
        return None


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
        assert client.search_calls == 1
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
