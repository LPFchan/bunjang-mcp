import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

// bunjang-mcp Worker: MCP server for Bunjang marketplace search on
// Cloudflare Workers. Ported from the Python container that ran on OCI
// until 2026-09-18; the `python/` tree it came from is in git history.
//
// A route-less backend behind the gateway Worker. It authenticates nobody:
// the gateway has already asked auth.lost.plus who the caller is, and hands
// the answer over in x-lost-plus-* headers. See identity.ts, and the routes
// comment in wrangler.toml for why this Worker holds no route of its own.
//
// There is NO in-memory cache: module-level state does not reliably persist
// between Worker requests, so every tool call fetches fresh data and always
// reports from_cache=false. (The Python server cached for five minutes and
// exposed a force_refresh argument; both are gone.)
import { z } from "zod";
import { identityFrom } from "./identity";

export interface Env {
  BUNJANG_BASE_URL: string;
  BUNJANG_API_BASE_URL: string;
  BUNJANG_TIMEOUT_SECONDS: string;
  BUNJANG_USER_AGENT: string;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const DETAIL_CONCURRENCY = 8;

// --- query normalization (port of normalize.py) -------------------------------

const PHRASE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bapple watch\b/g, "애플워치"],
  [/\bairpods max\b/g, "에어팟맥스"],
  [/\bairpods pro\b/g, "에어팟프로"],
  [/\bairpods\b/g, "에어팟"],
  [/\bgalaxy z fold\b/g, "갤럭시z폴드"],
  [/\bgalaxy z flip\b/g, "갤럭시z플립"],
  [/\bgalaxy\b/g, "갤럭시"],
  [/\biphone\b/g, "아이폰"],
  [/\bipad\b/g, "아이패드"],
  [/\bmacbook\b/g, "맥북"],
  [/\bpro max\b/g, "프로맥스"],
  [/\bplus\b/g, "플러스"],
  [/\bultra\b/g, "울트라"],
  [/\bmini\b/g, "미니"],
  [/\bpro\b/g, "프로"],
  [/\bmax\b/g, "맥스"],
];

const NOISE_PATTERNS: RegExp[] = [
  /\bhow much does\b/g,
  /\bhow much do\b/g,
  /\bhow much is\b/g,
  /\bhow much are\b/g,
  /\bhow much\b/g,
  /\bwhat is the price of\b/g,
  /\bprice of\b/g,
  /\bgoing for\b/g,
  /\bgo for\b/g,
  /\bgo these days\b/g,
  /\bthese days\b/g,
  /\bworth\b/g,
  /\bselling for\b/g,
  /\bused\b/g,
  /\bsecond hand\b/g,
  /\bprice\b/g,
  /\bcurrent\b/g,
  /\bdoes\b/g,
  /\bdo\b/g,
  /\bis\b/g,
  /\bare\b/g,
  /\bfor\b/g,
  /\bthe\b/g,
  /\ba\b/g,
  /\ban\b/g,
];

export function normalizeSearchWord(query: string): string {
  const text = query.trim();
  if (!text) throw new Error("query must not be blank");

  let normalized = text.toLowerCase();
  normalized = normalized.replace(/[?!.:,/()[\]{}]+/g, " ");
  normalized = normalized.replace(/\b(\d+)\s*(gb|g|tb)\b/g, "$1");

  for (const [pattern, replacement] of PHRASE_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }
  for (const pattern of NOISE_PATTERNS) {
    normalized = normalized.replace(pattern, " ");
  }

  normalized = normalized.replace(/[^0-9a-zA-Z가-힣]+/g, " ");
  normalized = normalized.replace(/\s+/g, "");

  if (normalized) return normalized;

  const fallback = text.replace(/[^0-9a-zA-Z가-힣]+/g, "");
  if (!fallback) throw new Error("query did not contain a usable search term");
  return fallback;
}

// --- response parsing (port of parser.py) --------------------------------------

export interface PriceSummary {
  sample_size: number;
  average_price_krw: number | null;
  highest_price_krw: number | null;
  lowest_price_krw: number | null;
}

export interface Listing {
  product_id: number;
  title: string;
  price_krw: number;
  listing_url: string;
  thumbnail_url: string | null;
  description: string | null;
  image_urls: string[];
  status: string | null;
  condition: string | null;
  updated_at: string | null;
  category_name: string | null;
  brand_name: string | null;
  seller_id: number | null;
  seller_name: string | null;
  official_seller: boolean | null;
  favorite_count: number | null;
  chat_count: number | null;
  view_count: number | null;
  free_shipping: boolean | null;
  in_person: boolean | null;
  care: boolean | null;
  ad: boolean | null;
}

