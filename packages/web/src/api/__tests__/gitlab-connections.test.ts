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
    await gitlab.deleteGitlabConnection("connection/id");
    await gitlab.listGitlabIdentityLinks();
    await gitlab.createGitlabIdentityLink({
      connectionId: "connection/id",
      membershipId: "member/id",
      username: "reviewer",
    });
    await gitlab.reconfirmGitlabIdentityLink("link/id");
    await gitlab.removeGitlabIdentityLink("link/id");

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
    expect(apiMock.delete).toHaveBeenCalledWith("/gitlab-identity-links/link%2Fid");
  });
});
