// @vitest-environment happy-dom

import type { Organization, OrgBrief } from "@first-tree/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const REAL_ORGS: OrgBrief[] = [{ id: "real-org", name: "real", displayName: "Real Team", role: "member" }];
const SERVER_AUTHORITY = "https://preview.test/api/v1";
const VITE_GENERATION = "0123456789abcdef0123456789abcdef";

type PreviewWindow = Window & {
  __ftTeamSwitcherPreviewOriginalGet?: unknown;
  __ftTeamSwitcherPreviewOriginalPatch?: unknown;
};

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  window.history.replaceState(null, "", "/preview/team-switcher");
  delete (window as PreviewWindow).__ftTeamSwitcherPreviewOriginalGet;
  delete (window as PreviewWindow).__ftTeamSwitcherPreviewOriginalPatch;
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

it("scopes the mocked organizations endpoint to the team-switcher preview path", async () => {
  const { api } = await import("../../api/client.js");
  await import("../team-switcher-preview.js");

  const previewOrgs = await api.get<OrgBrief[]>("/me/organizations");
  expect(previewOrgs.length).toBeGreaterThan(1);
  expect(previewOrgs.map((org) => org.id)).toContain("org-1");
  expect(globalThis.fetch).not.toHaveBeenCalled();

  window.history.replaceState(null, "", "/");

  await expect(api.get<OrgBrief[]>("/me/organizations")).resolves.toEqual(REAL_ORGS);
  expect(globalThis.fetch).toHaveBeenCalledWith("/api/v1/me/organizations", expect.objectContaining({ method: "GET" }));
});

it("scopes the mocked organization rename endpoint to the team-switcher preview path", async () => {
  const { api } = await import("../../api/client.js");
  await import("../team-switcher-preview.js");

  const renamed = await api.patch<Organization>("/orgs/org-2", { displayName: "  Globex Renamed  " });
  expect(renamed).toMatchObject({
    id: "org-2",
    name: "globex",
    displayName: "Globex Renamed",
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();

  const previewOrgs = await api.get<OrgBrief[]>("/me/organizations");
  expect(previewOrgs.find((org) => org.id === "org-2")?.displayName).toBe("Globex Renamed");

  window.history.replaceState(null, "", "/");

  await expect(api.patch<unknown>("/orgs/org-2", { displayName: "Outside Preview" })).resolves.toEqual(REAL_ORGS);
  expect(globalThis.fetch).toHaveBeenCalledWith("/api/v1/orgs/org-2", expect.objectContaining({ method: "PATCH" }));
});
