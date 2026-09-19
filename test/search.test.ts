// Port of the Python service tests (python/tests/test_service.py, deleted
// with the container). The Python tests drove BunjangService with a fake
// client; here searchListings talks to global fetch, so the fake sits there
// instead and records which upstream URLs were asked for.
//
// The cache-related assertions from the Python suite (second call served
// from cache, from_cache flipping true) have no Worker equivalent: there is
// no cache and no from_cache field. Two identical calls hit upstream twice.

import { afterEach, describe, expect, it, vi } from "vitest";
import { searchListings, type Env } from "../index";

const env: Env = {
  BUNJANG_BASE_URL: "https://m.bunjang.co.kr",
  BUNJANG_API_BASE_URL: "https://api.bunjang.co.kr",
  BUNJANG_TIMEOUT_SECONDS: "20",
  BUNJANG_USER_AGENT: "test-agent",
};

const PRODUCT_DETAIL = {
  data: {
    product: {
      description: "판매자가 작성한 상품 설명",
      imageUrl: "https://media.bunjang.co.kr/product/431514555_{cnt}_stamp_w{res}.jpg",
      imageCount: 2,
    },
    shop: {},
  },
};

function product(productId: number, price: number) {
  return {
    pid: productId,
    name: `상품 ${productId}`,
    price,
    productImage: `https://media.bunjang.co.kr/product/${productId}_1_stamp_w{res}.jpg`,
    type: "PRODUCT",
  };
}

function initialPayload(products: unknown[], totalCount: number, cursor: string | null) {
  return {
    data: {
      searchSpec: {
        uiBlockList: [
          {
            blockType: "productList.grid.main",
            searchResponse: { totalCount, cursor, data: products },
          },
        ],
      },
    },
  };
}

function continuationPayload(products: unknown[], totalCount: number, cursor: string | null) {
  return {
    data: {
      responses: {
        mainGrid: { searchResponse: { totalCount, cursor, data: products } },
      },
    },
  };
}

interface FakeUpstream {
  searchCursors: Array<string | null>;
  detailCalls: number[];
  requests: Request[];
}

