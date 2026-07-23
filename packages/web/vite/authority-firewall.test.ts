import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_PROXY_CONTEXT,
  avatarAuthorityTag,
  EXPECTED_AUTHORITY_HEADER,
  firstTreeAuthorityFirewall,
  isOfflineEligibleAuthorityTransportError,
  normalizeViteProxyTarget,
  parseCanonicalServerAuthority,
  SERVER_AUTHORITY_PATH,
  VITE_GENERATION_PATTERN,
  VITE_NAVIGATION_PROOF_QUERY,
} from "./authority-firewall.js";

const S1_AUTHORITY = "http://s1.example.test/api/v1";
const S2_AUTHORITY = "http://s2.example.test/api/v1";
const WS_KEY = Buffer.alloc(16, 7).toString("base64");

type RequestRecord = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

type UpgradeRecord = {
  url: string | undefined;
  headers: IncomingHttpHeaders;
};

type ProbeMode =
  | "ok"
  | "redirect"
  | "status"
  | "content-type"
  | "malformed"
  | "schema"
  | "noncanonical"
  | "oversized"
  | "timeout";

type FakeUpstream = {
  server: Server;
  origin: string;
  requests: RequestRecord[];
  upgrades: UpgradeRecord[];
  authority: string;
  probeMode: ProbeMode;
  upgradeMode: "ok" | "malformed";
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createFakeUpstream(): Promise<FakeUpstream> {
  const state = {
    server: undefined as unknown as Server,
    origin: "",
    requests: [] as RequestRecord[],
    upgrades: [] as UpgradeRecord[],
    authority: S1_AUTHORITY,
    probeMode: "ok" as ProbeMode,
    upgradeMode: "ok" as const,
  };
  state.server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      state.requests.push({
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body: Buffer.concat(chunks),
      });
      if (request.url === SERVER_AUTHORITY_PATH) {
        if (state.probeMode === "timeout") {
          // Keep the response pending until the probe's own abort closes it.
          request.socket.once("close", () => response.destroy());
          return;
        }
        if (state.probeMode === "redirect") {
          response.writeHead(302, { Location: "/somewhere-else" }).end();
          return;
        }
        if (state.probeMode === "status") {
          response.writeHead(500, { "Content-Type": "application/json" }).end('{"error":"no"}');
          return;
        }
        if (state.probeMode === "content-type") {
          response.writeHead(200, { "Content-Type": "text/plain" }).end('{"v":1}');
          return;
        }
        if (state.probeMode === "malformed") {
          response.writeHead(200, { "Content-Type": "application/json" }).end('{"v":1');
          return;
        }
        if (state.probeMode === "schema") {
          response
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ v: 1, authority: state.authority, extra: true }));
          return;
        }
        if (state.probeMode === "noncanonical") {
          response
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ v: 1, authority: `${state.authority}/` }));
          return;
        }
        if (state.probeMode === "oversized") {
          response.writeHead(200, { "Content-Type": "application/json" }).end("x".repeat(4_096));
          return;
        }
        response
          .writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "private, max-age=999",
            "X-Upstream-Secret": "must-not-copy",
          })
          .end(JSON.stringify({ v: 1, authority: state.authority }));
        return;
      }
      if (request.url?.includes("/avatar?")) {
        response
          .writeHead(200, {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=2592000, immutable",
            ETag: '"42"',
          })
          .end("avatar-bytes");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end('{"forwarded":true}');
    });
  });
  state.server.on("upgrade", (request, socket) => {
    state.upgrades.push({ url: request.url, headers: { ...request.headers } });
    if (state.upgradeMode === "malformed") {
      socket.end("HTTP/1.1 malformed\r\n\r\n");
      return;
    }
    const key = request.headers["sec-websocket-key"];
    const accept = createHash("sha1")
      .update(`${typeof key === "string" ? key : ""}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.end();
  });
  state.origin = await listen(state.server);
  return state;
}

async function createTestVite(
  target: string,
  probeTimeoutMs = 500,
): Promise<{ server: ViteDevServer; origin: string }> {
  const server = await createViteServer({
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    plugins: [
      firstTreeAuthorityFirewall({
        target,
        probeTimeoutMs,
        upgradeTimeoutMs: 500,
      }),
    ],
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      proxy: {
        [API_PROXY_CONTEXT]: { target, changeOrigin: true },
      },
    },
  });
  await server.listen();
  const address = server.httpServer?.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function rawSocketRequest(origin: string, requestBytes: string): Promise<string> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    const chunks: Buffer[] = [];
    socket.once("error", reject);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("connect", () => {
      socket.write(requestBytes.replace("{{HOST}}", url.host));
    });
  });
}

async function rawUpgrade(origin: string, target: string, earlyData = ""): Promise<string> {
  return rawSocketRequest(
    origin,
    `GET ${target} HTTP/1.1\r\n` +
      "Host: {{HOST}}\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      `Sec-WebSocket-Key: ${WS_KEY}\r\n` +
      "Sec-WebSocket-Version: 13\r\n" +
      "Cookie: first-tree-secret=cookie\r\n" +
      "Authorization: Bearer should-not-forward\r\n" +
      "X-Forwarded-For: 203.0.113.1\r\n\r\n" +
      earlyData,
  );
}

function expectOnlyAuthorityProbes(records: RequestRecord[]): void {
  // Fetch clients are allowed to retry a 421 on a fresh connection. Whether
  // they do or not, the target may see only the fixed, token-free probe.
  expect(records.length).toBeGreaterThan(0);
  expect(records.every((record) => record.url === SERVER_AUTHORITY_PATH)).toBe(true);
  expect(records.every((record) => record.body.length === 0)).toBe(true);
  expect(records.every((record) => record.headers.authorization === undefined)).toBe(true);
  expect(records.every((record) => record.headers.cookie === undefined)).toBe(true);
}

function navigationProof(authority: string, viteGeneration: string): string {
  return `v1.${viteGeneration}.${Buffer.from(authority, "utf8").toString("base64url")}`;
}

async function readViteGeneration(origin: string): Promise<string> {
  const response = await fetch(`${origin}${SERVER_AUTHORITY_PATH}`);
  const payload = (await response.json()) as { viteGeneration: string };
  expect(payload.viteGeneration).toMatch(VITE_GENERATION_PATTERN);
  return payload.viteGeneration;
}

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("Vite server-authority firewall", () => {
  let upstream: FakeUpstream;
  let vite: ViteDevServer;
  let viteOrigin: string;

  beforeAll(async () => {
    upstream = await createFakeUpstream();
    const running = await createTestVite(upstream.origin);
    vite = running.server;
    viteOrigin = running.origin;
  });

  beforeEach(() => {
    upstream.requests.length = 0;
    upstream.upgrades.length = 0;
    upstream.authority = S1_AUTHORITY;
    upstream.probeMode = "ok";
    upstream.upgradeMode = "ok";
  });

  afterAll(async () => {
    await vite.close();
    await closeServer(upstream.server);
  });

  it("synthesizes the exact authority read from a fresh token-free probe", async () => {
    const response = await fetch(`${viteOrigin}${SERVER_AUTHORITY_PATH}`, {
      headers: {
        Authorization: "Bearer browser-token",
        Cookie: "browser-cookie=secret",
        "X-Browser-Only": "secret",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-upstream-secret")).toBeNull();
    expect(await response.json()).toEqual({
      v: 1,
      authority: S1_AUTHORITY,
      viteGeneration: expect.stringMatching(VITE_GENERATION_PATTERN),
    });
    expect(upstream.requests).toHaveLength(1);
    const probe = upstream.requests[0];
    expect(probe?.url).toBe(SERVER_AUTHORITY_PATH);
    expect(probe?.method).toBe("GET");
    expect(probe?.body).toHaveLength(0);
    expect(probe?.headers.authorization).toBeUndefined();
    expect(probe?.headers.cookie).toBeUndefined();
    expect(probe?.headers[EXPECTED_AUTHORITY_HEADER]).toBeUndefined();
    expect(probe?.headers["x-browser-only"]).toBeUndefined();
    expect(probe?.headers["cache-control"]).toBe("no-store");
  });

  it("uses one stable generation for every response from the same Vite process", async () => {
    const first = (await (await fetch(`${viteOrigin}${SERVER_AUTHORITY_PATH}`)).json()) as {
      viteGeneration: string;
    };
    const second = (await (await fetch(`${viteOrigin}${SERVER_AUTHORITY_PATH}`)).json()) as {
      viteGeneration: string;
    };

    expect(first.viteGeneration).toMatch(VITE_GENERATION_PATTERN);
    expect(second.viteGeneration).toBe(first.viteGeneration);
  });

  it("forwards a matched request only after the probe and preserves the body", async () => {
    const response = await fetch(`${viteOrigin}/api/v1/future/raw-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-First-Tree-Expected-Authority": S1_AUTHORITY,
      },
      body: "business-bytes",
    });

    expect(response.status).toBe(200);
    expect(upstream.requests.map((record) => record.url)).toEqual([SERVER_AUTHORITY_PATH, "/api/v1/future/raw-stream"]);
    expect(upstream.requests[1]?.body.toString()).toBe("business-bytes");
    expect(upstream.requests[1]?.headers[EXPECTED_AUTHORITY_HEADER]).toBe(S1_AUTHORITY);
  });

  it("admits an exact full-page OAuth navigation, strips its proof, and forwards no ambient credentials", async () => {
    const generation = await readViteGeneration(viteOrigin);
    upstream.requests.length = 0;
    const proof = navigationProof(S1_AUTHORITY, generation);
    const response = await rawSocketRequest(
      viteOrigin,
      `GET /api/v1/auth/github/start?next=%2Finvite%2Fprivate&${VITE_NAVIGATION_PROOF_QUERY}=${proof} HTTP/1.1\r\n` +
        "Host: {{HOST}}\r\n" +
        "Connection: close\r\n" +
        "Accept: text/html\r\n" +
        "Accept-Language: en-US\r\n" +
        "User-Agent: FirstTree-Test\r\n" +
        "Cookie: oauth_state_nonce=stale; analytics=ambient\r\n" +
        "Authorization: Bearer stale-access\r\n" +
        "Proxy-Authorization: Basic stale\r\n" +
        "Origin: http://127.0.0.1:5173\r\n" +
        "Referer: http://127.0.0.1:5173/login\r\n" +
        "X-Forwarded-For: 203.0.113.8\r\n" +
        `X-First-Tree-Expected-Authority: ${S1_AUTHORITY}\r\n\r\n`,
    );

    expect(response).toContain(" 200 ");
    expect(upstream.requests.map((record) => record.url)).toEqual([
      SERVER_AUTHORITY_PATH,
      "/api/v1/auth/github/start?next=%2Finvite%2Fprivate",
    ]);
    const forwarded = upstream.requests[1];
    expect(forwarded?.body).toHaveLength(0);
    expect(forwarded?.headers.accept).toBe("text/html");
    expect(forwarded?.headers["accept-language"]).toBe("en-US");
    expect(forwarded?.headers["user-agent"]).toBe("FirstTree-Test");
    expect(forwarded?.headers.cookie).toBeUndefined();
    expect(forwarded?.headers.authorization).toBeUndefined();
    expect(forwarded?.headers["proxy-authorization"]).toBeUndefined();
    expect(forwarded?.headers.origin).toBeUndefined();
    expect(forwarded?.headers.referer).toBeUndefined();
    expect(forwarded?.headers["x-forwarded-for"]).toBeUndefined();
    expect(forwarded?.headers[EXPECTED_AUTHORITY_HEADER]).toBeUndefined();
  });

  it("admits Google start and dev-callback only through the same stripped navigation class", async () => {
    const generation = await readViteGeneration(viteOrigin);
    upstream.requests.length = 0;
    const proof = navigationProof(S1_AUTHORITY, generation);

    const google = await fetch(
      `${viteOrigin}/api/v1/auth/google/start?next=%2Fteam&${VITE_NAVIGATION_PROOF_QUERY}=${proof}`,
    );
    expect(google.status).toBe(200);
    const dev = await fetch(
      `${viteOrigin}/api/v1/auth/github/dev-callback?githubId=1&login=devuser&displayName=Dev+User&${VITE_NAVIGATION_PROOF_QUERY}=${proof}`,
    );
    expect(dev.status).toBe(200);
    expect(upstream.requests.map((record) => record.url)).toEqual([
      SERVER_AUTHORITY_PATH,
      "/api/v1/auth/google/start?next=%2Fteam",
      SERVER_AUTHORITY_PATH,
      "/api/v1/auth/github/dev-callback?githubId=1&login=devuser&displayName=Dev+User",
    ]);
  });

  it.each([
    ["missing proof", "/api/v1/auth/github/start"],
    ["generic header cannot bypass", "/api/v1/auth/github/start?next=%2Fteam"],
    [
      "encoded proof key",
      `/api/v1/auth/github/start?%66t_vite_nav=v1.0123456789abcdef0123456789abcdef.${Buffer.from(S1_AUTHORITY).toString("base64url")}`,
    ],
    ["malformed proof", "/api/v1/auth/github/start?ft_vite_nav=v1.0123456789abcdef0123456789abcdef.not+base64"],
    [
      "unknown business key",
      `/api/v1/auth/github/start?unknown=value&ft_vite_nav=v1.0123456789abcdef0123456789abcdef.${Buffer.from(S1_AUTHORITY).toString("base64url")}`,
    ],
  ])("rejects %s without touching the upstream", async (_label, target) => {
    const response = await fetch(`${viteOrigin}${target}`, {
      headers: { [EXPECTED_AUTHORITY_HEADER]: S1_AUTHORITY },
    });
    expect(response.status).toBe(421);
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects an encoded protected-route alias before generic admission or upstream contact", async () => {
    const response = await rawSocketRequest(
      viteOrigin,
      "GET /api/v1/%61uth/github/start?next=%2Finvite%2Fprivate HTTP/1.1\r\n" +
        "Host: {{HOST}}\r\n" +
        "Connection: close\r\n" +
        "Content-Length: 14\r\n" +
        "Cookie: oauth_state_nonce=ambient\r\n" +
        "Authorization: Bearer ambient-access\r\n" +
        `X-First-Tree-Expected-Authority: ${S1_AUTHORITY}\r\n\r\n` +
        "business-bytes",
    );

    expect(response).toContain(" 421 ");
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects duplicate or non-terminal navigation proofs without touching the upstream", async () => {
    const generation = await readViteGeneration(viteOrigin);
    upstream.requests.length = 0;
    const proof = navigationProof(S1_AUTHORITY, generation);
    const duplicate = await fetch(
      `${viteOrigin}/api/v1/auth/github/start?${VITE_NAVIGATION_PROOF_QUERY}=${proof}&${VITE_NAVIGATION_PROOF_QUERY}=${proof}`,
    );
    const nonTerminal = await fetch(
      `${viteOrigin}/api/v1/auth/github/start?${VITE_NAVIGATION_PROOF_QUERY}=${proof}&next=%2Fteam`,
    );
    expect(duplicate.status).toBe(421);
    expect(nonTerminal.status).toBe(421);
    expect(upstream.requests).toHaveLength(0);
  });

  it("lets a same-generation wrong-server proof expose only the fixed token-free probe", async () => {
    const generation = await readViteGeneration(viteOrigin);
    upstream.requests.length = 0;
    const proof = navigationProof(S2_AUTHORITY, generation);
    const response = await fetch(
      `${viteOrigin}/api/v1/auth/github/start?next=%2Fprivate&${VITE_NAVIGATION_PROOF_QUERY}=${proof}`,
      { headers: { Cookie: "ambient=secret", Authorization: "Bearer secret" } },
    );
    expect(response.status).toBe(421);
    expectOnlyAuthorityProbes(upstream.requests);
  });

  it("rejects a V1/S1 navigation in V2 before probing reachable or unavailable S2", async () => {
    const s1 = await createFakeUpstream();
    const v1 = await createTestVite(s1.origin);
    const s2 = await createFakeUpstream();
    s2.authority = S2_AUTHORITY;
    const v2 = await createTestVite(s2.origin);
    let s2Closed = false;
    try {
      const v1Generation = await readViteGeneration(v1.origin);
      const staleProof = navigationProof(S1_AUTHORITY, v1Generation);
      s2.requests.length = 0;

      const reachableMismatch = await fetch(
        `${v2.origin}/api/v1/auth/github/start?next=%2Finvite%2Fsecret&${VITE_NAVIGATION_PROOF_QUERY}=${staleProof}`,
        { headers: { Cookie: "ambient=secret", Authorization: "Bearer secret" } },
      );
      expect(reachableMismatch.status).toBe(421);
      expect(s2.requests).toHaveLength(0);

      await closeServer(s2.server);
      s2Closed = true;
      const unavailableRetarget = await fetch(
        `${v2.origin}/api/v1/auth/github/start?next=%2Finvite%2Fsecret&${VITE_NAVIGATION_PROOF_QUERY}=${staleProof}`,
      );
      expect(unavailableRetarget.status).toBe(421);
      expect(s2.requests).toHaveLength(0);
    } finally {
      await v1.server.close();
      await v2.server.close();
      await closeServer(s1.server);
      if (!s2Closed) await closeServer(s2.server);
    }
  });

  it("admits the real current-session client and blocks its body after an S1 to S2 authority change", async () => {
    const nativeFetch = globalThis.fetch;
    const storage = createStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const target = typeof input === "string" && input.startsWith("/") ? `${viteOrigin}${input}` : input;
      return nativeFetch(target, init);
    });
    vi.resetModules();
    try {
      const { api, setStoredTokens } = await import("../src/api/client.js");
      setStoredTokens({ accessToken: "current-access", refreshToken: "current-refresh" });

      await expect(api.post<{ forwarded: true }>("/future/current-client", { secret: "s1-body" })).resolves.toEqual({
        forwarded: true,
      });
      expect(upstream.requests.map((record) => record.url)).toEqual([
        SERVER_AUTHORITY_PATH,
        SERVER_AUTHORITY_PATH,
        "/api/v1/future/current-client",
      ]);
      expect(upstream.requests[2]?.headers.authorization).toBe("Bearer current-access");
      expect(upstream.requests[2]?.headers[EXPECTED_AUTHORITY_HEADER]).toBe(S1_AUTHORITY);
      expect(upstream.requests[2]?.body.toString()).toBe('{"secret":"s1-body"}');

      upstream.requests.length = 0;
      upstream.authority = S2_AUTHORITY;
      await expect(api.get("/future/current-client")).rejects.toMatchObject({
        status: 421,
      });
      expectOnlyAuthorityProbes(upstream.requests);
    } finally {
      vi.unstubAllGlobals();
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("returns 421 and forwards no business path, headers, or body on mismatch", async () => {
    const response = await fetch(`${viteOrigin}/api/v1/invitations/private-capability`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-First-Tree-Expected-Authority": S2_AUTHORITY,
        Authorization: "Bearer must-not-forward",
        Cookie: "must-not-forward=1",
      },
      body: '{"private":"capability"}',
    });

    expect(response.status).toBe(421);
    expect(await response.json()).toEqual({ error: "server_authority_mismatch", offlineEligible: false });
    expectOnlyAuthorityProbes(upstream.requests);
  });

  it("rejects missing or non-canonical authority without touching the target", async () => {
    const missing = await fetch(`${viteOrigin}/api/v1/bootstrap/config`);
    expect(missing.status).toBe(421);
    expect(upstream.requests).toHaveLength(0);

    const malformed = await fetch(`${viteOrigin}/api/v1/bootstrap/config`, {
      headers: { "X-First-Tree-Expected-Authority": `${S1_AUTHORITY}/` },
    });
    expect(malformed.status).toBe(421);
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects a duplicate expected-authority header without touching the target", async () => {
    const response = await rawSocketRequest(
      viteOrigin,
      "GET /api/v1/bootstrap/config HTTP/1.1\r\n" +
        "Host: {{HOST}}\r\n" +
        "Connection: close\r\n" +
        `X-First-Tree-Expected-Authority: ${S1_AUTHORITY}\r\n` +
        `X-First-Tree-Expected-Authority: ${S1_AUTHORITY}\r\n\r\n`,
    );

    expect(response).toContain(" 421 ");
    expect(upstream.requests).toHaveLength(0);
  });

  it("exempts only the exact GET authority target", async () => {
    const withQuery = await fetch(`${viteOrigin}${SERVER_AUTHORITY_PATH}?probe=1`);
    expect(withQuery.status).toBe(421);
    const wrongMethod = await fetch(`${viteOrigin}${SERVER_AUTHORITY_PATH}`, { method: "POST" });
    expect(wrongMethod.status).toBe(421);
    expect(upstream.requests).toHaveLength(0);
  });

  it.each<ProbeMode>([
    "redirect",
    "status",
    "content-type",
    "malformed",
    "schema",
    "noncanonical",
    "oversized",
  ])("returns a hard 503 for a %s probe", async (mode) => {
    upstream.probeMode = mode;
    const response = await fetch(`${viteOrigin}/api/v1/future`, {
      headers: { "X-First-Tree-Expected-Authority": S1_AUTHORITY },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "server_authority_unavailable",
      offlineEligible: false,
      viteGeneration: expect.stringMatching(VITE_GENERATION_PATTERN),
    });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.url).toBe(SERVER_AUTHORITY_PATH);
  });

  it("admits only a canonical historical-id avatar target and sanitizes its headers", async () => {
    const tag = avatarAuthorityTag(S1_AUTHORITY);
    const response = await fetch(`${viteOrigin}/api/v1/agents/github-adapter/avatar?v=42&ft_authority=${tag}`, {
      headers: {
        Accept: "image/png",
        "If-None-Match": '"41"',
        "If-Modified-Since": "Tue, 21 Jul 2026 10:00:00 GMT",
        Authorization: "Bearer must-not-forward",
        Cookie: "must-not-forward=1",
        Forwarded: "for=203.0.113.2;host=private.example",
        Origin: "https://private.example",
        "Proxy-Authorization": "Basic must-not-forward",
        Range: "bytes=0-10",
        Referer: "https://private.example/chat",
        "X-Forwarded-For": "203.0.113.1",
        "X-Extension": "private",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("avatar-bytes");
    expect(upstream.requests.map((record) => record.url)).toEqual([
      SERVER_AUTHORITY_PATH,
      `/api/v1/agents/github-adapter/avatar?v=42&ft_authority=${tag}`,
    ]);
    const avatar = upstream.requests[1];
    expect(avatar?.headers.accept).toBe("image/png");
    expect(avatar?.headers["if-none-match"]).toBe('"41"');
    expect(avatar?.headers["if-modified-since"]).toBe("Tue, 21 Jul 2026 10:00:00 GMT");
    expect(avatar?.body).toHaveLength(0);
    expect(avatar?.headers.authorization).toBeUndefined();
    expect(avatar?.headers.cookie).toBeUndefined();
    expect(avatar?.headers.forwarded).toBeUndefined();
    expect(avatar?.headers.origin).toBeUndefined();
    expect(avatar?.headers["proxy-authorization"]).toBeUndefined();
    expect(avatar?.headers.range).toBeUndefined();
    expect(avatar?.headers.referer).toBeUndefined();
    expect(avatar?.headers["x-forwarded-for"]).toBeUndefined();
    expect(avatar?.headers["x-extension"]).toBeUndefined();
  });

  it("never forwards a mismatched or ambiguous avatar path", async () => {
    const wrongTag = avatarAuthorityTag(S2_AUTHORITY);
    const mismatch = await fetch(`${viteOrigin}/api/v1/agents/github-adapter/avatar?v=42&ft_authority=${wrongTag}`);
    expect(mismatch.status).toBe(421);
    expectOnlyAuthorityProbes(upstream.requests);

    upstream.requests.length = 0;
    const encoded = await fetch(
      `${viteOrigin}/api/v1/agents/github%2Dadapter/avatar?v=42&ft_authority=${avatarAuthorityTag(S1_AUTHORITY)}`,
    );
    expect(encoded.status).toBe(421);
    expect(upstream.requests).toHaveLength(0);
  });

  it.each([
    [
      "wrong method",
      "POST",
      `/api/v1/agents/github-adapter/avatar?v=42&ft_authority=${avatarAuthorityTag(S1_AUTHORITY)}`,
    ],
    ["empty id", "GET", `/api/v1/agents//avatar?v=42&ft_authority=${avatarAuthorityTag(S1_AUTHORITY)}`],
    ["uppercase id", "GET", `/api/v1/agents/GitHub/avatar?v=42&ft_authority=${avatarAuthorityTag(S1_AUTHORITY)}`],
    ["dot id", "GET", `/api/v1/agents/github.adapter/avatar?v=42&ft_authority=${avatarAuthorityTag(S1_AUTHORITY)}`],
    [
      "101-character id",
      "GET",
      `/api/v1/agents/${"a".repeat(101)}/avatar?v=42&ft_authority=${avatarAuthorityTag(S1_AUTHORITY)}`,
    ],
    [
      "leading-zero version",
      "GET",
      `/api/v1/agents/github-adapter/avatar?v=042&ft_authority=${avatarAuthorityTag(S1_AUTHORITY)}`,
    ],
    [
      "reordered query",
      "GET",
      `/api/v1/agents/github-adapter/avatar?ft_authority=${avatarAuthorityTag(S1_AUTHORITY)}&v=42`,
    ],
    [
      "duplicate query",
      "GET",
      `/api/v1/agents/github-adapter/avatar?v=42&ft_authority=${avatarAuthorityTag(S1_AUTHORITY)}&ft_authority=${avatarAuthorityTag(S1_AUTHORITY)}`,
    ],
    [
      "unknown query",
      "GET",
      `/api/v1/agents/github-adapter/avatar?v=42&ft_authority=${avatarAuthorityTag(S1_AUTHORITY)}&x=1`,
    ],
    [
      "mixed-case query",
      "GET",
      `/api/v1/agents/github-adapter/avatar?v=42&FT_authority=${avatarAuthorityTag(S1_AUTHORITY)}`,
    ],
  ])("rejects a syntactically invalid avatar target: %s", async (_name, method, target) => {
    const response = await fetch(`${viteOrigin}${target}`, { method });
    expect(response.status).toBe(421);
    expect(upstream.requests).toHaveLength(0);
  });

  it("accepts the historical-id grammar boundaries and canonical UUID form", async () => {
    const tag = avatarAuthorityTag(S1_AUTHORITY);
    const ids = ["-", "_", "a".repeat(100), "018f01f5-78a3-7c10-a921-4a22d4051b44"];
    for (const id of ids) {
      const response = await fetch(`${viteOrigin}/api/v1/agents/${id}/avatar?v=0&ft_authority=${tag}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("avatar-bytes");
    }
    expect(upstream.requests.filter((record) => record.url?.includes("/avatar?"))).toHaveLength(ids.length);
  });

  it("rejects a body-framed avatar request before probing or proxying", async () => {
    const tag = avatarAuthorityTag(S1_AUTHORITY);
    const response = await rawSocketRequest(
      viteOrigin,
      `GET /api/v1/agents/github-adapter/avatar?v=42&ft_authority=${tag} HTTP/1.1\r\n` +
        "Host: {{HOST}}\r\n" +
        "Connection: close\r\n" +
        "Content-Length: 4\r\n\r\nbody",
    );
    expect(response).toContain(" 421 ");
    expect(upstream.requests).toHaveLength(0);
  });

  it("blocks a mismatched admin upgrade before the upstream sees its org path or headers", async () => {
    const response = await rawUpgrade(
      viteOrigin,
      `/api/v1/orgs/org-1/ws/?ft_authority=${encodeURIComponent(S2_AUTHORITY)}`,
    );

    expect(response).toContain(" 421 ");
    expect(upstream.requests.map((record) => record.url)).toEqual([SERVER_AUTHORITY_PATH]);
    expect(upstream.upgrades).toHaveLength(0);
  });

  it("owns a matched admin upgrade and forwards only the query-free sanitized handshake", async () => {
    const response = await rawUpgrade(
      viteOrigin,
      `/api/v1/orgs/org-1/ws/?ft_authority=${encodeURIComponent(S1_AUTHORITY)}`,
    );

    expect(response).toContain("101 Switching Protocols");
    expect(upstream.requests.map((record) => record.url)).toEqual([SERVER_AUTHORITY_PATH]);
    expect(upstream.upgrades).toHaveLength(1);
    const upgrade = upstream.upgrades[0];
    expect(upgrade?.url).toBe("/api/v1/orgs/org-1/ws/");
    expect(upgrade?.headers.cookie).toBeUndefined();
    expect(upgrade?.headers.authorization).toBeUndefined();
    expect(upgrade?.headers["x-forwarded-for"]).toBeUndefined();
    expect(upgrade?.headers["sec-websocket-key"]).toBe(WS_KEY);
    expect(upgrade?.headers["sec-websocket-version"]).toBe("13");
    expect(Object.keys(upgrade?.headers ?? {}).sort()).toEqual([
      "connection",
      "host",
      "sec-websocket-key",
      "sec-websocket-version",
      "upgrade",
    ]);
  });

  it("hard-fails a malformed upstream websocket handshake instead of claiming offline recovery", async () => {
    upstream.upgradeMode = "malformed";
    const response = await rawUpgrade(
      viteOrigin,
      `/api/v1/orgs/org-1/ws/?ft_authority=${encodeURIComponent(S1_AUTHORITY)}`,
    );

    expect(response).toContain(" 503 ");
    expect(response).toContain('"offlineEligible":false');
    expect(response).toMatch(/"viteGeneration":"[a-f0-9]{32}"/u);
    expect(upstream.requests.map((record) => record.url)).toEqual([SERVER_AUTHORITY_PATH]);
    expect(upstream.upgrades).toHaveLength(1);
  });

  it("admits the shared maximum authority through HTTP and the owned upgrade", async () => {
    const maxAuthority = `http://${"a".repeat(2_034)}/api/v1`;
    upstream.authority = maxAuthority;

    const http = await fetch(`${viteOrigin}/api/v1/future`, {
      headers: { "X-First-Tree-Expected-Authority": maxAuthority },
    });
    expect(http.status).toBe(200);

    const websocket = await rawUpgrade(
      viteOrigin,
      `/api/v1/orgs/org-1/ws/?ft_authority=${encodeURIComponent(maxAuthority)}`,
    );
    expect(websocket).toContain("101 Switching Protocols");
    expect(upstream.upgrades.at(-1)?.url).toBe("/api/v1/orgs/org-1/ws/");
  });

  it("rejects unknown, ambiguous, and early-data API upgrades locally", async () => {
    const tag = encodeURIComponent(S1_AUTHORITY);
    const unknown = await rawUpgrade(viteOrigin, `/api/v1/agent/ws/client?ft_authority=${tag}`);
    expect(unknown).toContain(" 421 ");

    const duplicate = await rawUpgrade(viteOrigin, `/api/v1/orgs/org-1/ws/?ft_authority=${tag}&ft_authority=${tag}`);
    expect(duplicate).toContain(" 421 ");

    const early = await rawUpgrade(viteOrigin, `/api/v1/orgs/org-1/ws/?ft_authority=${tag}`, "account-frame");
    expect(early).toContain(" 421 ");
    expect(upstream.requests).toHaveLength(0);
    expect(upstream.upgrades).toHaveLength(0);
  });
});

describe("authority firewall validation", () => {
  it.each([
    ["connection refused", "ECONNREFUSED"],
    ["temporary DNS failure", "EAI_AGAIN"],
    ["unknown DNS host", "ENOTFOUND"],
    ["connection reset", "ECONNRESET"],
    ["OS timeout", "ETIMEDOUT"],
  ])("allows offline recovery only for an explicit %s transport code", (_name, code) => {
    const cause = Object.assign(new Error("must not be inspected"), { code });
    expect(isOfflineEligibleAuthorityTransportError(new TypeError("fetch failed", { cause }))).toBe(true);
  });

  it.each([
    ["self-signed TLS certificate", "DEPTH_ZERO_SELF_SIGNED_CERT"],
    ["TLS hostname mismatch", "ERR_TLS_CERT_ALTNAME_INVALID"],
    ["malformed HTTP response", "HPE_INVALID_CONSTANT"],
    ["truncated response", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH"],
    ["socket/protocol failure", "UND_ERR_SOCKET"],
    ["unsupported protocol", "ERR_INVALID_PROTOCOL"],
  ])("hard-fails a %s error", (_name, code) => {
    const cause = Object.assign(new Error("must not be inspected"), { code });
    expect(isOfflineEligibleAuthorityTransportError(new TypeError("fetch failed", { cause }))).toBe(false);
  });

  it("hard-fails programmer errors and malformed error objects", () => {
    expect(isOfflineEligibleAuthorityTransportError(new TypeError("programmer bug"))).toBe(false);
    expect(isOfflineEligibleAuthorityTransportError({ code: 500 })).toBe(false);
    expect(isOfflineEligibleAuthorityTransportError({ code: "econnrefused" })).toBe(false);

    const circular: { cause?: unknown } = {};
    circular.cause = circular;
    expect(isOfflineEligibleAuthorityTransportError(circular)).toBe(false);

    const throwingAccessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(throwingAccessor, "code", {
      get() {
        throw new Error("programmer getter");
      },
    });
    expect(isOfflineEligibleAuthorityTransportError(throwingAccessor)).toBe(false);
  });

  it("normalizes a target origin and rejects paths or credentials", () => {
    expect(normalizeViteProxyTarget("HTTP://LOCALHOST:80/")).toBe("http://localhost");
    expect(() => normalizeViteProxyTarget("https://user@example.test")).toThrow("must not contain credentials");
    expect(() => normalizeViteProxyTarget("https://example.test/api")).toThrow("must not contain a path");
    expect(() => normalizeViteProxyTarget("ftp://example.test")).toThrow("must use HTTP or HTTPS");
    expect(() => normalizeViteProxyTarget("https://example.test?target=s2")).toThrow("query, or fragment");
    expect(() => normalizeViteProxyTarget("//example.test")).toThrow("absolute HTTP(S) origin");
  });

  it("rejects invalid security bounds at plugin construction", () => {
    expect(() => firstTreeAuthorityFirewall({ target: "http://localhost", probeTimeoutMs: 0 })).toThrow(
      "probeTimeoutMs must be a positive integer",
    );
    expect(() => firstTreeAuthorityFirewall({ target: "http://localhost", probeBodyMaxBytes: -1 })).toThrow(
      "probeBodyMaxBytes must be a positive integer",
    );
    expect(() => firstTreeAuthorityFirewall({ target: "http://localhost", upgradeTimeoutMs: Number.NaN })).toThrow(
      "upgradeTimeoutMs must be a positive integer",
    );
  });

  it("accepts the shared 2048-character authority boundary and rejects the next byte", () => {
    const maxAuthority = `http://${"a".repeat(2_034)}/api/v1`;
    const oversizedAuthority = `http://${"a".repeat(2_035)}/api/v1`;
    expect(Buffer.byteLength(maxAuthority)).toBe(2_048);
    expect(parseCanonicalServerAuthority(maxAuthority)).toBe(maxAuthority);
    expect(Buffer.byteLength(oversizedAuthority)).toBe(2_049);
    expect(parseCanonicalServerAuthority(oversizedAuthority)).toBeNull();
  });

  it("returns an offline-eligible 503 when the authority target cannot be reached", async () => {
    const dead = createHttpServer();
    const deadOrigin = await listen(dead);
    await closeServer(dead);
    const running = await createTestVite(deadOrigin, 100);
    try {
      const response = await fetch(`${running.origin}/api/v1/future`, {
        headers: { "X-First-Tree-Expected-Authority": S1_AUTHORITY },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "server_authority_unavailable",
        offlineEligible: true,
        viteGeneration: expect.stringMatching(VITE_GENERATION_PATTERN),
      });
    } finally {
      await running.server.close();
    }
  });

  it("keeps one generation across an online probe and later same-process offline response", async () => {
    const temporaryUpstream = await createFakeUpstream();
    const running = await createTestVite(temporaryUpstream.origin, 100);
    let upstreamClosed = false;
    try {
      const online = (await (await fetch(`${running.origin}${SERVER_AUTHORITY_PATH}`)).json()) as {
        viteGeneration: string;
      };
      expect(online.viteGeneration).toMatch(VITE_GENERATION_PATTERN);

      await closeServer(temporaryUpstream.server);
      upstreamClosed = true;
      const offlineResponse = await fetch(`${running.origin}${SERVER_AUTHORITY_PATH}`);
      expect(offlineResponse.status).toBe(503);
      const offline = (await offlineResponse.json()) as {
        error: string;
        offlineEligible: boolean;
        viteGeneration: string;
      };
      expect(offline).toEqual({
        error: "server_authority_unavailable",
        offlineEligible: true,
        viteGeneration: online.viteGeneration,
      });
    } finally {
      await running.server.close();
      if (!upstreamClosed) await closeServer(temporaryUpstream.server);
    }
  });

  it("marks only the probe's own timeout abort as offline eligible", async () => {
    const upstream = await createFakeUpstream();
    upstream.probeMode = "timeout";
    const running = await createTestVite(upstream.origin, 25);
    try {
      const response = await fetch(`${running.origin}/api/v1/future`, {
        headers: { "X-First-Tree-Expected-Authority": S1_AUTHORITY },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "server_authority_unavailable",
        offlineEligible: true,
        viteGeneration: expect.stringMatching(VITE_GENERATION_PATTERN),
      });
      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0]?.url).toBe(SERVER_AUTHORITY_PATH);
    } finally {
      await running.server.close();
      await closeServer(upstream.server);
    }
  });
});
