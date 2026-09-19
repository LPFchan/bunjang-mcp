# Bunjang MCP

An MCP server for searching public listings on [Bunjang](https://m.bunjang.co.kr),
running as a Cloudflare Worker behind the Common Auth gateway.

## Tools

- `bunjang_search`: returns matching listings and an average, highest, and lowest asking price for the returned listings.

The tool returns listing URLs, prices, sale status, seller and engagement metadata, seller descriptions, and original-size product image URLs. Set `include_details=false` to skip one detail request per returned listing when speed matters more than descriptions and full images.

Results default to 20 listings. To continue, pass the returned `next_offset` as the next call's `offset`. `has_more` says whether more listings are available. The service handles Bunjang's internal cursor pagination, crosses its 60-entry upstream page boundaries, and removes repeated promoted products. Since marketplace results change over time, consecutive pages are not a permanent snapshot.

The summary describes current asking prices among the listings returned by that call. It is not a sold-price history. External shopping ads are excluded from listings and price calculations. `max_listings` is limited to 60 per call.

There is no cache. Module-level state does not reliably persist between
Worker requests, so every call fetches fresh data from Bunjang.

Detail-enriched calls (`include_details=true`) make one upstream request per
listing, up to eight at a time. Any of those can fail (a Bunjang error, a
timeout, or a Workers subrequest limit); the listing is still returned with
its search-page fields only, and `detail_failures` in the result counts how
many came back that way. A partial result is reported, never hidden.

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

Send a Common Auth token as `Authorization: Bearer <token>` or
`X-API-Key: <token>` (scope `bunjang`). Machine tokens and OAuth access
tokens are both accepted. Clients speaking MCP `2026-07-28`, `2025-06-18`
and `2025-03-26` are all served; `2026-07-28` clients are told to cache the
tool list for five minutes.

## How it is reached

```
client -> bunjang.lost.plus/mcp -> auth-gateway Worker -> [BUNJANG service binding] -> this Worker
```

- **Routes.** This Worker holds none (`wrangler.toml` has no `routes`,
  `workers_dev = false`). `bunjang.lost.plus/mcp`, `/mcp/*`, `/healthz` and
  `/.well-known/oauth-protected-resource*` are zone routes on the
  `auth-gateway` Worker (`auth/gateway/wrangler.toml`).
- **Auth.** The gateway's route table
  (`auth/gateway/config/cloudflare.gateway.json`) has
  `{"host": "bunjang.lost.plus", "policy": "mcp", "token_scope": "bunjang",
  "binding": "BUNJANG"}`. The gateway validates the credential with the hub,
  strips it, and forwards over the `BUNJANG` service binding with the caller
  in `x-lost-plus-{sub,email,name,role,encoding}` headers. This Worker reads
  those with the shared
  [`@lpfchan/gateway-identity`](https://github.com/LPFchan/auth/tree/main/packages/gateway-identity)
  package and never sees a token. A request without a complete
  identity is refused with 500, because nothing but the gateway can reach
  this Worker and such a request means the deployment is wrong.
- **Gateway-answered paths.** `/healthz` returns `ok` as `text/plain`;
  `/.well-known/oauth-protected-resource/mcp` is the OAuth metadata document;
  a bad or missing token gets a 401 with a `WWW-Authenticate` challenge. None
  of those reach this Worker, which serves `/mcp` (and `/mcp/`) only.
- **State.** None. No D1, KV or R2; everything is plain `[vars]`.

## Deploy

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run deploy      # passage run --env CLOUDFLARE_API_TOKEN=infra/CF_MASTER_TOKEN -- wrangler deploy
```

The deploy token comes from passage at deploy time (`infra` /
`CF_MASTER_TOKEN`, through the `passage` setup module); an already-exported
`CLOUDFLARE_API_TOKEN` wins if one is set.

Deploying only replaces this Worker's code; routes live on the gateway and
are untouched. To roll back, `git revert` (or check out the previous commit)
and `npm run deploy` again. Adding a route to this Worker's `wrangler.toml`
would steal it from the gateway and expose an unauthenticated entrance; see
the comment there.

No secrets are required. Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BUNJANG_BASE_URL` | `https://m.bunjang.co.kr` | Public listing-page base URL |
| `BUNJANG_API_BASE_URL` | `https://api.bunjang.co.kr` | Public JSON API base URL |
| `BUNJANG_TIMEOUT_SECONDS` | `20` | Upstream request timeout |
| `BUNJANG_USER_AGENT` | Safari-compatible value | Upstream HTTP user agent |

## History

Until 2026-09-18 this ran as a Python container (`python/`, FastMCP, port
8004 on `oci-ubuntu` behind the Cloudflare tunnel and the local Rust
gateway). The Worker port replaced it; `python/` was removed on 2026-09-19
once its tests were ported to `test/`. The Python server's in-memory cache,
`force_refresh` argument and `from_cache` field did not survive the port.
