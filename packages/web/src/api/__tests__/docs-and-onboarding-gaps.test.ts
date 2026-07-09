// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock("../client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client.js")>();
  return {
    ...actual,
    api: apiMock,
    withOrg: (path: string) => `/orgs/current${path}`,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.get.mockResolvedValue({});
  apiMock.post.mockResolvedValue({});
  apiMock.patch.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("docs API wrappers", () => {
  it("builds list query strings and exercises every endpoint", async () => {
    const docs = await import("../docs.js");

    apiMock.get.mockResolvedValueOnce({ items: [{ id: "doc-1", slug: "plan" }], nextCursor: null });
    await expect(docs.listDocs({ slug: "plan", project: "ft", status: "draft", limit: 5, cursor: "c1" })).resolves.toEqual({
      items: [{ id: "doc-1", slug: "plan" }],
      nextCursor: null,
    });
    expect(apiMock.get).toHaveBeenCalledWith(
      "/orgs/current/documents?slug=plan&project=ft&status=draft&limit=5&cursor=c1",
    );

    apiMock.get.mockResolvedValueOnce({ items: [], nextCursor: null });
    await expect(docs.listDocs()).resolves.toEqual({ items: [], nextCursor: null });
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/documents");

    apiMock.get.mockResolvedValueOnce({ items: [{ id: "doc-1", slug: "plan" }] });
    await expect(docs.findDocBySlug("plan")).resolves.toEqual({ id: "doc-1", slug: "plan" });
    apiMock.get.mockResolvedValueOnce({ items: [] });
    await expect(docs.findDocBySlug("missing")).resolves.toBeNull();

    await docs.getDoc("doc/1", 3);
    expect(apiMock.get).toHaveBeenCalledWith("/documents/doc%2F1?version=3");
    await docs.getDoc("doc-2");
    expect(apiMock.get).toHaveBeenCalledWith("/documents/doc-2");

    await docs.setDocStatus("doc-1", "approved");
    expect(apiMock.patch).toHaveBeenCalledWith("/documents/doc-1", { status: "approved" });

    await docs.listDocComments("doc-1", { status: "open", versionNumber: 2 });
    expect(apiMock.get).toHaveBeenCalledWith("/documents/doc-1/comments?status=open&versionNumber=2");
    await docs.listDocComments("doc-1");
    expect(apiMock.get).toHaveBeenCalledWith("/documents/doc-1/comments");

    await docs.createDocComment("doc-1", { body: "note", versionNumber: 1 });
    expect(apiMock.post).toHaveBeenCalledWith("/documents/doc-1/comments", { body: "note", versionNumber: 1 });

    await docs.replyDocComment("c/1", "reply body");
    expect(apiMock.post).toHaveBeenCalledWith("/document-comments/c%2F1/replies", { body: "reply body" });

    await docs.setDocCommentStatus("c-1", "resolved");
    expect(apiMock.patch).toHaveBeenCalledWith("/document-comments/c-1", { status: "resolved" });
  });
});

describe("remaining API wrappers", () => {
  it("covers onboarding kickoff, tree-setup, github org repos, landing campaigns, and app install panel", async () => {
    const onboarding = await import("../onboarding-events.js");
    const github = await import("../github.js");
    const githubApp = await import("../github-app.js");
    const landing = await import("../landing-campaigns.js");

    apiMock.post.mockResolvedValueOnce({ chatId: "chat-1" });
    await expect(
      onboarding.postOnboardingStartChat({
        agentUuid: "agent-1",
        bootstrap: "hello",
        organizationId: "org-1",
        topic: "intro",
        complete: true,
      }),
    ).resolves.toEqual({ chatId: "chat-1" });
    expect(apiMock.post).toHaveBeenCalledWith("/me/onboarding/kickoff", {
      agentUuid: "agent-1",
      bootstrap: "hello",
      organizationId: "org-1",
      topic: "intro",
      complete: true,
    });

    apiMock.post.mockResolvedValueOnce({ chatId: "chat-2" });
    await expect(
      onboarding.postTreeSetupStartChat({
        organizationId: "org-1",
        agentUuid: "agent-1",
        bootstrap: "tree",
      }),
    ).resolves.toEqual({ chatId: "chat-2" });

    apiMock.get.mockResolvedValueOnce({
      needsTreeSetup: true,
      hasTreeBinding: false,
      hasTreeSetupKickoff: true,
    });
    await expect(onboarding.getTreeSetupStatus("org-1")).resolves.toEqual({
      needsTreeSetup: true,
      hasTreeBinding: false,
      hasTreeSetupStartChat: true,
    });
    expect(apiMock.get).toHaveBeenCalledWith("/me/onboarding/tree-setup-status?organizationId=org-1");

    apiMock.get.mockResolvedValueOnce({
      needsTreeSetup: false,
      hasTreeBinding: true,
      hasTreeSetupStartChat: false,
    });
    await expect(onboarding.getTreeSetupStatus("org-2")).resolves.toEqual({
      needsTreeSetup: false,
      hasTreeBinding: true,
      hasTreeSetupStartChat: false,
    });

    apiMock.get.mockResolvedValueOnce({ repos: [{ fullName: "acme/api" }] });
    await expect(github.listOrgGithubRepos("org-1")).resolves.toEqual([{ fullName: "acme/api" }]);
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/org-1/github-app-installation/repositories");

    apiMock.get.mockResolvedValueOnce({ installUrl: "https://github.com/apps/x/installations/new" });
    await expect(githubApp.getGithubAppInstallUrl("org-1")).resolves.toContain("github.com");
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/org-1/github-app-installation/install-url");

    apiMock.get.mockResolvedValueOnce({ installations: [] });
    await expect(githubApp.getGithubAppConnectPanel("org-1")).resolves.toEqual({ installations: [] });
    await githubApp.connectGithubAppInstallation("org-1", 42);
    expect(apiMock.post).toHaveBeenCalledWith("/orgs/org-1/github-app-installation/connect", { installationId: 42 });
    await githubApp.disconnectGithubAppInstallation("org-1");
    expect(apiMock.post).toHaveBeenCalledWith("/orgs/org-1/github-app-installation/disconnect", {});

    apiMock.post.mockResolvedValueOnce({
      chatId: "chat-9",
      agentUuid: "agent-9",
      campaign: "ship-feature",
      repoCanonicalKey: "github.com/acme/web",
    });
    const campaign = await landing.startLandingCampaign({
      campaign: "ship-feature",
      repoUrl: "https://github.com/acme/web.git",
    });
    expect(campaign).toMatchObject({ chatId: "chat-9", campaign: "ship-feature" });
    expect(apiMock.post).toHaveBeenCalledWith("/me/landing-campaigns/start", {
      campaign: "ship-feature",
      repoUrl: "https://github.com/acme/web.git",
    });
  });
});