// Installs a fetch stub that answers the two Bunjang endpoints the Worker
// uses. `pages` maps a cursor (null for the first page) to the payload.
function stubUpstream(pages: Map<string | null, unknown>): FakeUpstream {
  const seen: FakeUpstream = { searchCursors: [], detailCalls: [], requests: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.requests.push(request);
      const url = new URL(request.url);

      const detail = url.pathname.match(/^\/api\/pms\/v1\/products\/(\d+)\/detail\/web$/);
      if (detail) {
        seen.detailCalls.push(Number(detail[1]));
        return Response.json(PRODUCT_DETAIL);
      }

      let cursor: string | null;
      if (url.pathname === "/api/search/v8/pw/product/specs/keyword") {
        cursor = null;
      } else if (url.pathname === "/api/search/v8/web/search") {
        cursor = url.searchParams.get("cursor");
        expect(url.searchParams.get("policyKey")).toBe("pw.product.keyword");
        expect(url.searchParams.get("size")).toBe("60");
      } else {
        throw new Error(`unexpected upstream URL ${request.url}`);
      }
      seen.searchCursors.push(cursor);
      if (!pages.has(cursor)) throw new Error(`unexpected cursor: ${cursor}`);
      return Response.json(pages.get(cursor));
    }),
  );
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchListings", () => {
  it("enriches listings with details and never serves from a cache", async () => {
    const upstream = stubUpstream(
      new Map([[null, initialPayload([product(431514555, 430000)], 1, null)]]),
    );

    const first = await searchListings(env, { query: "아이폰 14 프로" });
    const second = await searchListings(env, { query: "아이폰 14 프로" });

    expect(second.listings).toEqual(first.listings);
    expect(first.detail_failures).toBe(0);
    expect(first.search_word).toBe("아이폰14프로");
    expect(first.source_url).toBe(
      "https://m.bunjang.co.kr/keywords/%EC%95%84%EC%9D%B4%ED%8F%B014%ED%94%84%EB%A1%9C",
    );
    expect(first.listings[0].description).toBe("판매자가 작성한 상품 설명");
    expect(first.listings[0].image_urls).toEqual([
      "https://media.bunjang.co.kr/product/431514555_1_stamp.jpg",
      "https://media.bunjang.co.kr/product/431514555_2_stamp.jpg",
    ]);
    // No cache means the second call repeats every upstream request.
    expect(upstream.searchCursors).toEqual([null, null]);
    expect(upstream.detailCalls).toEqual([431514555, 431514555]);
  });

  it("sends the browser-shaped headers the Python client sent", async () => {
    const upstream = stubUpstream(new Map([[null, initialPayload([], 0, null)]]));

    await searchListings(env, { query: "아이폰", includeDetails: false });

    const headers = upstream.requests[0].headers;
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("accept-language")).toBe("ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7");
    expect(headers.get("origin")).toBe("https://m.bunjang.co.kr");
    expect(headers.get("referer")).toBe("https://m.bunjang.co.kr/");
    expect(headers.get("user-agent")).toBe("test-agent");
  });

  it("can skip detail requests", async () => {
    const upstream = stubUpstream(
      new Map([[null, initialPayload([product(431514555, 430000)], 1, null)]]),
    );

    const result = await searchListings(env, { query: "아이폰 14 프로", includeDetails: false });

    expect(result.listings[0].description).toBeNull();
    expect(result.detail_failures).toBe(0);
    expect(upstream.detailCalls).toEqual([]);
  });

  it("uses an explicit search_word instead of normalizing the query", async () => {
    const upstream = stubUpstream(new Map([[null, initialPayload([], 0, null)]]));

    const result = await searchListings(env, {
      query: "how much is an iphone",
      searchWord: "  아이폰 15  ",
      includeDetails: false,
    });

    expect(result.search_word).toBe("아이폰 15");
    expect(new URL(upstream.requests[0].url).searchParams.get("q")).toBe("아이폰 15");
  });

  it("crosses an upstream page boundary for an offset and returns next_offset", async () => {
    const pages = new Map<string | null, unknown>([
      [null, initialPayload([product(1, 100), product(2, 200), product(3, 300)], 6, "page-2")],
      [
        "page-2",
        continuationPayload(
          [product(3, 300), product(4, 400), product(5, 500), product(6, 600)],
          6,
          null,
        ),
      ],
    ]);
    const upstream = stubUpstream(pages);

    const result = await searchListings(env, {
      query: "아이폰",
      offset: 2,
      maxListings: 3,
      includeDetails: false,
    });

    // Product 3 is repeated across the page boundary and is counted once.
    expect(result.listings.map((listing) => listing.product_id)).toEqual([3, 4, 5]);
    expect(result.offset).toBe(2);
    expect(result.next_offset).toBe(5);
    expect(result.has_more).toBe(true);
    expect(result.total_count).toBe(6);
    expect(result.summary.sample_size).toBe(3);
    expect(result.summary.average_price_krw).toBe(400);
    expect(result.summary.lowest_price_krw).toBe(300);
    expect(result.summary.highest_price_krw).toBe(500);
    expect(upstream.searchCursors).toEqual([null, "page-2"]);

    const final = await searchListings(env, {
      query: "아이폰",
      offset: result.next_offset!,
      maxListings: 3,
      includeDetails: false,
    });
    expect(final.listings.map((listing) => listing.product_id)).toEqual([6]);
    expect(final.next_offset).toBeNull();
    expect(final.has_more).toBe(false);
    // The Python service answered this from cache; the Worker re-walks both pages.
    expect(upstream.searchCursors).toEqual([null, "page-2", null, "page-2"]);
  });

  it("stops on a repeated cursor instead of looping", async () => {
    const pages = new Map<string | null, unknown>([
      [null, initialPayload([product(1, 100)], 50, "loop")],
      ["loop", continuationPayload([product(1, 100)], 50, "loop")],
    ]);
    const upstream = stubUpstream(pages);

    const result = await searchListings(env, { query: "아이폰", maxListings: 5, includeDetails: false });

    expect(result.listings.map((listing) => listing.product_id)).toEqual([1]);
    expect(upstream.searchCursors).toEqual([null, "loop"]);
  });

  it("keeps the listing when its detail request fails, and counts it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(new Request(input).url);
        if (url.pathname.startsWith("/api/pms/")) return new Response("nope", { status: 500 });
        return Response.json(initialPayload([product(7, 700)], 1, null));
      }),
    );

    const result = await searchListings(env, { query: "아이폰" });

    expect(result.listings).toHaveLength(1);
    expect(result.detail_failures).toBe(1);
    expect(result.listings[0].price_krw).toBe(700);
    expect(result.listings[0].description).toBeNull();
    expect(result.listings[0].image_urls).toEqual([
      "https://media.bunjang.co.kr/product/7_1_stamp_w360.jpg",
    ]);
  });

  it("surfaces an upstream search failure as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })),
    );

    await expect(searchListings(env, { query: "아이폰", includeDetails: false })).rejects.toThrow(
      /non-JSON content/,
    );
  });

  it("rejects out-of-range paging arguments", async () => {
    stubUpstream(new Map());
    await expect(searchListings(env, { query: "아이폰", offset: -1 })).rejects.toThrow(/offset/);
    await expect(searchListings(env, { query: "아이폰", maxListings: 0 })).rejects.toThrow(
      /max_listings/,
    );
    await expect(searchListings(env, { query: "아이폰", maxListings: 61 })).rejects.toThrow(
      /max_listings/,
    );
  });
});
