// @vitest-environment happy-dom

import type { OrgBrief } from "@first-tree/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const REAL_ORGS: OrgBrief[] = [{ id: "real-org", name: "real", displayName: "Real Team", role: "member" }];

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  window.history.replaceState(null, "", "/preview/user-menu");
  globalThis.fetch = vi.fn(async () => {
    return new Response(JSON.stringify(REAL_ORGS), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("scopes the mocked organizations endpoint to the user-menu preview path", async () => {
  const { api } = await import("../../api/client.js");
  await import("../user-menu-preview.js");

  const previewOrgs = await api.get<OrgBrief[]>("/me/organizations");
  expect(previewOrgs.map((org) => org.id)).toContain("org-5");
  expect(globalThis.fetch).not.toHaveBeenCalled();

  window.history.replaceState(null, "", "/");

  await expect(api.get<OrgBrief[]>("/me/organizations")).resolves.toEqual(REAL_ORGS);
  expect(globalThis.fetch).toHaveBeenCalledWith("/api/v1/me/organizations", expect.objectContaining({ method: "GET" }));
});
