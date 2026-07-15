import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("../client.js", () => ({
  api: apiMock,
  withOrg: (path: string) => `/orgs/current${path}`,
}));

describe("GitLab Settings API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.get.mockResolvedValue({ connections: [], links: [], events: [] });
    apiMock.post.mockResolvedValue({});
    apiMock.delete.mockResolvedValue(undefined);
  });

  it("uses org-scoped collection routes and resource-scoped lifecycle routes", async () => {
    const gitlab = await import("../gitlab-connections.js");
    await gitlab.listGitlabConnections();
    await gitlab.createGitlabConnection({ displayName: "Private", instanceOrigin: "https://gitlab.internal" });
    await gitlab.regenerateGitlabBearer("connection/id");
    await gitlab.replaceGitlabConnection("connection/id", {
      displayName: "Replacement",
      instanceOrigin: "https://gitlab.new",
    });
    await gitlab.setGitlabAutomaticActions("connection/id", {
      enabled: true,
      acceptTeamWideForgeryRisk: true,
    });
    await gitlab.confirmGitlabAssigneeMode("connection/id");
    await gitlab.deleteGitlabConnection("connection/id");
    await gitlab.listGitlabIdentityLinks();
    await gitlab.listGitlabIdentityTransitionAudit();
    await gitlab.createGitlabIdentityLink({
      connectionId: "connection/id",
      membershipId: "member/id",
      username: "reviewer",
    });
    await gitlab.suspendGitlabIdentityLink("link/id");
    await gitlab.reconfirmGitlabIdentityLink("link/id");
    await gitlab.revokeGitlabIdentityLink("link/id");
    await gitlab.listGitlabAutomaticActionsAudit();
    await gitlab.listGitlabSkippedTargets();

    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/gitlab-connections");
    expect(apiMock.post).toHaveBeenCalledWith("/orgs/current/gitlab-connections", {
      displayName: "Private",
      instanceOrigin: "https://gitlab.internal",
    });
    expect(apiMock.post).toHaveBeenCalledWith("/gitlab-connections/connection%2Fid/regenerate");
    expect(apiMock.post).toHaveBeenCalledWith("/gitlab-connections/connection%2Fid/replace", {
      displayName: "Replacement",
      instanceOrigin: "https://gitlab.new",
    });
    expect(apiMock.delete).toHaveBeenCalledWith("/gitlab-connections/connection%2Fid");
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/gitlab-identity-links");
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/gitlab-identity-links/audit");
    expect(apiMock.post).toHaveBeenCalledWith("/gitlab-identity-links/link%2Fid/revoke", {});
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/gitlab-connections/automatic-actions-audit");
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/gitlab-connections/skipped-targets");
  });
});
