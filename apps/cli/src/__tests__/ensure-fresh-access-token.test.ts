import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("ensureFreshAccessToken — safety margin", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    testHome = join(tmpdir(), `ft-first-tree-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testHome, "config"), { recursive: true });

    originalHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = testHome;

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
    else process.env.FIRST_TREE_HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  async function writeCredentials(accessToken: string): Promise<void> {
    writeFileSync(
      join(testHome, "config", "credentials.json"),
      JSON.stringify({ accessToken, refreshToken: "refresh-xyz", serverUrl: "http://first-tree.test" }),
    );
  }

  it("returns the existing token when exp is comfortably in the future", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(token);

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    const result = await ensureFreshAccessToken();

    expect(result).toBe(token);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes when exp is less than 30s away", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) + 10 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ accessToken: refreshed })));

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    const result = await ensureFreshAccessToken();

    expect(result).toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://first-tree.test/api/v1/auth/refresh",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("refreshes when exp already passed", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ accessToken: refreshed })));

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    const result = await ensureFreshAccessToken();

    expect(result).toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws AuthRefreshFailedError on 401 so the WS layer can fail-stop", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const { ensureFreshAccessToken, AuthRefreshFailedError } = await import("../core/bootstrap.js");
    await expect(ensureFreshAccessToken()).rejects.toThrow(AuthRefreshFailedError);
    // Message is operator-facing; spot-check the recovery hint instead of the
    // word "failed" so future copy edits don't break the test.
    await expect(ensureFreshAccessToken()).rejects.toThrow(/Re-run `first-tree-dev login/);
  });

  it("throws a generic Error (not AuthRefreshFailedError) on non-401 failures so transient outages still retry", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const { ensureFreshAccessToken, AuthRefreshFailedError } = await import("../core/bootstrap.js");
    await expect(ensureFreshAccessToken()).rejects.not.toThrow(AuthRefreshFailedError);
  });

  it("throws AuthRefreshRateLimitedError carrying server's Retry-After on 429", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "45" } }));

    const { ensureFreshAccessToken, AuthRefreshRateLimitedError } = await import("../core/bootstrap.js");
    const err = await ensureFreshAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthRefreshRateLimitedError);
    expect((err as { retryAfterMs: number }).retryAfterMs).toBe(45_000);
  });

  it("defaults Retry-After to 30s when the 429 response omits the header", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(null, { status: 429 }));

    const { ensureFreshAccessToken, AuthRefreshRateLimitedError } = await import("../core/bootstrap.js");
    const err = await ensureFreshAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthRefreshRateLimitedError);
    expect((err as { retryAfterMs: number }).retryAfterMs).toBe(30_000);
  });

  it("parses HTTP-date form of Retry-After (RFC 7231 alternate form)", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    await writeCredentials(stale);

    const future = new Date(Date.now() + 60_000).toUTCString();
    fetchMock.mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": future } }));

    const { ensureFreshAccessToken, AuthRefreshRateLimitedError } = await import("../core/bootstrap.js");
    const err = await ensureFreshAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthRefreshRateLimitedError);
    // Date precision is whole seconds, so allow a small slop.
    expect((err as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(55_000);
    expect((err as { retryAfterMs: number }).retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  // Regression for the original incident: server now sliding-windows refresh
  // tokens (rotates on every /auth/refresh), so the client MUST persist the
  // rotated token. Without this the cap never moves and the client still
  // hits the absolute refresh expiry — exactly the failure mode that
  // motivated this whole PR.
  it("persists the rotated refreshToken to credentials.json on a sliding-window refresh", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ accessToken: refreshed, refreshToken: "rotated-refresh-abc" })),
    );

    const { ensureFreshAccessToken, loadCredentials } = await import("../core/bootstrap.js");
    await ensureFreshAccessToken();

    const persisted = loadCredentials();
    expect(persisted?.refreshToken).toBe("rotated-refresh-abc");
    expect(persisted?.accessToken).toBe(refreshed);
  });

  // Cross-version safety: if the client is upgraded ahead of the server
  // (rolling deploy), the legacy server still returns just `{accessToken}`.
  // We must not blow away the existing refresh token in that case — that
  // would force the user to re-claim immediately even though their old
  // refresh token is still valid.
  it("keeps the existing refreshToken when the server returns only accessToken (legacy server)", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    // Legacy /auth/refresh shape — no refreshToken field.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ accessToken: refreshed })));

    const { ensureFreshAccessToken, loadCredentials } = await import("../core/bootstrap.js");
    await ensureFreshAccessToken();

    const persisted = loadCredentials();
    expect(persisted?.refreshToken).toBe("refresh-xyz"); // unchanged from the seed
    expect(persisted?.accessToken).toBe(refreshed);
  });

  it("deduplicates concurrent refresh calls into a single HTTP round-trip", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    // Delay the response so all concurrent callers pile onto the same inflight
    // promise before the first fetch resolves.
    let releaseFetch: (res: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        releaseFetch = resolve;
      }),
    );

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    const calls = Promise.all([
      ensureFreshAccessToken(),
      ensureFreshAccessToken(),
      ensureFreshAccessToken(),
      ensureFreshAccessToken(),
      ensureFreshAccessToken(),
    ]);

    releaseFetch(new Response(JSON.stringify({ accessToken: refreshed })));
    const results = await calls;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toBe(refreshed);
  });

  it("respects opts.minValidityMs — refreshes a token that the default would consider fresh", async () => {
    // Regression: WS proactive refresh fires at exp-60s; before this fix it
    // re-called ensureFreshAccessToken() with the default 30s lead, saw
    // ~60s of life remaining, returned the *same* token, and the server
    // pushed auth:expired ~55s later. Asking for 65s validity must drive a
    // real /auth/refresh round-trip.
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) + 60 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ accessToken: refreshed })));

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");

    // Default threshold (30s): the 60s-lived token is still considered fresh.
    expect(await ensureFreshAccessToken()).toBe(stale);
    expect(fetchMock).not.toHaveBeenCalled();

    // WS-style call asking for 65s of validity: must refresh.
    expect(await ensureFreshAccessToken({ minValidityMs: 65_000 })).toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("releases the inflight slot so subsequent expirations can refresh again", async () => {
    const stale1 = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    const refreshed1 = makeJwt({ exp: Math.floor(Date.now() / 1000) + 10 }); // still within 30s lead
    const refreshed2 = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale1);

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: refreshed1 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: refreshed2 })));

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    const first = await ensureFreshAccessToken();
    const second = await ensureFreshAccessToken();

    expect(first).toBe(refreshed1);
    expect(second).toBe(refreshed2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
