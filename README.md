# Bunjang MCP

An MCP server for searching public listings on [Bunjang](https://m.bunjang.co.kr).

## Tools

- `bunjang_search`: returns matching listings and an average, highest, and lowest asking price for the returned listings.

The tool returns listing URLs, prices, sale status, seller and engagement metadata, seller descriptions, and original-size product image URLs. Set `include_details=false` to skip one detail request per returned listing when speed matters more than descriptions and full images.

Results default to 20 listings. To continue, pass the returned `next_offset` as the next call's `offset`. `has_more` says whether more listings are available. The service handles Bunjang's internal cursor pagination, crosses its 60-entry upstream page boundaries, and removes repeated promoted products. Since marketplace results change over time, consecutive pages are not a permanent snapshot.

The summary describes current asking prices among the listings returned by that call. It is not a sold-price history. External shopping ads are excluded from listings and price calculations. `max_listings` is limited to 60 per call.

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
