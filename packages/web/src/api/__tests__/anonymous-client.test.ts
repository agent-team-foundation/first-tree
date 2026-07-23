import { beforeEach, describe, expect, it, vi } from "vitest";

const VITE_GENERATION_1 = "0123456789abcdef0123456789abcdef";
const VITE_GENERATION_2 = "fedcba9876543210fedcba9876543210";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function authorityResponse(authority: string, viteGeneration?: string): Response {
  return jsonResponse({ v: 1, authority, ...(viteGeneration === undefined ? {} : { viteGeneration }) });
}

function unavailableResponse(offlineEligible: boolean, viteGeneration = VITE_GENERATION_1): Response {
  return new Response(JSON.stringify({ error: "server_authority_unavailable", offlineEligible, viteGeneration }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

describe("anonymous client and server authority pin", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("probes without credentials, pins authority, and gates anonymous requests", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ v: 1, authority: "https://tree.example/api/v1" }))
      .mockResolvedValueOnce(jsonResponse({ channel: "prod" }));
    vi.stubGlobal("fetch", fetchMock);

    const { anonymousApi } = await import("../anonymous-client.js");
    await expect(anonymousApi.get("/bootstrap/config")).resolves.toEqual({ channel: "prod" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/bootstrap/server-authority",
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/bootstrap/config",
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: expect.objectContaining({ "X-First-Tree-Expected-Authority": "https://tree.example/api/v1" }),
      }),
    );
    const requestHeaders = fetchMock.mock.calls[1]?.[1]?.headers;
    expect(requestHeaders).not.toHaveProperty("Authorization");
    expect(requestHeaders).not.toHaveProperty("Cookie");
  });

  it("never replaces a pinned authority after a retarget", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(authorityResponse("https://s1.example/api/v1", VITE_GENERATION_1))
      .mockResolvedValueOnce(authorityResponse("https://s2.example/api/v1", VITE_GENERATION_1));
    vi.stubGlobal("fetch", fetchMock);

    const { getPinnedServerAuthority, reconcilePinnedServerAuthority } = await import("../server-authority.js");
    await expect(getPinnedServerAuthority()).resolves.toBe("https://s1.example/api/v1");
    await expect(reconcilePinnedServerAuthority("https://s1.example/api/v1")).resolves.toEqual({
      kind: "mismatch",
      expected: "https://s1.example/api/v1",
      observed: "https://s2.example/api/v1",
    });
    await expect(getPinnedServerAuthority()).resolves.toBe("https://s1.example/api/v1");
  });

  it("distinguishes authority match, mismatch, and offline unavailability", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(authorityResponse("https://s1.example/api/v1", VITE_GENERATION_1))
      .mockResolvedValueOnce(authorityResponse("https://s2.example/api/v1", VITE_GENERATION_1))
      .mockResolvedValueOnce(unavailableResponse(true, VITE_GENERATION_1));
    vi.stubGlobal("fetch", fetchMock);

    const { reconcilePinnedServerAuthority } = await import("../server-authority.js");
    await expect(reconcilePinnedServerAuthority("https://s1.example/api/v1")).resolves.toEqual({
      kind: "match",
      authority: "https://s1.example/api/v1",
    });
    await expect(reconcilePinnedServerAuthority("https://s1.example/api/v1")).resolves.toEqual({
      kind: "mismatch",
      expected: "https://s1.example/api/v1",
      observed: "https://s2.example/api/v1",
    });
    await expect(reconcilePinnedServerAuthority("https://s1.example/api/v1")).resolves.toEqual({
      kind: "unavailable",
      expected: "https://s1.example/api/v1",
    });
  });

  it("fails closed for unclassified probe failures and offline-ineligible Vite responses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("TLS or CORS failure"))
      .mockResolvedValueOnce(unavailableResponse(false));
    vi.stubGlobal("fetch", fetchMock);

    let { reconcilePinnedServerAuthority } = await import("../server-authority.js");
    await expect(reconcilePinnedServerAuthority("https://s1.example/api/v1")).rejects.toThrow("failed closed");
    vi.resetModules();
    ({ reconcilePinnedServerAuthority } = await import("../server-authority.js"));
    await expect(reconcilePinnedServerAuthority("https://s1.example/api/v1")).rejects.toThrow("failed closed");
  });

  it("allows offline recovery only after this document pinned the exact authority", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unavailableResponse(true))
      .mockResolvedValueOnce(authorityResponse("https://s1.example/api/v1", VITE_GENERATION_1))
      .mockResolvedValueOnce(unavailableResponse(true));
    vi.stubGlobal("fetch", fetchMock);

    let { getPinnedServerAuthority, reconcilePinnedServerAuthority } = await import("../server-authority.js");
    await expect(reconcilePinnedServerAuthority("https://s1.example/api/v1")).rejects.toThrow(
      "requires a verified document authority",
    );
    vi.resetModules();
    ({ getPinnedServerAuthority, reconcilePinnedServerAuthority } = await import("../server-authority.js"));
    await expect(getPinnedServerAuthority()).resolves.toBe("https://s1.example/api/v1");
    await expect(reconcilePinnedServerAuthority("https://s1.example/api/v1")).resolves.toEqual({
      kind: "unavailable",
      expected: "https://s1.example/api/v1",
    });
  });

  it("fails closed when an offline response belongs to a restarted Vite process", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(authorityResponse("https://s1.example/api/v1", VITE_GENERATION_1))
      .mockResolvedValueOnce(unavailableResponse(true, VITE_GENERATION_2));
    vi.stubGlobal("fetch", fetchMock);

    const { getPinnedServerAuthority, reconcilePinnedServerAuthority } = await import("../server-authority.js");
    await expect(getPinnedServerAuthority()).resolves.toBe("https://s1.example/api/v1");
    await expect(reconcilePinnedServerAuthority("https://s1.example/api/v1")).rejects.toThrow(
      "requires a verified document authority",
    );
  });

  it("fails closed when a reachable authority belongs to a restarted Vite process", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(authorityResponse("https://s1.example/api/v1", VITE_GENERATION_1))
      .mockResolvedValueOnce(authorityResponse("https://s1.example/api/v1", VITE_GENERATION_2));
    vi.stubGlobal("fetch", fetchMock);

    const { getPinnedServerAuthority, reconcilePinnedServerAuthority } = await import("../server-authority.js");
    await expect(getPinnedServerAuthority()).resolves.toBe("https://s1.example/api/v1");
    await expect(reconcilePinnedServerAuthority("https://s1.example/api/v1")).rejects.toThrow(
      "authority process changed",
    );
  });

  it("does not treat a production authority pin as a Vite offline proof", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(authorityResponse("https://s1.example/api/v1"))
      .mockResolvedValueOnce(unavailableResponse(true, VITE_GENERATION_1));
    vi.stubGlobal("fetch", fetchMock);

    const { getPinnedServerAuthority, reconcilePinnedServerAuthority } = await import("../server-authority.js");
    await expect(getPinnedServerAuthority()).resolves.toBe("https://s1.example/api/v1");
    await expect(reconcilePinnedServerAuthority("https://s1.example/api/v1")).rejects.toThrow(
      "requires a verified document authority",
    );
  });

  it("rejects a classified offline response without an exact Vite generation", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "server_authority_unavailable", offlineEligible: true }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { reconcilePinnedServerAuthority } = await import("../server-authority.js");
    await expect(reconcilePinnedServerAuthority("https://s1.example/api/v1")).rejects.toThrow("failed closed");
  });

  it("never probes through a conflicting document pin", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ v: 1, authority: "https://s1.example/api/v1" }));
    vi.stubGlobal("fetch", fetchMock);

    const { getPinnedServerAuthority, reconcilePinnedServerAuthority } = await import("../server-authority.js");
    await expect(getPinnedServerAuthority()).resolves.toBe("https://s1.example/api/v1");
    await expect(reconcilePinnedServerAuthority("https://s2.example/api/v1")).resolves.toEqual({
      kind: "mismatch",
      expected: "https://s2.example/api/v1",
      observed: "https://s1.example/api/v1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed and secret-bearing authorities", async () => {
    const { canonicalizeServerAuthority } = await import("../server-authority.js");
    expect(() => canonicalizeServerAuthority("ftp://tree.example/api/v1")).toThrow();
    expect(() => canonicalizeServerAuthority("https://user:pass@tree.example/api/v1")).toThrow();
    expect(() => canonicalizeServerAuthority("https://tree.example/api/v1?server=s1")).toThrow();
    expect(() => canonicalizeServerAuthority("https://tree.example/other")).toThrow();
    expect(() => canonicalizeServerAuthority("http://0.0.0.0/api/v1")).toThrow();
    expect(() => canonicalizeServerAuthority("http://[::]/api/v1")).toThrow();
    expect(() => canonicalizeServerAuthority("http://*/api/v1")).toThrow();
    expect(() => canonicalizeServerAuthority(`https://tree.example/${"x".repeat(2048)}`)).toThrow();
    const expandingIdn = `https://${Array.from({ length: 79 }, () => "é".repeat(19)).join(".")}/api/v1`;
    expect(expandingIdn.length).toBeLessThan(2048);
    expect(new TextEncoder().encode(new URL(expandingIdn).toString()).byteLength).toBeGreaterThan(2048);
    expect(() => canonicalizeServerAuthority(expandingIdn)).toThrow();
    expect(canonicalizeServerAuthority("https://TREE.example:443/api/v1/")).toBe("https://tree.example/api/v1");
  });

  it("rejects non-JSON, ambiguous, and oversized authority probes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"v":1,"authority":"https://tree.example/api/v1"}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ v: 1, authority: "https://tree.example/api/v1", unexpected: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("x".repeat(4097), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    let { getPinnedServerAuthority } = await import("../server-authority.js");
    await expect(getPinnedServerAuthority()).rejects.toThrow("malformed");
    vi.resetModules();
    ({ getPinnedServerAuthority } = await import("../server-authority.js"));
    await expect(getPinnedServerAuthority()).rejects.toThrow("malformed");
    vi.resetModules();
    ({ getPinnedServerAuthority } = await import("../server-authority.js"));
    await expect(getPinnedServerAuthority()).rejects.toThrow("malformed");
  });

  it("stops reading oversized streamed responses before parsing them", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"v":1,"authority":"'));
        controller.enqueue(new Uint8Array(4096));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })),
    );

    const { getPinnedServerAuthority } = await import("../server-authority.js");
    await expect(getPinnedServerAuthority()).rejects.toThrow("malformed");
  });

  it("rejects non-JSON anonymous business responses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ v: 1, authority: "https://tree.example/api/v1" }))
      .mockResolvedValueOnce(new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { anonymousApi } = await import("../anonymous-client.js");
    await expect(anonymousApi.get("/bootstrap/config")).rejects.toThrow("invalid response");
  });

  it("rejects oversized anonymous business responses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ v: 1, authority: "https://tree.example/api/v1" }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: "x".repeat(64 * 1024) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { anonymousApi } = await import("../anonymous-client.js");
    await expect(anonymousApi.get("/bootstrap/config")).rejects.toThrow("invalid response");
  });

  it("keeps using the original pin when a later guarded request reports a retarget", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ v: 1, authority: "https://s1.example/api/v1" }))
      .mockResolvedValueOnce(jsonResponse({ channel: "prod" }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "authority mismatch" }), {
          status: 421,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { anonymousApi } = await import("../anonymous-client.js");
    const { getPinnedServerAuthority } = await import("../server-authority.js");
    await expect(anonymousApi.get("/bootstrap/config")).resolves.toEqual({ channel: "prod" });
    await expect(anonymousApi.get("/bootstrap/config")).rejects.toMatchObject({ status: 421 });
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      "X-First-Tree-Expected-Authority": "https://s1.example/api/v1",
    });
    await expect(getPinnedServerAuthority()).resolves.toBe("https://s1.example/api/v1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
