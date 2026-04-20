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
    testHome = join(tmpdir(), `ft-hub-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testHome, "config"), { recursive: true });

    originalHome = process.env.FIRST_TREE_HUB_HOME;
    process.env.FIRST_TREE_HUB_HOME = testHome;

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.FIRST_TREE_HUB_HOME;
    else process.env.FIRST_TREE_HUB_HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  async function writeCredentials(accessToken: string): Promise<void> {
    writeFileSync(
      join(testHome, "config", "credentials.json"),
      JSON.stringify({ accessToken, refreshToken: "refresh-xyz", serverUrl: "http://hub.test" }),
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
      "http://hub.test/api/v1/auth/refresh",
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

  it("throws a recognisable error when refresh fails", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    await expect(ensureFreshAccessToken()).rejects.toThrow(/refresh failed/);
  });
});