interface ListingDetails {
  description: string | null;
  image_urls: string[];
  condition: string | null;
  category_name: string | null;
  brand_name: string | null;
  seller_name: string | null;
  view_count: number | null;
  free_shipping: boolean | null;
  in_person: boolean | null;
}

interface SearchPage {
  total_count: number;
  next_cursor: string | null;
  listings: Listing[];
}

export interface BunjangSearchResult {
  query: string;
  search_word: string;
  source_url: string;
  fetched_at: string;
  from_cache: boolean;
  total_count: number;
  offset: number;
  next_offset: number | null;
  has_more: boolean;
  /**
   * Listings whose detail request failed and so carry only search-page
   * fields (description null, thumbnail only). Always 0 when
   * include_details is false. Non-zero usually means the Workers
   * per-invocation subrequest cap was hit: on the free plan that is 50,
   * shared between search pages and detail fetches, so roughly 48 listings
   * per call can be enriched. The Python server had no such limit.
   */
  detail_failures: number;
  summary: PriceSummary;
  listings: Listing[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Integer coercion with the Python parser's `int(x)` shape: a value that is
// not a number is null rather than NaN, so it never leaks into the price
// summary or the JSON as a silent `null` mid-computation.
function asInt(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function parseSearchResponse(payload: unknown): SearchPage {
  const searchResponse = findSearchResponse(payload);

  // The Python parser raised when the product list was present but not a
  // list; treating that as "no products" would report an empty page for a
  // response shape that has actually changed under us.
  const rawItems = searchResponse["data"] ?? [];
  if (!Array.isArray(rawItems)) {
    throw new Error("Bunjang product grid did not contain a product list");
  }

  const listings: Listing[] = [];
  for (const item of rawItems) {
    const record = asRecord(item);
    if (!record || record["type"] !== "PRODUCT" || record["pid"] == null) continue;
    listings.push(parseSearchListing(record));
  }

  const rawCursor = searchResponse["cursor"] ?? searchResponse["nextCursor"];
  return {
    // `totalCount or len(listings)` in the Python: a missing, unparseable or
    // zero count falls back to what the page actually holds.
    total_count: asInt(searchResponse["totalCount"]) || listings.length,
    next_cursor: rawCursor ? String(rawCursor) : null,
    listings,
  };
}

function findSearchResponse(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  const data = root ? asRecord(root["data"]) : null;
  if (!data) throw new Error("Bunjang search response did not contain data");

  const searchSpec = asRecord(data["searchSpec"]);
  if (searchSpec) {
    const blocks = searchSpec["uiBlockList"] ?? [];
    if (!Array.isArray(blocks)) {
      throw new Error("Bunjang search response did not contain UI blocks");
    }
    for (const block of blocks) {
      const record = asRecord(block);
      if (record && record["blockType"] === "productList.grid.main") {
        const candidate = asRecord(record["searchResponse"]);
        if (candidate) return candidate;
      }
    }
  }

  const responses = asRecord(data["responses"]);
  if (responses) {
    const mainGrid = asRecord(responses["mainGrid"]);
    if (mainGrid) {
      const candidate = asRecord(mainGrid["searchResponse"]);
      if (candidate) return candidate;
    }
  }

  throw new Error("Bunjang search response did not contain a product grid");
}

function parseSearchListing(item: Record<string, unknown>): Listing {
  const productId = Number(item["pid"]);
  const shop = asRecord(item["shop"]) ?? {};
  const thumbnailUrl = thumbnailUrlFromTemplate(item["productImage"]);
  return {
    product_id: productId,
    title: item["name"] != null ? String(item["name"]) : "",
    price_krw: asInt(item["price"]) ?? 0,
    listing_url: `https://m.bunjang.co.kr/products/${productId}`,
    thumbnail_url: thumbnailUrl,
    description: null,
    image_urls: thumbnailUrl ? [thumbnailUrl] : [],
    status: item["status"] != null ? String(item["status"]) : null,
    condition: null,
    updated_at: item["updatedAt"] != null ? String(item["updatedAt"]) : null,
    category_name: null,
    brand_name: null,
    seller_id: asInt(shop["uid"]),
    seller_name: null,
    official_seller: shop["isOfficialSeller"] != null ? Boolean(shop["isOfficialSeller"]) : null,
    favorite_count: asInt(item["favoriteCount"]),
    chat_count: asInt(item["buntalkCount"]),
    view_count: null,
    free_shipping: null,
    in_person: null,
    care: item["care"] != null ? Boolean(item["care"]) : null,
    ad: item["ad"] != null ? Boolean(item["ad"]) : null,
  };
}

export function parseProductDetail(payload: unknown): ListingDetails {
  const root = asRecord(payload);
  const data = root ? asRecord(root["data"]) : null;
  const product = data ? asRecord(data["product"]) : null;
  if (!product) throw new Error("Bunjang product response did not contain product data");

  const metrics = asRecord(product["metrics"]) ?? {};
  const trade = asRecord(product["trade"]) ?? {};
  const category = asRecord(product["category"]) ?? {};
  const brand = asRecord(product["brand"]) ?? {};
  const shop = data ? asRecord(data["shop"]) ?? {} : {};

  const imageCount = asInt(product["imageCount"]) ?? 0;

  return {
    description: product["description"] != null ? String(product["description"]) : null,
    image_urls: originalImageUrls(product["imageUrl"], imageCount),
    condition: product["condition"] != null ? String(product["condition"]) : null,
    category_name: category["name"] != null ? String(category["name"]) : null,
    brand_name: brand["name"] != null ? String(brand["name"]) : null,
    seller_name: shop["name"] != null ? String(shop["name"]) : null,
    view_count: asInt(metrics["viewCount"]),
    free_shipping: trade["freeShipping"] != null ? Boolean(trade["freeShipping"]) : null,
    in_person: trade["inPerson"] != null ? Boolean(trade["inPerson"]) : null,
  };
}

function thumbnailUrlFromTemplate(imageTemplate: unknown): string | null {
  if (typeof imageTemplate !== "string" || !imageTemplate) return null;
  return imageTemplate.replace("{cnt}", "1").replace("{res}", "360");
}

function originalImageUrls(imageTemplate: unknown, imageCount: number): string[] {
  if (typeof imageTemplate !== "string" || !imageTemplate || imageCount < 1) return [];
  const originalTemplate = imageTemplate.replace("_w{res}", "").replace("{res}", "");
  const urls: string[] = [];
  for (let index = 1; index <= imageCount; index++) {
    urls.push(originalTemplate.replace("{cnt}", String(index)));
  }
  return urls;
}

// --- upstream API (port of client.py) -------------------------------------------

class BunjangFetchError extends Error {}

function timeoutMs(env: Env): number {
  const seconds = Number.parseFloat(env.BUNJANG_TIMEOUT_SECONDS || "20");
  return Math.round((Number.isFinite(seconds) ? seconds : 20) * 1000);
}

async function getJson(env: Env, url: string, params?: Record<string, string>): Promise<unknown> {
  const baseUrl = (env.BUNJANG_BASE_URL || "https://m.bunjang.co.kr").replace(/\/+$/, "");
  const target = new URL(url);
  if (params) {
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  }
  let resp: Response;
  try {
    resp = await fetch(target.toString(), {
      headers: {
        accept: "application/json",
        "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        origin: baseUrl,
        referer: baseUrl + "/",
        "user-agent": env.BUNJANG_USER_AGENT || DEFAULT_USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs(env)),
    });
  } catch {
    throw new BunjangFetchError("Could not fetch Bunjang API endpoint " + url);
  }
  if (resp.status !== 200) {
    throw new BunjangFetchError(`Bunjang returned HTTP ${resp.status} for ${url}`);
  }
  if (!(resp.headers.get("content-type") ?? "").includes("application/json")) {
    throw new BunjangFetchError("Bunjang returned non-JSON content for " + url);
  }
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    throw new BunjangFetchError("Bunjang returned invalid JSON for " + url);
  }
  if (!asRecord(payload)) {
    throw new BunjangFetchError("Bunjang returned an invalid response for " + url);
  }
  return payload;
}

function buildSearchUrl(env: Env, searchWord: string): string {
  const baseUrl = (env.BUNJANG_BASE_URL || "https://m.bunjang.co.kr").replace(/\/+$/, "");
  return `${baseUrl}/keywords/${encodeURIComponent(searchWord.trim())}`;
}

async function fetchSearch(
  env: Env,
  searchWord: string,
  cursor: string | null,
): Promise<{ sourceUrl: string; payload: unknown }> {
  if (!searchWord.trim()) throw new BunjangFetchError("search_word must not be blank");
  const apiBase = (env.BUNJANG_API_BASE_URL || "https://api.bunjang.co.kr").replace(/\/+$/, "");
  let apiUrl: string;
  let params: Record<string, string>;
  if (cursor === null) {
    apiUrl = `${apiBase}/api/search/v8/pw/product/specs/keyword`;
    params = { q: searchWord };
  } else {
    apiUrl = `${apiBase}/api/search/v8/web/search`;
    params = { q: searchWord, policyKey: "pw.product.keyword", cursor, size: "60" };
  }
  const payload = await getJson(env, apiUrl, params);
  return { sourceUrl: buildSearchUrl(env, searchWord), payload };
}

async function fetchProductDetail(env: Env, productId: number): Promise<unknown> {
  const apiBase = (env.BUNJANG_API_BASE_URL || "https://api.bunjang.co.kr").replace(/\/+$/, "");
  return getJson(env, `${apiBase}/api/pms/v1/products/${productId}/detail/web`);
}

// --- search service (port of service.py, without the cache) ----------------------

function summarize(listings: Listing[]): PriceSummary {
  const prices = listings.map((listing) => listing.price_krw);
  const total = prices.reduce((sum, price) => sum + price, 0);
  return {
    sample_size: prices.length,
    average_price_krw: prices.length ? Math.round(total / prices.length) : null,
    highest_price_krw: prices.length ? Math.max(...prices) : null,
    lowest_price_krw: prices.length ? Math.min(...prices) : null,
  };
}

export async function searchListings(
  env: Env,
  opts: {
    query: string;
    searchWord?: string | null;
    offset?: number;
    maxListings?: number;
    includeDetails?: boolean;
  },
): Promise<BunjangSearchResult> {
  const offset = opts.offset ?? 0;
  const maxListings = opts.maxListings ?? 20;
  const includeDetails = opts.includeDetails ?? true;
  if (offset < 0) throw new Error("offset must not be negative");
  if (maxListings < 1 || maxListings > 60) {
    throw new Error("max_listings must be between 1 and 60");
  }

  const effectiveSearchWord =
    opts.searchWord && opts.searchWord.trim()
      ? opts.searchWord.trim()
      : normalizeSearchWord(opts.query);

  const listings: Listing[] = [];
  const seenProductIds = new Set<number>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  const targetCount = offset + maxListings;
  let sourceUrl = buildSearchUrl(env, effectiveSearchWord);
  let fetchedAt = new Date().toISOString();
  let totalCount = 0;
  let canFetchMore = true;

  while (listings.length < targetCount && canFetchMore) {
    if (cursor !== null) {
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    }

    const { sourceUrl: pageSourceUrl, payload } = await fetchSearch(env, effectiveSearchWord, cursor);
    const page = parseSearchResponse(payload);
    sourceUrl = pageSourceUrl;
    if (listings.length === 0) {
      fetchedAt = new Date().toISOString();
      totalCount = page.total_count;
    }
    for (const listing of page.listings) {
      if (!seenProductIds.has(listing.product_id)) {
        seenProductIds.add(listing.product_id);
        listings.push(listing);
      }
    }
    cursor = page.next_cursor;
    canFetchMore = cursor !== null && listings.length < totalCount;
  }

  const selected = listings.slice(offset, targetCount);
  const nextIndex = offset + selected.length;
  const hasMore = nextIndex < listings.length || (canFetchMore && nextIndex < totalCount);

  const result: BunjangSearchResult = {
    query: opts.query,
    search_word: effectiveSearchWord,
    source_url: sourceUrl,
    fetched_at: fetchedAt,
    from_cache: false,
    total_count: totalCount,
    offset,
    next_offset: hasMore ? nextIndex : null,
    has_more: hasMore,
    detail_failures: 0,
    summary: summarize(selected),
    listings: selected,
  };

  if (includeDetails) result.detail_failures = await enrichListings(env, result.listings);
  return result;
}

/** Enriches in place; returns how many listings could not be enriched. */
async function enrichListings(env: Env, listings: Listing[]): Promise<number> {
  const productIds = [...new Set(listings.map((listing) => listing.product_id))];
  const detailsById = new Map<number, ListingDetails>();
  let failures = 0;

  // Match the Python semaphore: at most DETAIL_CONCURRENCY detail requests in flight.
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < productIds.length) {
      const productId = productIds[nextIndex++];
      let details: ListingDetails;
      try {
        details = parseProductDetail(await fetchProductDetail(env, productId));
      } catch {
        failures++;
        details = {
          description: null,
          image_urls: [],
          condition: null,
          category_name: null,
          brand_name: null,
          seller_name: null,
          view_count: null,
          free_shipping: null,
          in_person: null,
        };
      }
      detailsById.set(productId, details);
    }
  }
  const lanes = Array.from(
    { length: Math.min(DETAIL_CONCURRENCY, productIds.length) },
    () => worker(),
  );
  await Promise.all(lanes);

