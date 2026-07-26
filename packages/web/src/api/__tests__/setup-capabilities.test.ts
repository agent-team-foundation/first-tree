import type { TeamSetupCapabilities } from "@first-tree/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("../client.js", () => ({
  api: apiMock,
  withOrgAt: (organizationId: string, path: string) => `/orgs/${encodeURIComponent(organizationId)}${path}`,
}));

const observedAt = "2026-07-23T08:00:00.000Z";

function capabilities(organizationId = "org-1"): TeamSetupCapabilities {
  return {
    organizationId,
    repositoryAutomation: {
      providers: [
        {
          provider: "github",
          adoption: "enabled",
          health: "ready",
          blockers: [],
          observedAt,
        },
        {
          provider: "gitlab",
          adoption: "available",
          health: "not_observed",
          blockers: [],
          observedAt,
        },
      ],
    },
    contextTree: {
      binding: {
        state: "bound",
        provider: "github",
        repo: "https://github.com/acme/context-tree.git",
        branch: "main",
      },
      blockers: [],
      automaticReview: {
        adoption: "enabled",
        health: "ready",
        reviewerAgent: {
          uuid: "01900000-0000-7000-8000-000000000001",
          displayName: "Context Reviewer",
        },
        blockers: [],
        observedAt,
      },
    },
  };
}

describe("Setup capabilities API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the explicit encoded Team route and returns a runtime-parsed projection", async () => {
    const response = capabilities("org/id with spaces");
    apiMock.get.mockResolvedValueOnce(response);
    const { getTeamSetupCapabilitiesAt, setupCapabilitiesQueryKey } = await import("../setup-capabilities.js");

    await expect(getTeamSetupCapabilitiesAt("org/id with spaces")).resolves.toEqual(response);
    expect(apiMock.get).toHaveBeenCalledOnce();
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/org%2Fid%20with%20spaces/setup-capabilities");
    expect(setupCapabilitiesQueryKey("org/id with spaces")).toEqual(["setup-capabilities", "org/id with spaces"]);
    expect(setupCapabilitiesQueryKey(null)).toEqual(["setup-capabilities", null]);
  });

  it("fails closed when the Server response violates the public projection schema", async () => {
    apiMock.get.mockResolvedValueOnce({
      ...capabilities(),
      callerRole: "admin",
    });
    const { getTeamSetupCapabilitiesAt } = await import("../setup-capabilities.js");

    await expect(getTeamSetupCapabilitiesAt("org-1")).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("rejects a valid projection scoped to a different Team", async () => {
    apiMock.get.mockResolvedValueOnce(capabilities("org-stale"));
    const { getTeamSetupCapabilitiesAt } = await import("../setup-capabilities.js");

    await expect(getTeamSetupCapabilitiesAt("org-current")).rejects.toThrow(
      "Setup capabilities response did not match the requested organization",
    );
  });
});
