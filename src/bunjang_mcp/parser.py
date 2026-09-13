from __future__ import annotations

from bunjang_mcp.models import (
    Listing,
    ListingDetails,
    SearchPage,
)


class BunjangParseError(ValueError):
    pass


def parse_search_response(
    payload: dict,
) -> SearchPage:
    search_response = _find_search_response(payload)

    raw_items = search_response.get("data") or []
    if not isinstance(raw_items, list):
        raise BunjangParseError("Bunjang product grid did not contain a product list")

    listings = [
        _parse_search_listing(item)
        for item in raw_items
        if isinstance(item, dict)
        and item.get("type") == "PRODUCT"
        and item.get("pid") is not None
    ]
    next_cursor = search_response.get("cursor") or search_response.get("nextCursor")
    return SearchPage(
        total_count=int(search_response.get("totalCount") or len(listings)),
        next_cursor=str(next_cursor) if next_cursor else None,
        listings=listings,
    )


def _find_search_response(payload: dict) -> dict:
    data = payload.get("data")
    if not isinstance(data, dict):
        raise BunjangParseError("Bunjang search response did not contain data")

    search_spec = data.get("searchSpec")
    if isinstance(search_spec, dict):
        blocks = search_spec.get("uiBlockList") or []
        if not isinstance(blocks, list):
            raise BunjangParseError("Bunjang search response did not contain UI blocks")
        for block in blocks:
            if (
                isinstance(block, dict)
                and block.get("blockType") == "productList.grid.main"
            ):
                candidate = block.get("searchResponse")
                if isinstance(candidate, dict):
                    return candidate

    responses = data.get("responses")
    if isinstance(responses, dict):
        main_grid = responses.get("mainGrid")
        if isinstance(main_grid, dict):
            candidate = main_grid.get("searchResponse")
            if isinstance(candidate, dict):
                return candidate

    raise BunjangParseError("Bunjang search response did not contain a product grid")


def _parse_search_listing(item: dict) -> Listing:
    product_id = int(item["pid"])
    shop = item.get("shop") or {}
    image_template = item.get("productImage")
    thumbnail_url = _thumbnail_url(image_template)
    return Listing(
        product_id=product_id,
        title=str(item.get("name") or ""),
        price_krw=int(item.get("price") or 0),
        listing_url=f"https://m.bunjang.co.kr/products/{product_id}",
        thumbnail_url=thumbnail_url,
        image_urls=[thumbnail_url] if thumbnail_url else [],
        status=str(item["status"]) if item.get("status") is not None else None,
        updated_at=str(item["updatedAt"])
        if item.get("updatedAt") is not None
        else None,
        seller_id=int(shop["uid"]) if shop.get("uid") is not None else None,
        official_seller=(
            bool(shop["isOfficialSeller"])
            if shop.get("isOfficialSeller") is not None
            else None
        ),
        favorite_count=(
            int(item["favoriteCount"])
            if item.get("favoriteCount") is not None
            else None
        ),
        chat_count=int(item["buntalkCount"])
        if item.get("buntalkCount") is not None
        else None,
        care=bool(item["care"]) if item.get("care") is not None else None,
        ad=bool(item["ad"]) if item.get("ad") is not None else None,
    )


def parse_product_detail(payload: dict) -> ListingDetails:
    data = payload.get("data")
    product = data.get("product") if isinstance(data, dict) else None
    if not isinstance(product, dict):
        raise BunjangParseError("Bunjang product response did not contain product data")

    metrics = product.get("metrics") or {}
    trade = product.get("trade") or {}
    category = product.get("category") or {}
    brand = product.get("brand") or {}
    shop = data.get("shop") or {}
    return ListingDetails(
        description=(
            str(product["description"])
            if product.get("description") is not None
            else None
        ),
        image_urls=_original_image_urls(
            product.get("imageUrl"), int(product.get("imageCount") or 0)
        ),
        condition=str(product["condition"])
        if product.get("condition") is not None
        else None,
        category_name=str(category["name"])
        if category.get("name") is not None
        else None,
        brand_name=str(brand["name"]) if brand.get("name") is not None else None,
        seller_name=str(shop["name"]) if shop.get("name") is not None else None,
        view_count=int(metrics["viewCount"])
        if metrics.get("viewCount") is not None
        else None,
        free_shipping=(
            bool(trade["freeShipping"])
            if trade.get("freeShipping") is not None
            else None
        ),
        in_person=bool(trade["inPerson"])
        if trade.get("inPerson") is not None
        else None,
    )


def _thumbnail_url(image_template: object) -> str | None:
    if not isinstance(image_template, str) or not image_template:
        return None
    return image_template.replace("{cnt}", "1").replace("{res}", "360")


def _original_image_urls(image_template: object, image_count: int) -> list[str]:
    if not isinstance(image_template, str) or not image_template or image_count < 1:
        return []
    original_template = image_template.replace("_w{res}", "").replace("{res}", "")
    return [
        original_template.replace("{cnt}", str(index))
        for index in range(1, image_count + 1)
    ]