  for (const listing of listings) {
    const detail = detailsById.get(listing.product_id);
    if (!detail) continue;
    listing.description = detail.description;
    if (detail.image_urls.length) listing.image_urls = [...detail.image_urls];
    listing.condition = detail.condition;
    listing.category_name = detail.category_name;
    listing.brand_name = detail.brand_name;
    listing.seller_name = detail.seller_name;
    listing.view_count = detail.view_count;
    listing.free_shipping = detail.free_shipping;
    listing.in_person = detail.in_person;
  }
  return failures;
}

// --- MCP server -------------------------------------------------------------------

function text(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function buildServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "bunjang-mcp", version: "0.1.0" },
    {
      // 2026-07-28 clients cache the tool list for five minutes instead of
      // re-listing on every session. `private` because the cache scope is a
      // promise about every caller and every deployment; the list happens to
      // be the same for everyone today, but nothing here enforces that.
      // 2025-era clients never see these fields.
      cacheHints: {
        "tools/list": { ttlMs: 300_000, cacheScope: "private" },
        "server/discover": { ttlMs: 300_000, cacheScope: "private" },
      },
    },
  );

  server.registerTool("bunjang_search", { description: "Search Bunjang listings and summarize their current asking prices. Returns matching listings plus average, highest, and lowest asking price for the returned listings. To paginate, pass the returned next_offset as the next call's offset; has_more says whether more listings are available. There is no cache: every call fetches fresh data and from_cache is always false.", inputSchema: z.object({
              query: z.string().describe("Natural-language question or product name to search on Bunjang"),
              search_word: z
                .string()
                .optional()
                .describe("Optional explicit Bunjang search term override, ideally in Korean"),
              offset: z
                .number()
                .int()
                .min(0)
                .default(0)
                .describe("Zero-based listing offset; use next_offset from the previous result"),
              max_listings: z
                .number()
                .int()
                .min(1)
                .max(60)
                .default(20)
                .describe("Maximum listings to return"),
              include_details: z
                .boolean()
                .default(true)
                .describe("Fetch descriptions and original-size image URLs (one upstream request per listing; on the current Workers plan about 48 listings per call can be enriched, and detail_failures in the result counts the ones that were not)"),
            }) }, async ({ query, search_word, offset, max_listings, include_details }) => {
              const result = await searchListings(env, {
                query,
                searchWord: search_word ?? null,
                offset,
                maxListings: max_listings,
                includeDetails: include_details,
              });
              return text(result);
            });

  return server;
}

