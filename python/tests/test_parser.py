from __future__ import annotations

from bunjang_mcp.parser import parse_product_detail, parse_search_response


def test_parse_search_response_filters_external_ads_and_summarizes_products() -> None:
    result = parse_search_response(
        {
            "data": {
                "searchSpec": {
                    "uiBlockList": [
                        {
                            "blockType": "productList.grid.main",
                            "searchResponse": {
                                "totalCount": 2960,
                                "data": [
                                    {
                                        "pid": 431514555,
                                        "name": "아이폰 14pro 판매 퍼플색상",
                                        "price": 430000,
                                        "status": "SELLING",
                                        "productImage": "https://media.bunjang.co.kr/product/431514555_1_1789318294_w{res}.jpg",
                                        "shop": {
                                            "uid": 85864648,
                                            "isOfficialSeller": False,
                                        },
                                        "favoriteCount": 2,
                                        "buntalkCount": 1,
                                        "updatedAt": "2026-09-13T16:51:10Z",
                                        "care": True,
                                        "ad": False,
                                        "type": "PRODUCT",
                                    },
                                    {
                                        "pid": 429730308,
                                        "name": "아이폰 14 Pro Max 256GB",
                                        "price": 820000,
                                        "type": "PRODUCT",
                                    },
                                    {
                                        "name": "외부 광고",
                                        "price": 912000,
                                        "type": "EXT_AD",
                                    },
                                ],
                            },
                        }
                    ]
                }
            }
        }
    )

    assert result.total_count == 2960
    assert len(result.listings) == 2
    listing = result.listings[0]
    assert listing.product_id == 431514555
    assert listing.listing_url == "https://m.bunjang.co.kr/products/431514555"
    assert listing.thumbnail_url == (
        "https://media.bunjang.co.kr/product/431514555_1_1789318294_w360.jpg"
    )
    assert listing.seller_id == 85864648
    assert listing.care is True


def test_parse_continuation_search_response() -> None:
    result = parse_search_response(
        {
            "data": {
                "responses": {
                    "mainGrid": {
                        "searchResponse": {
                            "totalCount": 120,
                            "cursor": "page-3-cursor",
                            "data": [
                                {
                                    "pid": 428113081,
                                    "name": "아이폰14프로 256G",
                                    "price": 651000,
                                    "type": "PRODUCT",
                                }
                            ],
                        }
                    }
                }
            }
        }
    )

    assert result.total_count == 120
    assert result.next_cursor == "page-3-cursor"
    assert result.listings[0].product_id == 428113081


def test_parse_product_detail_generates_original_images_and_metadata() -> None:
    result = parse_product_detail(
        {
            "data": {
                "product": {
                    "description": "판매자가 작성한 설명",
                    "imageUrl": "https://media.bunjang.co.kr/product/431514555_{cnt}_1789318294_w{res}.jpg",
                    "imageCount": 3,
                    "condition": "DAMAGED",
                    "metrics": {"viewCount": 6},
                    "category": {"name": "스마트폰"},
                    "brand": {"name": "애플"},
                    "trade": {"freeShipping": True, "inPerson": False},
                },
                "shop": {"name": "인생은낭만있게77"},
            }
        }
    )

    assert result.description == "판매자가 작성한 설명"
    assert result.image_urls == [
        "https://media.bunjang.co.kr/product/431514555_1_1789318294.jpg",
        "https://media.bunjang.co.kr/product/431514555_2_1789318294.jpg",
        "https://media.bunjang.co.kr/product/431514555_3_1789318294.jpg",
    ]
    assert result.condition == "DAMAGED"
    assert result.category_name == "스마트폰"
    assert result.brand_name == "애플"
    assert result.seller_name == "인생은낭만있게77"
    assert result.view_count == 6
    assert result.free_shipping is True
    assert result.in_person is False
