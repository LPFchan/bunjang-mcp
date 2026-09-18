# Bunjang MCP

An MCP server for searching public listings on [Bunjang](https://m.bunjang.co.kr).

Two runtimes:

- **Cloudflare Workers** (root) — the primary deployment. Runs on Cloudflare's
  edge and validates tokens directly against auth.lost.plus.
- **Python** (`python/`) — the original server, kept as the local-dev fallback.

## Tools

- `bunjang_search`: returns matching listings and an average, highest, and lowest asking price for the returned listings.

The tool returns listing URLs, prices, sale status, seller and engagement metadata, seller descriptions, and original-size product image URLs. Set `include_details=false` to skip one detail request per returned listing when speed matters more than descriptions and full images.

Results default to 20 listings. To continue, pass the returned `next_offset` as the next call's `offset`. `has_more` says whether more listings are available. The service handles Bunjang's internal cursor pagination, crosses its 60-entry upstream page boundaries, and removes repeated promoted products. Since marketplace results change over time, consecutive pages are not a permanent snapshot.

The summary describes current asking prices among the listings returned by that call. It is not a sold-price history. External shopping ads are excluded from listings and price calculations. `max_listings` is limited to 60 per call.

**No cache on Workers.** The Python server caches search pages and product
details in memory (`BUNJANG_CACHE_TTL_SECONDS`, default 300s). Module-level
caches do not reliably persist between Worker requests, so the Worker drops the
cache entirely: every call fetches fresh data from Bunjang and always reports
`from_cache: false`. The Python tool's `force_refresh` parameter is gone for
the same reason. Expect detail-enriched calls (`include_details=true`) to be
slower than warm-cache Python responses.

## Deploy (Workers)

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest: ports of the Python parser/normalize tests
npx wrangler deploy
```

This Worker holds no routes. `bunjang.lost.plus/mcp`, `/mcp/*`, `/healthz` and
`/.well-known/oauth-protected-resource*` are served by the `auth-gateway`
Worker, which reaches this one over its `BUNJANG` service binding. That binding
is the only way in — see the routes comment in `wrangler.toml` before changing
either side.

Callers are unaffected: send a Common Auth token as
`Authorization: Bearer <token>` or `X-API-Key: <token>` (scope `bunjang`) to the
same URL as before, and machine tokens and OAuth access tokens are both still
accepted. What changed is who checks it. The gateway validates the credential,
strips it, and passes the caller down in `x-lost-plus-*` headers; this Worker
reads those and never sees a token (`identity.ts`).

`/healthz` is the gateway's answer now, so it returns `ok` as `text/plain`
rather than `{"ok":true}` as JSON. Anything checking the body rather than the
status needs updating.

No secrets are required for this service; everything is plain `[vars]` in
`wrangler.toml`. `AUTH_URL` and `TOKEN_SCOPE` are gone — the scope lives in the
gateway's route table at `auth/gateway/config/cloudflare.gateway.json`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BUNJANG_BASE_URL` | `https://m.bunjang.co.kr` | Public listing-page base URL |
| `BUNJANG_API_BASE_URL` | `https://api.bunjang.co.kr` | Public JSON API base URL |
| `BUNJANG_TIMEOUT_SECONDS` | `20` | Upstream request timeout |
| `BUNJANG_USER_AGENT` | Safari-compatible value | Upstream HTTP user agent |

## Usage

```json
{
  "mcpServers": {
    "bunjang": {
      "type": "remote",
      "url": "https://bunjang.lost.plus/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

## Local dev (Python fallback)

Requires Python 3.11 or newer.

```sh
cd python
python -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/python -m bunjang_mcp.server
```

Or run `docker compose up --build` from `python/`. Compose publishes the
service at `127.0.0.1:8004` so it can run beside the other MCP services on
the production host.

The Python server keeps its in-memory cache and its `force_refresh` tool
parameter, and reads `BUNJANG_CACHE_TTL_SECONDS`, `ALLOWED_ORIGINS`, and
friends from `python/.env.example`. The MCP endpoint is `/mcp`; `/healthz`
is available without authentication. The server uses the official MCP Python
SDK v2 and supports the stateless `2026-07-28` protocol through
`server/discover`, with a stateless legacy fallback for clients that still
use `initialize`.
