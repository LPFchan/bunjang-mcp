
// bunjang-mcp Worker: MCP server on Cloudflare Workers, port of the
// Python bunjang-mcp (Bunjang marketplace search). Authenticates machine
// tokens directly against Common Auth (whoami) instead of the loopback
// gateway.
//
// Unlike the Python server there is NO in-memory cache: module-level state
// does not reliably persist between Worker requests, so every tool call
// fetches fresh data and always reports from_cache=false.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export interface Env {
  AUTH_URL: string;
  TOKEN_SCOPE: string;
  BUNJANG_BASE_URL: string;
  BUNJANG_API_BASE_URL: string;
  BUNJANG_TIMEOUT_SECONDS: string;
  BUNJANG_USER_AGENT: string;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const DETAIL_CONCURRENCY = 8;

// --- auth --------------------------------------------------------------------

interface Identity {
  sub: string;
  email: string;
  name: string;
  role: string;
  services?: string[];
}

// Validate a credential against Common Auth. Two token types:
//   - machine tokens: GET /api/whoami?service=<scope>
//   - OAuth access tokens: GET /api/oauth/introspect?resource=<resource>&scope=<scope>
// Try whoami first (machine tokens), then introspect (OAuth). Mirrors the gateway.
async function validateToken(env: Env, token: string, requestUrl: string): Promise<Identity | null> {
  const resource = new URL(requestUrl).origin + "/mcp";

  // Machine token path
  try {
    const url = new URL("/api/whoami", env.AUTH_URL);
    url.searchParams.set("service", env.TOKEN_SCOPE);
    const resp = await fetch(url.toString(), {
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const identity = (await resp.json()) as Identity;
      if (
        identity.sub &&
        identity.email &&
        identity.name &&
        (identity.role === "administrator" || identity.role === "user")
      ) {
        return identity;
      }
    }
  } catch { /* fall through to introspect */ }

  // OAuth access token path
  try {
    const url = new URL("/api/oauth/introspect", env.AUTH_URL);
    url.searchParams.set("resource", resource);
    url.searchParams.set("scope", env.TOKEN_SCOPE);
    const resp = await fetch(url.toString(), {
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const identity = (await resp.json()) as Identity;
      if (
        identity.sub &&
        identity.email &&
        identity.name &&
        (identity.role === "administrator" || identity.role === "user")
      ) {
        return identity;
      }
    }
  } catch { /* reject */ }

  return null;
}

function extractToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const apiKey = request.headers.get("x-api-key");
  if (apiKey) return apiKey.trim();
  return null;
}

// MCP OAuth 2.0 Protected Resource Metadata — required by MCP clients
// (Claude.ai, etc.) to discover the authorization server.
function wwwAuthenticate(request: Request): string {
  const url = new URL(request.url);
  const metadata = url.origin + "/.well-known/oauth-protected-resource/mcp";
  return 'Bearer realm="auth.lost.plus", resource_metadata="' + metadata + '", scope="bunjang", error="invalid_token"';
}

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
  summary: PriceSummary;
  listings: Listing[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseSearchResponse(payload: unknown): SearchPage {
  const searchResponse = findSearchResponse(payload);

  const rawItems = searchResponse["data"];
  const items = Array.isArray(rawItems) ? rawItems : [];

  const listings: Listing[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (!record || record["type"] !== "PRODUCT" || record["pid"] == null) continue;
    listings.push(parseSearchListing(record));
  }

  const rawCursor = searchResponse["cursor"] ?? searchResponse["nextCursor"];
  const rawTotal = searchResponse["totalCount"];
  return {
    total_count:
      rawTotal != null && !Number.isNaN(Number(rawTotal)) ? Number(rawTotal) : listings.length,
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
    const blocks = searchSpec["uiBlockList"];
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        const record = asRecord(block);
        if (record && record["blockType"] === "productList.grid.main") {
          const candidate = asRecord(record["searchResponse"]);
          if (candidate) return candidate;
        }
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
    price_krw: item["price"] != null ? Number(item["price"]) : 0,
    listing_url: `https://m.bunjang.co.kr/products/${productId}`,
    thumbnail_url: thumbnailUrl,
    description: null,
    image_urls: thumbnailUrl ? [thumbnailUrl] : [],
    status: item["status"] != null ? String(item["status"]) : null,
    condition: null,
    updated_at: item["updatedAt"] != null ? String(item["updatedAt"]) : null,
    category_name: null,
    brand_name: null,
    seller_id: shop["uid"] != null ? Number(shop["uid"]) : null,
    seller_name: null,
    official_seller: shop["isOfficialSeller"] != null ? Boolean(shop["isOfficialSeller"]) : null,
    favorite_count: item["favoriteCount"] != null ? Number(item["favoriteCount"]) : null,
    chat_count: item["buntalkCount"] != null ? Number(item["buntalkCount"]) : null,
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

  const imageCount = product["imageCount"] != null ? Number(product["imageCount"]) : 0;

  return {
    description: product["description"] != null ? String(product["description"]) : null,
    image_urls: originalImageUrls(product["imageUrl"], imageCount),
    condition: product["condition"] != null ? String(product["condition"]) : null,
    category_name: category["name"] != null ? String(category["name"]) : null,
    brand_name: brand["name"] != null ? String(brand["name"]) : null,
    seller_name: shop["name"] != null ? String(shop["name"]) : null,
    view_count: metrics["viewCount"] != null ? Number(metrics["viewCount"]) : null,
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
    summary: summarize(selected),
    listings: selected,
  };

  if (includeDetails) await enrichListings(env, result.listings);
  return result;
}

async function enrichListings(env: Env, listings: Listing[]): Promise<void> {
  const productIds = [...new Set(listings.map((listing) => listing.product_id))];
  const detailsById = new Map<number, ListingDetails>();

  // Match the Python semaphore: at most DETAIL_CONCURRENCY detail requests in flight.
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < productIds.length) {
      const productId = productIds[nextIndex++];
      let details: ListingDetails;
      try {
        details = parseProductDetail(await fetchProductDetail(env, productId));
      } catch {
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
}

// --- MCP server -------------------------------------------------------------------

function text(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "bunjang-mcp", version: "0.1.0" });

  server.tool(
    "bunjang_search",
    "Search Bunjang listings and summarize their current asking prices. Returns matching listings plus average, highest, and lowest asking price for the returned listings. To paginate, pass the returned next_offset as the next call's offset; has_more says whether more listings are available. The in-memory cache from the Python server does not exist on Workers: every call fetches fresh data and from_cache is always false.",
    {
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
        .describe("Fetch descriptions and original-size image URLs"),
    },
    async ({ query, search_word, offset, max_listings, include_details }) => {
      const result = await searchListings(env, {
        query,
        searchWord: search_word ?? null,
        offset,
        maxListings: max_listings,
        includeDetails: include_details,
      });
      return text(result);
    },
  );

  return server;
}

// --- CORS (permissive: reflect the request origin) --------------------------------

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name, last-event-id, x-api-key",
    "access-control-max-age": "86400",
    "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, content-type",
  };
  if (origin) h["access-control-allow-origin"] = origin;
  return h;
}

