// @vitest-environment happy-dom

import type { OrgBrief } from "@first-tree/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const REAL_ORGS: OrgBrief[] = [{ id: "real-org", name: "real", displayName: "Real Team", role: "member" }];
const SERVER_AUTHORITY = "https://preview.test/api/v1";
const VITE_GENERATION = "0123456789abcdef0123456789abcdef";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  window.history.replaceState(null, "", "/preview/user-menu");
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "/api/v1/bootstrap/server-authority") {
      return new Response(JSON.stringify({ v: 1, authority: SERVER_AUTHORITY, viteGeneration: VITE_GENERATION }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(REAL_ORGS), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("does not intercept the organizations endpoint — the account menu no longer fetches orgs", async () => {
  const { api } = await import("../../api/client.js");
  await import("../user-menu-preview.js");

  // The account preview must NOT patch api.get: team switching (and its org
  // fetch) moved to /preview/team-switcher. /me/organizations falls straight
  // through to the real client even while on the user-menu preview path.
  await expect(api.get<OrgBrief[]>("/me/organizations")).resolves.toEqual(REAL_ORGS);
  expect(globalThis.fetch).toHaveBeenCalledWith("/api/v1/me/organizations", expect.objectContaining({ method: "GET" }));
});
