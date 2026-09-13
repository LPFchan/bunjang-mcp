from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class PriceSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sample_size: int = 0
    average_price_krw: int | None = None
    highest_price_krw: int | None = None
    lowest_price_krw: int | None = None


class Listing(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product_id: int
    title: str
    price_krw: int
    listing_url: str
    thumbnail_url: str | None = None
    description: str | None = Field(
        default=None, description="Seller-provided listing description"
    )
    image_urls: list[str] = Field(
        default_factory=list,
        description="Original-size product image URLs in display order",
    )
    status: str | None = None
    condition: str | None = None
    updated_at: str | None = None
    category_name: str | None = None
    brand_name: str | None = None
    seller_id: int | None = None
    seller_name: str | None = None
    official_seller: bool | None = None
    favorite_count: int | None = None
    chat_count: int | None = None
    view_count: int | None = None
    free_shipping: bool | None = None
    in_person: bool | None = None
    care: bool | None = None
    ad: bool | None = None


class ListingDetails(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: str | None = None
    image_urls: list[str] = Field(default_factory=list)
    condition: str | None = None
    category_name: str | None = None
    brand_name: str | None = None
    seller_name: str | None = None
    view_count: int | None = None
    free_shipping: bool | None = None
    in_person: bool | None = None


class BunjangSearchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str
    search_word: str
    source_url: str
    fetched_at: str
    from_cache: bool = False
    total_count: int = 0
    summary: PriceSummary = Field(default_factory=PriceSummary)
    listings: list[Listing] = Field(default_factory=list)
