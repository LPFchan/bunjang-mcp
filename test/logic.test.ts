import { describe, expect, it } from "vitest";
import { normalizeSearchWord, parseProductDetail, parseSearchResponse } from "../index";

describe("normalizeSearchWord", () => {
  it("normalizes an English natural-language query", () => {
    expect(normalizeSearchWord("how much does used iPhone 13 mini go these days?")).toBe(
      "아이폰13미니",
    );
  });

  it("normalizes a Korean query", () => {
    expect(normalizeSearchWord("아이폰 13 미니")).toBe("아이폰13미니");
  });

  it("rejects a blank query", () => {
    expect(() => normalizeSearchWord("   ")).toThrow();
  });

  it("falls back to the raw text when every word is noise", () => {
    expect(normalizeSearchWord("a")).toBe("a");
    expect(() => normalizeSearchWord("?!")).toThrow(/usable search term/);
  });

  it("strips storage units and punctuation", () => {
    expect(normalizeSearchWord("iPhone 14 Pro Max 256GB, unlocked")).toBe("아이폰14프로맥스256unlocked");
  });
});

describe("parseSearchResponse", () => {
  it("filters external ads and summarizes products", () => {
    const result = parseSearchResponse({
      data: {
        searchSpec: {
          uiBlockList: [
            {
              blockType: "productList.grid.main",
              searchResponse: {
                totalCount: 2960,
                data: [
                  {
                    pid: 431514555,
                    name: "아이폰 14pro 판매 퍼플색상",
                    price: 430000,
                    status: "SELLING",
                    productImage:
                      "https://media.bunjang.co.kr/product/431514555_1_1789318294_w{res}.jpg",
                    shop: { uid: 85864648, isOfficialSeller: false },
                    favoriteCount: 2,
                    buntalkCount: 1,
                    updatedAt: "2026-09-13T16:51:10Z",
                    care: true,
                    ad: false,
                    type: "PRODUCT",
                  },
                  { pid: 429730308, name: "아이폰 14 Pro Max 256GB", price: 820000, type: "PRODUCT" },
                  { name: "외부 광고", price: 912000, type: "EXT_AD" },
                ],
              },
            },
          ],
        },
      },
    });

    expect(result.total_count).toBe(2960);
    expect(result.listings).toHaveLength(2);
    const listing = result.listings[0];
    expect(listing.product_id).toBe(431514555);
    expect(listing.listing_url).toBe("https://m.bunjang.co.kr/products/431514555");
    expect(listing.thumbnail_url).toBe(
      "https://media.bunjang.co.kr/product/431514555_1_1789318294_w360.jpg",
    );
    expect(listing.seller_id).toBe(85864648);
    expect(listing.care).toBe(true);
  });

  it("parses a continuation search response", () => {
    const result = parseSearchResponse({
      data: {
        responses: {
          mainGrid: {
            searchResponse: {
              totalCount: 120,
              cursor: "page-3-cursor",
              data: [{ pid: 428113081, name: "아이폰14프로 256G", price: 651000, type: "PRODUCT" }],
            },
          },
        },
      },
    });

    expect(result.total_count).toBe(120);
    expect(result.next_cursor).toBe("page-3-cursor");
    expect(result.listings[0].product_id).toBe(428113081);
  });

  it("falls back to the page size when totalCount is missing or zero", () => {
    const grid = (searchResponse: Record<string, unknown>) => ({
      data: { responses: { mainGrid: { searchResponse } } },
    });
    const items = [{ pid: 1, price: 100, type: "PRODUCT" }];
    expect(parseSearchResponse(grid({ data: items })).total_count).toBe(1);
    expect(parseSearchResponse(grid({ totalCount: 0, data: items })).total_count).toBe(1);
    expect(parseSearchResponse(grid({ totalCount: "7", data: items })).total_count).toBe(7);
  });

  it("does not turn junk numbers into NaN", () => {
    const result = parseSearchResponse({
      data: {
        responses: {
          mainGrid: {
            searchResponse: {
              data: [{ pid: 1, price: "not a price", favoriteCount: "x", type: "PRODUCT" }],
            },
          },
        },
      },
    });
    expect(result.listings[0].price_krw).toBe(0);
    expect(result.listings[0].favorite_count).toBeNull();
  });

  it("rejects a response whose shape has changed", () => {
    expect(() => parseSearchResponse({})).toThrow(/did not contain data/);
    expect(() => parseSearchResponse({ data: {} })).toThrow(/product grid/);
    expect(() => parseSearchResponse({ data: { searchSpec: { uiBlockList: "nope" } } })).toThrow(
      /UI blocks/,
    );
    expect(() =>
      parseSearchResponse({ data: { responses: { mainGrid: { searchResponse: { data: {} } } } } }),
    ).toThrow(/product list/);
    expect(() => parseProductDetail({ data: {} })).toThrow(/product data/);
  });
});

describe("parseProductDetail", () => {
  it("generates original images and metadata", () => {
    const result = parseProductDetail({
      data: {
        product: {
          description: "판매자가 작성한 설명",
          imageUrl: "https://media.bunjang.co.kr/product/431514555_{cnt}_1789318294_w{res}.jpg",
          imageCount: 3,
          condition: "DAMAGED",
          metrics: { viewCount: 6 },
          category: { name: "스마트폰" },
          brand: { name: "애플" },
          trade: { freeShipping: true, inPerson: false },
        },
        shop: { name: "인생은낭만있게77" },
      },
    });

    expect(result.description).toBe("판매자가 작성한 설명");
    expect(result.image_urls).toEqual([
      "https://media.bunjang.co.kr/product/431514555_1_1789318294.jpg",
      "https://media.bunjang.co.kr/product/431514555_2_1789318294.jpg",
      "https://media.bunjang.co.kr/product/431514555_3_1789318294.jpg",
    ]);
    expect(result.condition).toBe("DAMAGED");
    expect(result.category_name).toBe("스마트폰");
    expect(result.brand_name).toBe("애플");
    expect(result.seller_name).toBe("인생은낭만있게77");
    expect(result.view_count).toBe(6);
    expect(result.free_shipping).toBe(true);
    expect(result.in_person).toBe(false);
  });
});