// --- entry -------------------------------------------------------------------------

/**
 * No identity headers, so no service.
 *
 * The only way to reach this Worker is through a service binding declared by
 * another Worker in the account, and the only Worker that declares one is the
 * gateway, which never forwards a request it has not authorized. So arriving
 * here without an identity means the deployment is wrong -- the gateway's
 * route for this host lost its `mcp` policy, or something else in the account
 * bound to this Worker directly.
 *
 * 500 rather than 401, because it is true. A 401 would tell the caller to
 * authenticate, and the caller may well have done so correctly; the fault is
 * on this side of the binding. Serving the tools anyway is the specific
 * failure the whole gateway arrangement exists to prevent, so this refuses.
 */
function refused(): Response {
  return Response.json(
    { error: "no gateway identity", detail: "this service is only reachable through the gateway" },
    { status: 500 },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Before routing, not after. There is no path here that serves without an
    // identity, so there is no reason for one to be reachable before the check.
    if (identityFrom(request.headers) === null) return refused();

    // /healthz and /.well-known/oauth-protected-resource are the gateway's
    // now (healthz answers `ok` as text/plain, not `{"ok":true}`), and the
    // Python server's `/` index page has no gateway route at all, so the only
    // path that can arrive here is /mcp. `/mcp/` is folded in because the
    // Python server accepted it too and the gateway's `/mcp/*` route
    // forwards it.
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path !== "/mcp") {
      return new Response("not found", { status: 404 });
    }

    // Dual-era MCP: createMcpHandler serves 2026-07-28 (stateless, per-request)
    // and legacy 2025-era clients through the stateless handshake fallback.
    // A fresh handler per request closes over env; each McpServer instance the
    // factory builds is itself per-request.
    //
    // CORS is the gateway's now: under the `mcp` policy it strips
    // access-control-allow-origin and -expose-headers from whatever the
    // backend returns and sets its own (gateway src/responseRewrite.ts).
    return createMcpHandler(() => buildServer(env)).fetch(request);
  },
};
