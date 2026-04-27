import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/bootstrap.js", () => ({
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
}));

import { loadCredentials, saveCredentials } from "../core/bootstrap.js";
import { __testing, obtainDaemonJWT } from "../core/daemon-auth.js";

const { isLoopbackUrl } = __testing;

const URL = "http://127.0.0.1:8000";

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

const futureExp = () => Math.floor(Date.now() / 1000) + 3600;
const pastExp = () => Math.floor(Date.now() / 1000) - 60;

describe("isLoopbackUrl", () => {
  it.each([
    ["http://127.0.0.1:8000", true],
    ["http://localhost:8000", true],
    ["http://[::1]:8000", true],
    ["https://127.0.0.1", true],
    ["http://example.com", false],
    ["http://10.0.0.5:8000", false],
    ["http://192.168.1.1", false],
    ["not-a-url", false],
  ])("returns %s for %s", (url, expected) => {
    expect(isLoopbackUrl(url)).toBe(expected);
  });
});

describe("obtainDaemonJWT", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeEach(() => {
    vi.mocked(loadCredentials).mockReset();
    vi.mocked(saveCredentials).mockReset();
    fetchSpy.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it("rejects non-loopback serverUrl outright", async () => {
    await expect(obtainDaemonJWT("http://evil.com:8000")).rejects.toThrow(/non-loopback/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tier 1: returns cached creds when access token is still valid", async () => {
    const creds = { accessToken: jwt({ exp: futureExp() }), refreshToken: "r1", serverUrl: URL };
    vi.mocked(loadCredentials).mockReturnValue(creds);

    const out = await obtainDaemonJWT(URL);
    expect(out).toEqual(creds);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(saveCredentials).not.toHaveBeenCalled();
  });

  it("tier 2: refreshes when cached access token is expired", async () => {
    const cached = { accessToken: jwt({ exp: pastExp() }), refreshToken: "r1", serverUrl: URL };
    vi.mocked(loadCredentials).mockReturnValue(cached);
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: jwt({ exp: futureExp() }) }), { status: 200 }),
    );

    const out = await obtainDaemonJWT(URL);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]?.[0];
    expect(String(url)).toContain("/auth/refresh");
    expect(out.refreshToken).toBe("r1");
    expect(saveCredentials).toHaveBeenCalledWith(out);
  });

  it("tier 3: falls through to local-bootstrap when refresh fails", async () => {
    const cached = { accessToken: jwt({ exp: pastExp() }), refreshToken: "r1", serverUrl: URL };
    vi.mocked(loadCredentials).mockReturnValue(cached);
    fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 401 })).mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: jwt({ exp: futureExp() }), refreshToken: "r2" }), {
        status: 200,
      }),
    );

    const out = await obtainDaemonJWT(URL);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain("/auth/local-bootstrap");
    expect(out.refreshToken).toBe("r2");
    expect(saveCredentials).toHaveBeenCalledWith(out);
  });

  it("tier 3: skips refresh when no cached creds and mints via local-bootstrap", async () => {
    vi.mocked(loadCredentials).mockReturnValue(null);
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: jwt({ exp: futureExp() }), refreshToken: "fresh" }), {
        status: 200,
      }),
    );

    const out = await obtainDaemonJWT(URL);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/auth/local-bootstrap");
    expect(out.refreshToken).toBe("fresh");
    expect(saveCredentials).toHaveBeenCalledWith(out);
  });

  it("ignores cached creds bound to a different (or non-loopback) serverUrl", async () => {
    // Stale `credentials.json` from a previous Hub install on a different
    // port — fall through to bootstrap rather than replay the refresh
    // token at whatever lives at that URL now.
    const cached = {
      accessToken: jwt({ exp: futureExp() }),
      refreshToken: "stale",
      serverUrl: "http://127.0.0.1:9999",
    };
    vi.mocked(loadCredentials).mockReturnValue(cached);
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: jwt({ exp: futureExp() }), refreshToken: "fresh" }), {
        status: 200,
      }),
    );

    const out = await obtainDaemonJWT(URL);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/auth/local-bootstrap");
    expect(out.refreshToken).toBe("fresh");
  });

  it("throws when all three tiers fail", async () => {
    vi.mocked(loadCredentials).mockReturnValue(null);
    fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 503 }));

    await expect(obtainDaemonJWT(URL)).rejects.toThrow(/could not obtain a JWT/i);
  });
});
