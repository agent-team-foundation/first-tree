// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const AUTHORITY = "https://s1.example/api/v1";
const GENERATION = "0123456789abcdef0123456789abcdef";

function authorityResponse(viteGeneration: string | null): Response {
  return new Response(
    JSON.stringify({
      v: 1,
      authority: AUTHORITY,
      ...(viteGeneration === null ? {} : { viteGeneration }),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("full-page API navigation binding", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("binds a Vite target to the exact process and canonical server without changing business bytes", async () => {
    const { bindFullPageApiNavigation } = await import("../full-page-api-navigation.js");
    const raw = "/api/v1/auth/github/start?next=%2Finvite%2Fprivate-token";
    const bound = bindFullPageApiNavigation(raw, {
      authority: AUTHORITY,
      viteGeneration: GENERATION,
    });

    expect(bound).toMatch(
      /^\/api\/v1\/auth\/github\/start\?next=%2Finvite%2Fprivate-token&ft_vite_nav=v1\.[a-f0-9]{32}\.[A-Za-z0-9_-]+$/u,
    );
    expect(bound).toContain(`v1.${GENERATION}.`);
    expect(bound.slice(0, bound.indexOf("&ft_vite_nav="))).toBe(raw);
    expect(bound).not.toContain("access");
    expect(bound).not.toContain("refresh");
  });

  it("keeps production navigation unchanged after validating the exact route", async () => {
    const { bindFullPageApiNavigation } = await import("../full-page-api-navigation.js");
    const raw = "/api/v1/auth/google/start?next=%2Fteam";
    expect(
      bindFullPageApiNavigation(raw, {
        authority: AUTHORITY,
        viteGeneration: null,
      }),
    ).toBe(raw);
  });

  it.each([
    "https://s1.example/api/v1/auth/github/start",
    "//s1.example/api/v1/auth/github/start",
    "/api/v1/auth/github/callback",
    "/api/v1/auth/github/start#fragment",
    "/api/v1/auth/github/start?%6eext=%2Fteam",
    "/api/v1/auth/github/start?next=%2Fteam&next=%2Fother",
    "/api/v1/auth/github/start?unknown=value",
    "/api/v1/auth/github/start?ft_vite_nav=caller-value",
  ])("rejects an unsafe or ambiguous target: %s", async (target) => {
    const { bindFullPageApiNavigation } = await import("../full-page-api-navigation.js");
    expect(() =>
      bindFullPageApiNavigation(target, {
        authority: AUTHORITY,
        viteGeneration: GENERATION,
      }),
    ).toThrow("navigation");
  });

  it("prepares from the exact token-free pinned Vite observation", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(authorityResponse(GENERATION));
    vi.stubGlobal("fetch", fetchMock);
    const { prepareFullPageApiNavigation } = await import("../full-page-api-navigation.js");

    await expect(
      prepareFullPageApiNavigation("/api/v1/auth/github/dev-callback?githubId=1&login=dev"),
    ).resolves.toMatch(
      new RegExp(`^/api/v1/auth/github/dev-callback\\?githubId=1&login=dev&ft_vite_nav=v1\\.${GENERATION}\\.`),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/bootstrap/server-authority",
      expect.objectContaining({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }),
    );
  });

  it("fails closed without leaving an unbound fallback when the authority probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("offline")));
    const { prepareFullPageApiNavigation } = await import("../full-page-api-navigation.js");
    await expect(prepareFullPageApiNavigation("/api/v1/auth/github/start")).rejects.toThrow("failed closed");
  });
});