// --- entry -------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true }, { headers: corsHeaders(origin) });
    }

    // Serve the OAuth protected-resource metadata so the whole discovery
    // chain works even when the auth gateway is down.
    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp"
    ) {
      return Response.json(
        {
          authorization_servers: ["https://auth.lost.plus"],
          bearer_methods_supported: ["header"],
          resource: url.origin + "/mcp",
          scopes_supported: ["bunjang"],
        },
        { headers: { ...corsHeaders(origin), "cache-control": "no-store" } },
      );
    }

    if (url.pathname === "/" || url.pathname === "") {
      return Response.json(
        {
          name: "bunjang-mcp",
          runtime: "cloudflare-workers",
          mcp_path: "/mcp",
          healthz: "/healthz",
          tools: ["bunjang_search"],
        },
        { headers: corsHeaders(origin) },
      );
    }

    if (url.pathname !== "/mcp") {
      return new Response("not found", { status: 404, headers: corsHeaders(origin) });
    }

    // Auth: every /mcp request must carry a valid scoped token.
    const token = extractToken(request);
    if (!token) {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401,
        headers: { ...corsHeaders(origin), "content-type": "application/json", "www-authenticate": wwwAuthenticate(request) },
      });
    }
    const identity = await validateToken(env, token, request.url);
    if (!identity) {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401,
        headers: { ...corsHeaders(origin), "content-type": "application/json", "www-authenticate": wwwAuthenticate(request) },
      });
    }

    // Stateless MCP: fresh server + transport per request (no session state).
    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // Attach CORS headers to the MCP response.
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
    headers.set("vary", "Origin");
    return new Response(response.body, { status: response.status, headers });
  },
};
