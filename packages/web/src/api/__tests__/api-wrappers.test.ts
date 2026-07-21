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
    withOrgAt: (orgId: string, path: string) => `/orgs/${encodeURIComponent(orgId)}${path}`,
  };
});

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.get.mockResolvedValue({});
  apiMock.post.mockResolvedValue({});
  apiMock.patch.mockResolvedValue({});
  apiMock.put.mockResolvedValue({});
  apiMock.delete.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api wrapper paths", () => {
  it("formats activity, org setting, organization, and overview requests", async () => {
    const activity = await import("../activity.js");
    const contextTree = await import("../context-tree.js");
    const orgSettings = await import("../org-settings.js");
    const organizations = await import("../organizations.js");
    const overview = await import("../overview.js");
    const agentResources = await import("../agent-resources.js");
    const resources = await import("../resources.js");

    await activity.retireClient("client/id");
    await activity.getActivityOverview();
    await activity.listClients();
    await activity.listOrgClients();
    await activity.getClient("client-1");
    await activity.getClientCapabilities("client-2");
    await activity.disconnectClient("client-3");
    await activity.resetAgentActivity("agent/id");
    await activity.generateConnectToken();

    await contextTree.getContextTreeSnapshot("org/id", "7d");
    await contextTree.initializeContextTree("org/id");
    await orgSettings.getContextTreeSetting("org/id");
    await orgSettings.getRawContextTreeSetting("org/id");
    await orgSettings.putContextTreeSetting("org/id", { repo: "https://github.com/acme/tree", branch: "main" });
    await orgSettings.deleteContextTreeSetting("org/id");
    await orgSettings.getContextTreeFeaturesSetting("org/id");
    await orgSettings.putContextTreeFeaturesSetting("org/id", {
      contextReviewer: { enabled: true, agentUuid: "agent/id" },
    });
    await orgSettings.getSourceReposSetting("org/id");
    await orgSettings.putSourceReposSetting("org/id", { repos: [{ url: "https://github.com/acme/web.git" }] });
    await orgSettings.deleteSourceReposSetting("org/id");
    await organizations.getOrganization("org/id");
    await organizations.updateOrganization("org/id", { displayName: "Acme" });
    await overview.getOverview();
    await resources.listTeamResources();
    await resources.listTeamResourcesForOrg("org/id");
    await resources.createTeamResource({
      type: "repo",
      name: "Web",
      defaultEnabled: "available",
      payload: { url: "https://github.com/acme/web.git" },
    });
    await resources.createTeamResourceForOrg("org/id", {
      type: "repo",
      name: "API",
      defaultEnabled: "recommended",
      payload: { url: "https://github.com/acme/api.git" },
    });
    await resources.previewOrgResourceImpact({ type: "repo", defaultEnabled: "recommended" });
    await resources.getResource("res/id");
    await resources.updateResource("res/id", { name: "New" });
    await resources.retireResource("res/id");
    await resources.promoteResource("res/id");
    await resources.getResourceUsage("res/id");
    await resources.previewResourceImpact("res/id", {});
    await agentResources.getAgentResources("agent/id");
    await agentResources.updateAgentResources("agent/id", { expectedVersion: 3, bindings: [] });

    expect(apiMock.delete).toHaveBeenCalledWith("/clients/client%2Fid");
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/activity");
    expect(apiMock.get).toHaveBeenCalledWith("/me/clients");
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/clients");
    expect(apiMock.get).toHaveBeenCalledWith("/clients/client-1");
    expect(apiMock.post).toHaveBeenCalledWith("/clients/client-3/disconnect");
    expect(apiMock.post).toHaveBeenCalledWith("/agents/agent%2Fid/reset-activity");
    expect(apiMock.post).toHaveBeenCalledWith("/me/connect-tokens");
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/org%2Fid/context-tree/snapshot?window=7d");
    expect(apiMock.post).toHaveBeenCalledWith("/orgs/org%2Fid/context-tree/initialize", {});
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/org%2Fid/settings/context_tree");
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/org%2Fid/settings/context_tree/raw");
    expect(apiMock.put).toHaveBeenCalledWith("/orgs/org%2Fid/settings/context_tree", {
      repo: "https://github.com/acme/tree",
      branch: "main",
    });
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/org%2Fid/settings/context_tree_features");
    expect(apiMock.put).toHaveBeenCalledWith("/orgs/org%2Fid/settings/context_tree_features", {
      contextReviewer: { enabled: true, agentUuid: "agent/id" },
    });
    expect(apiMock.put).toHaveBeenCalledWith("/orgs/org%2Fid/settings/source_repos", {
      repos: [{ url: "https://github.com/acme/web.git" }],
    });
    expect(apiMock.patch).toHaveBeenCalledWith("/orgs/org%2Fid", { displayName: "Acme" });
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/overview");
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/resources");
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/org%2Fid/resources");
    expect(apiMock.post).toHaveBeenCalledWith("/orgs/current/resources", {
      type: "repo",
      name: "Web",
      defaultEnabled: "available",
      payload: { url: "https://github.com/acme/web.git" },
    });
    expect(apiMock.post).toHaveBeenCalledWith("/orgs/org%2Fid/resources", {
      type: "repo",
      name: "API",
      defaultEnabled: "recommended",
      payload: { url: "https://github.com/acme/api.git" },
    });
    expect(apiMock.post).toHaveBeenCalledWith("/orgs/current/resources/impact-preview", {
      type: "repo",
      defaultEnabled: "recommended",
    });
    expect(apiMock.get).toHaveBeenCalledWith("/resources/res%2Fid");
    expect(apiMock.patch).toHaveBeenCalledWith("/resources/res%2Fid", { name: "New" });
    expect(apiMock.delete).toHaveBeenCalledWith("/resources/res%2Fid");
    expect(apiMock.post).toHaveBeenCalledWith("/resources/res%2Fid/promote");
    expect(apiMock.get).toHaveBeenCalledWith("/resources/res%2Fid/usage");
    expect(apiMock.post).toHaveBeenCalledWith("/resources/res%2Fid/impact-preview", {});
    expect(apiMock.get).toHaveBeenCalledWith("/agents/agent%2Fid/resources");
    expect(apiMock.patch).toHaveBeenCalledWith("/agents/agent%2Fid/resources", { expectedVersion: 3, bindings: [] });
  });

  it("formats agent, chat, member, and session requests", async () => {
    const agentConfig = await import("../agent-config.js");
    const agentStatus = await import("../agent-status.js");
    const agents = await import("../agents.js");
    const chats = await import("../chats.js");
    const meChats = await import("../me-chats.js");
    const meDocs = await import("../me-docs.js");
    const members = await import("../members.js");
    const sessions = await import("../sessions.js");

    await agentConfig.getAgentConfig("agent/id");
    await agentConfig.updateAgentConfig("agent/id", { expectedVersion: 3, payload: { model: "sonnet" } });
    await agentConfig.getAgentClientStatus("agent/id");
    await agentStatus.fetchChatAgentStatuses("chat/id");

    await agents.listAgents({ limit: 10, cursor: "next", type: "agent", query: "nova", addressableOnly: true });
    await agents.listAllAgents({ limit: 5, cursor: "older" });
    await agents.listManagedAgents();
    await agents.getAgent("agent/id");
    await agents.getAgentSkills("agent/id");
    await agents.createAgent({ name: "nova", type: "agent", displayName: "Nova" });
    await agents.checkAgentNameAvailability("name with spaces");
    await agents.updateAgent("agent/id", { displayName: "New" });
    await agents.deleteAgent("agent/id");
    await agents.deleteAgentAvatar("agent/id");
    await agents.suspendAgent("agent/id");
    await agents.reactivateAgent("agent/id");
    await agents.testAgentConnection("agent/id");

    await chats.listChats({ limit: 3, cursor: "next" });
    await chats.getChat("chat/id");
    await chats.listChatGithubEntities("chat/id");
    await chats.listChatGitlabEntities("chat/id");
    await chats.unfollowChatGitlabEntity("chat/id", "https://gitlab.example/acme/api/-/merge_requests/42");
    await chats.renameChat("chat/id", "Topic");
    await chats.patchChatEngagement("chat/id", "archived");
    await chats.sendChatMessage("chat/id", "hello", ["agent-1"]);
    await chats.sendChatMessage("chat/id", "no route", []);
    await chats.sendFileMessageBatch(
      "chat/id",
      {
        attachments: [
          { imageId: "11111111-1111-4111-8111-111111111111", mimeType: "image/png", filename: "a.png", size: 1 },
        ],
      },
      {
        mentions: ["agent-1"],
      },
    );
    await chats.sendFileMessageBatch("chat/id", { attachments: [] }, { mentions: [] });
    await chats.createAgentChat("agent/id");
    await chats.listChatMessages("chat/id", { limit: 20, cursor: "older" });

    // listMeChats now parses the response, so it needs a valid payload. Seed the
    // shape an OLDER server (pre-priorityRows) would return and assert the schema
    // fills the version-skew default — that both keeps this request-shape test
    // reaching its assertion and proves the fallback the parse exists to provide.
    apiMock.get.mockResolvedValueOnce({ rows: [], nextCursor: null });
    const listed = await meChats.listMeChats({
      limit: 10,
      cursor: "next",
      filter: "unread",
      engagement: "active",
      origin: ["manual", "github", "agent"],
      with: ["agent-1", "agent-2"],
      watching: true,
    });
    expect(listed.priorityRows).toEqual({ attention: [], pinned: [] });
    await meChats.listMeChatSourceCounts({ engagement: "archived" });
    await meChats.createMeChat({ participantIds: ["agent-1"] });
    await meChats.createMeTaskChat({
      mode: "task",
      initialRecipientAgentIds: ["agent-1"],
      initialRecipientNames: [],
      contextParticipantAgentIds: [],
      contextParticipantNames: [],
      initialMessage: { source: "web", format: "text", content: "start task" },
    });
    await meChats.markMeChatRead("chat/id");
    await meChats.markMeChatUnread("chat/id");
    await meChats.addMeChatParticipants("chat/id", { participantIds: ["agent-2"] });
    await meChats.joinMeChat("chat/id");
    await meChats.leaveMeChat("chat/id");

    await meDocs.getMeDoc("chat/id", { agentId: "agent/id", path: "docs/plan.md", basePath: "/workspace" });
    await members.listMembers();
    await members.updateMember("member/id", { role: "admin" });
    await members.deleteMember("member/id");
    await members.leaveMembership("member/id");

    expect(sessions.sessionQueryKey("agent-1", "chat-1")).toEqual(["session", "agent-1", "chat-1"]);
    expect(sessions.agentSessionsQueryKey("agent-1")).toEqual(["agent-sessions", "agent-1"]);
    expect(sessions.chatSessionEventsQueryKey("chat-1")).toEqual(["chat-session-events", "chat-1"]);
    expect(sessions.asToolCallPayload({ toolUseId: "tool-1", name: "Bash", args: {}, status: "ok" })).toEqual({
      toolUseId: "tool-1",
      name: "Bash",
      args: {},
      status: "ok",
      durationMs: undefined,
      resultPreview: undefined,
    });
    expect(sessions.asToolCallPayload({ toolUseId: "tool-1", status: "ok" })).toBeNull();
    expect(sessions.asErrorPayload({ source: "runtime", message: "failed" })).toEqual({
      source: "runtime",
      message: "failed",
    });
    expect(sessions.asErrorPayload({ source: "other", message: "failed" })).toBeNull();
    expect(sessions.asAssistantTextPayload({ text: "partial" })).toEqual({ text: "partial" });
    expect(sessions.asTurnEndPayload({ status: "success" })).toEqual({ status: "success" });
    await sessions.listSessions({ limit: 10, cursor: "c", state: "active", agentId: "agent-1" });
    await sessions.listAgentSessions("agent/id", { state: "active", runtimeState: "working" });
    await sessions.getSession("agent/id", "chat/id");
    await sessions.listSessionEvents("agent/id", "chat/id", { limit: 30, cursor: 5, direction: "asc" });
    await sessions.listChatSessionEvents("chat/id", { limit: 200, direction: "desc" });
    await sessions.suspendSession("agent/id", "chat/id");
    await sessions.resumeSession("agent/id", "chat/id");
    await sessions.terminateSession("agent/id", "chat/id");

    expect(apiMock.get).toHaveBeenCalledWith("/agents/agent/id/config");
    expect(apiMock.get).toHaveBeenCalledWith("/chats/chat%2Fid/session-events?limit=200&direction=desc");
    expect(apiMock.get).toHaveBeenCalledWith("/chats/chat/id/agent-status");
    expect(apiMock.get).toHaveBeenCalledWith(
      "/orgs/current/agents?limit=10&cursor=next&type=agent&query=nova&addressableOnly=true",
    );
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/agents/all?limit=5&cursor=older");
    expect(apiMock.get).toHaveBeenCalledWith("/agents/agent%2Fid/skills");
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/agents/names/name%20with%20spaces/availability");
    expect(apiMock.get).toHaveBeenCalledWith("/chats/chat%2Fid/gitlab-entities");
    expect(apiMock.delete).toHaveBeenCalledWith(
      `/chats/chat%2Fid/gitlab-entities?entity=${encodeURIComponent(
        "https://gitlab.example/acme/api/-/merge_requests/42",
      )}`,
    );
    expect(apiMock.post).toHaveBeenCalledWith("/chats/chat%2Fid/messages", {
      format: "text",
      content: "hello",
      metadata: { mentions: ["agent-1"] },
    });
    expect(apiMock.post).toHaveBeenCalledWith("/chats/chat%2Fid/messages", {
      format: "text",
      content: "no route",
    });
    expect(apiMock.get).toHaveBeenCalledWith(
      "/orgs/current/chats?limit=10&cursor=next&filter=unread&engagement=active&origin=manual%2Cgithub%2Cagent&with=agent-1%2Cagent-2&watching=1",
      undefined,
    );
    expect(apiMock.post).toHaveBeenCalledWith("/orgs/current/chats", {
      mode: "task",
      initialRecipientAgentIds: ["agent-1"],
      initialRecipientNames: [],
      contextParticipantAgentIds: [],
      contextParticipantNames: [],
      initialMessage: { source: "web", format: "text", content: "start task" },
    });
    expect(apiMock.get).toHaveBeenCalledWith(
      "/chats/chat%2Fid/docs/preview?agentId=agent%2Fid&path=docs%2Fplan.md&basePath=%2Fworkspace",
    );
    expect(apiMock.post).toHaveBeenCalledWith("/me/memberships/member%2Fid/leave");
    expect(apiMock.get).toHaveBeenCalledWith(
      "/agents/agent/id/sessions/chat/id/events?limit=30&cursor=5&direction=asc",
    );
  });

  it("handles GitHub App helpers, legacy auth, file reading, and swallowed onboarding events", async () => {
    const { ApiError } = await import("../client.js");
    const githubApp = await import("../github-app.js");
    const github = await import("../github.js");
    const auth = await import("../auth.js");
    const chats = await import("../chats.js");
    const onboarding = await import("../onboarding-events.js");

    apiMock.get.mockRejectedValueOnce(new ApiError(404, "missing"));
    await expect(githubApp.getGithubAppInstallation("org-1")).resolves.toBeNull();
    apiMock.get.mockRejectedValueOnce(new ApiError(500, "boom"));
    await expect(githubApp.getGithubAppInstallation("org-1")).rejects.toMatchObject({ status: 500 });
    apiMock.get.mockResolvedValueOnce({ exists: true });
    await expect(githubApp.getGithubAppInstallationExists("org-1")).resolves.toBe(true);
    apiMock.get.mockResolvedValueOnce({ installUrl: "https://github.com/apps/first-tree/installations/new" });
    await expect(githubApp.getGithubAppInstallUrl("org-1", "/onboarding")).resolves.toContain("github.com");

    apiMock.get.mockResolvedValueOnce({ repos: [{ fullName: "acme/web" }] });
    await expect(github.listGithubRepos()).resolves.toEqual([{ fullName: "acme/web" }]);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: "a", refreshToken: "r" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(auth.login("gandy", "secret")).resolves.toEqual({ accessToken: "a", refreshToken: "r" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "bad login" }), { status: 401 }));
    await expect(auth.login("gandy", "bad")).rejects.toThrow("bad login");
    fetchMock.mockResolvedValueOnce(new Response("plain failure", { status: 500 }));
    await expect(auth.login("gandy", "bad")).rejects.toThrow("plain failure");

    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const originalFileReader = globalThis.FileReader;
    class SuccessFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(): void {
        this.result = "data:text/plain;base64,aGVsbG8=";
        this.onload?.();
      }
    }
    class BadResultFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(): void {
        this.result = new ArrayBuffer(0);
        this.onload?.();
      }
    }
    class ErrorFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = new DOMException("read failed");
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(): void {
        this.onerror?.();
      }
    }
    Object.defineProperty(globalThis, "FileReader", { configurable: true, value: SuccessFileReader });
    await expect(chats.readFileAsBase64(file)).resolves.toBe("aGVsbG8=");
    Object.defineProperty(globalThis, "FileReader", { configurable: true, value: BadResultFileReader });
    await expect(chats.readFileAsBase64(file)).rejects.toThrow("Unexpected FileReader result");
    Object.defineProperty(globalThis, "FileReader", { configurable: true, value: ErrorFileReader });
    await expect(chats.readFileAsBase64(file)).rejects.toThrow("read failed");
    Object.defineProperty(globalThis, "FileReader", { configurable: true, value: originalFileReader });

    apiMock.post.mockRejectedValueOnce(new Error("offline"));
    await expect(
      onboarding.reportOnboardingEvent("agent_created", { runtimeProvider: "codex" }),
    ).resolves.toBeUndefined();
    apiMock.post.mockRejectedValueOnce(new Error("offline"));
    await expect(onboarding.markOnboardingCompleted()).resolves.toBeUndefined();
  });

  it("uploads agent avatars with optional auth and maps avatar upload errors", async () => {
    const agents = await import("../agents.js");
    const client = await import("../client.js");
    const fetchMock = vi.fn();
    const storage = createStorage();
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    vi.stubGlobal("fetch", fetchMock);

    localStorage.setItem("first-tree:tokens", JSON.stringify({ accessToken: "access-1", refreshToken: "refresh-1" }));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ avatarImageUrl: "/avatar.webp" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(agents.uploadAgentAvatar("agent/id", new Blob(["x"], { type: "image/webp" }))).resolves.toEqual({
      avatarImageUrl: "/avatar.webp",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/agents/agent%2Fid/avatar",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "image/webp", Authorization: "Bearer access-1" },
      }),
    );

    client.clearStoredTokens();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "too large" }), { status: 413 }));
    await expect(agents.uploadAgentAvatar("agent/id", new Blob(["x"]))).rejects.toMatchObject({
      status: 413,
      message: "too large",
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: { "Content-Type": "application/octet-stream" } });

    fetchMock.mockResolvedValueOnce(new Response("plain avatar failure", { status: 500 }));
    await expect(agents.uploadAgentAvatar("agent/id", new Blob(["x"]))).rejects.toMatchObject({
      status: 500,
      message: "plain avatar failure",
    });
  });
});
