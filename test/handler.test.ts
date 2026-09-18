// The Worker's fetch entry: identity gate, path handling, and the MCP
// handshake for each protocol era this server is expected to serve.

import { describe, expect, it } from "vitest";
import worker, { type Env } from "../index";

const env: Env = {
  BUNJANG_BASE_URL: "https://m.bunjang.co.kr",
  BUNJANG_API_BASE_URL: "https://api.bunjang.co.kr",
  BUNJANG_TIMEOUT_SECONDS: "20",
  BUNJANG_USER_AGENT: "test-agent",
};

// What the gateway attaches after it has validated the caller.
const IDENTITY = {
  "x-lost-plus-sub": "acct_123",
  "x-lost-plus-email": "me%40lost.plus",
  "x-lost-plus-name": "%EC%97%AC%EC%9A%B8",
  "x-lost-plus-role": "administrator",
  "x-lost-plus-encoding": "percent-utf8",
};

function mcpRequest(body: unknown, extraHeaders: Record<string, string> = {}, path = "/mcp") {
  return new Request(`https://bunjang.lost.plus${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...IDENTITY,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function initialize(protocolVersion: string) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  };
}

// A 2026-07-28 request is stateless: no initialize, the claim rides in
// params._meta on every request.
function modern(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
      },
    },
  };
}

async function jsonBody(response: Response): Promise<any> {
  const raw = await response.text();
  // The stateless handler may answer as JSON or as a single SSE event.
  const dataLine = raw
    .split("\n")
    .find((line) => line.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5) : raw);
}

describe("identity gate", () => {
  it("refuses a request with no gateway identity", async () => {
    const request = new Request("https://bunjang.lost.plus/mcp", { method: "POST" });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "no gateway identity" });
  });

  it("refuses a partial identity", async () => {
    const request = mcpRequest(initialize("2025-06-18"), { "x-lost-plus-email": "" });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(500);
  });

  it("never honours a bearer token on its own", async () => {
    const request = new Request("https://bunjang.lost.plus/mcp", {
      method: "POST",
      headers: { authorization: "Bearer whatever", "content-type": "application/json" },
      body: JSON.stringify(initialize("2025-06-18")),
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(500);
  });
});

describe("paths", () => {
  it("serves nothing but /mcp", async () => {
    for (const path of ["/", "/healthz", "/.well-known/oauth-protected-resource", "/mcp/x"]) {
      const response = await worker.fetch(mcpRequest(initialize("2025-06-18"), {}, path), env);
      expect(response.status, path).toBe(404);
    }
  });

  it("accepts a trailing slash on /mcp", async () => {
    const response = await worker.fetch(mcpRequest(initialize("2025-06-18"), {}, "/mcp/"), env);
    expect(response.status).toBe(200);
  });
});

describe("MCP handshake", () => {
  for (const version of ["2025-06-18", "2025-03-26"]) {
    it(`initializes a ${version} client`, async () => {
      const response = await worker.fetch(mcpRequest(initialize(version)), env);
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      expect(body.result.protocolVersion).toBe(version);
      expect(body.result.serverInfo.name).toBe("bunjang-mcp");
      expect(body.result.capabilities.tools).toBeDefined();
    });
  }

  it("lists the tool for a legacy client", async () => {
    const response = await worker.fetch(
      mcpRequest(
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { "mcp-protocol-version": "2025-06-18" },
      ),
      env,
    );
    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["bunjang_search"]);
    const schema = body.result.tools[0].inputSchema;
    expect(schema.required).toEqual(["query"]);
    expect(schema.properties.max_listings).toMatchObject({ minimum: 1, maximum: 60, default: 20 });
    expect(schema.properties.offset).toMatchObject({ minimum: 0, default: 0 });
    expect(schema.properties.include_details).toMatchObject({ default: true });
    // Legacy results never carry the 2026 cache fields.
    expect(body.result.ttlMs).toBeUndefined();
  });

  it("lists the tool with a five-minute private cache hint for a 2026-07-28 client", async () => {
    const response = await worker.fetch(
      mcpRequest(modern("tools/list"), {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      }),
      env,
    );
    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["bunjang_search"]);
    expect(body.result.ttlMs).toBe(300_000);
    expect(body.result.cacheScope).toBe("private");
  });

  it("answers server/discover for a 2026-07-28 client", async () => {
    const response = await worker.fetch(
      mcpRequest(modern("server/discover"), {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      }),
      env,
    );
    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.result.ttlMs).toBe(300_000);
    expect(body.result.cacheScope).toBe("private");
  });

  it("returns a tool error rather than an HTTP error when Bunjang is unreachable", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    try {
      const args = { query: "아이폰", include_details: false };

      const legacy = await worker.fetch(
        mcpRequest(
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "bunjang_search", arguments: args },
          },
          { "mcp-protocol-version": "2025-06-18" },
        ),
        env,
      );
      expect(legacy.status).toBe(200);
      const legacyBody = await jsonBody(legacy);
      expect(legacyBody.result.isError).toBe(true);
      expect(legacyBody.result.content[0].text).toMatch(/Could not fetch Bunjang API endpoint/);

      // Same call on the 2026-07-28 wire: the tool name also rides in Mcp-Name.
      const modernCall = await worker.fetch(
        mcpRequest(modern("tools/call", { name: "bunjang_search", arguments: args }), {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "bunjang_search",
        }),
        env,
      );
      expect(modernCall.status).toBe(200);
      const modernBody = await jsonBody(modernCall);
      expect(modernBody.result.isError).toBe(true);
      expect(modernBody.result.content[0].text).toMatch(/Could not fetch Bunjang API endpoint/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
