# Bunjang MCP

An MCP server for searching public listings on [Bunjang](https://m.bunjang.co.kr).

## Tools

- `bunjang_search_keyword`: returns matching Bunjang listings.
- `bunjang_search_price`: returns the same listings plus an average, highest, and lowest asking price for the product sample returned by Bunjang.

Both tools return listing URLs, prices, sale status, seller and engagement metadata, seller descriptions, and original-size product image URLs. Set `include_details=false` to skip one detail request per returned listing when speed matters more than descriptions and full images.

The summary describes current asking prices in Bunjang's search response. It is not a sold-price history. External shopping ads are excluded from listings and price calculations. Bunjang currently returns at most 60 entries in the initial public search response, so `max_listings` is limited to 60.

## Run

Requires Python 3.11 or newer.

```sh
python -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/python -m bunjang_mcp.server
```

Or run `docker compose up --build`. Compose publishes the service at `127.0.0.1:8004` so it can run beside the other MCP services on the production host.

The MCP endpoint is `/mcp`; `/healthz` is available without authentication. The server uses the official MCP Python SDK v2 and supports the stateless `2026-07-28` protocol through `server/discover`, with a stateless legacy fallback for clients that still use `initialize`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `8000` | Listen port inside the container |
| `BUNJANG_AUTH_TOKEN` | unset | Optional comma-separated bearer, query, or URL-path tokens |
| `BUNJANG_BASE_URL` | `https://m.bunjang.co.kr` | Public listing-page base URL |
| `BUNJANG_API_BASE_URL` | `https://api.bunjang.co.kr` | Public JSON API base URL |
| `BUNJANG_CACHE_TTL_SECONDS` | `300` | In-memory search and detail cache lifetime |
| `BUNJANG_TIMEOUT_SECONDS` | `20` | Upstream request timeout |
| `BUNJANG_USER_AGENT` | Safari-compatible value | Upstream HTTP user agent |
| `ALLOWED_ORIGINS` | `https://chat.lost.plus` | Comma-separated CORS origin patterns |

The Compose service intentionally leaves `BUNJANG_AUTH_TOKEN` unset because public ChatGPT connectors cannot use this server's fixed bearer-token authentication. The tools only read public Bunjang listings.
