import { beforeEach, describe, expect, it, vi } from "vitest";
import * as activityApi from "../activity.js";
import * as adapterMappingsApi from "../adapter-mappings.js";
import * as adapterStatusApi from "../adapter-status.js";
import * as adaptersApi from "../adapters.js";
import * as agentConfigApi from "../agent-config.js";
import * as agentStatusApi from "../agent-status.js";
import * as agentsApi from "../agents.js";
import * as attentionApi from "../attention.js";
import * as authApi from "../auth.js";
import * as chatsApi from "../chats.js";
import {
  ApiError,
  api,
  getStoredTokens,
  refreshAccessToken,
  setApiSelectedOrganizationId,
  setStoredTokens,
} from "../client.js";
import * as contextTreeApi from "../context-tree.js";
import * as githubApi from "../github.js";
import * as githubAppApi from "../github-app.js";
import * as meChatsApi from "../me-chats.js";
import * as meDocsApi from "../me-docs.js";
import * as membersApi from "../members.js";
import * as onboardingEventsApi from "../onboarding-events.js";
import * as orgSettingsApi from "../org-settings.js";
import * as organizationsApi from "../organizations.js";
import * as overviewApi from "../overview.js";
import * as sessionsApi from "../sessions.js";

type FetchCall = {
  body: unknown;
  method: string;
  url: string;
};

const calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function responseBodyFor(url: string): unknown {
  if (url.includes("/auth/refresh")) return { accessToken: "access-2", refreshToken: "refresh-2" };
  if (url.includes("/auth/login")) return { accessToken: "access-1", refreshToken: "refresh-1", user: { id: "u1" } };
  if (url.includes("/github-app-installation/exists")) return { exists: true };
  if (url.includes("/github-app-installation/install-url")) {
    return { installUrl: "https://github.com/apps/first-tree/installations/new" };
  }
  if (url.includes("/github-app-installation")) {
    return {
      installationId: 42,
      accountLogin: "agent-team-foundation",
      accountType: "Organization",
      permissions: { issues: "read" },
      events: ["issues"],
      manageUrl: "https://github.com/settings/installations/42",
      suspended: false,
    };
  }
  if (url.includes("/names/atlas/availability")) return { available: true };
  if (url.includes("/connect-tokens")) {
    return { token: "connect-token", expiresIn: 600, command: "first-tree login connect-token" };
  }
  if (url.includes("/source-counts")) return { manual: 2, github: 1 };
  if (url.includes("/messages")) return { id: "msg-1", content: "hello" };
  if (url.includes("/events")) return { items: [], nextCursor: null };
  if (url.includes("/sessions") && !url.includes("/events")) return { items: [], nextCursor: null };
  if (url.includes("/agent-status")) return [];
  if (url.includes("/context-tree")) return { repo: "agent-team-foundation/first-tree-context" };
  if (url.includes("/source-repos")) return { repos: [{ url: "https://github.com/agent-team-foundation/first-tree" }] };
  if (url.includes("/me/docs")) return { kind: "markdown", body: "# README" };
  if (url.includes("/repos"))
    return [{ fullName: "agent-team-foundation/first-tree", cloneUrl: "https://github.com/a/b" }];
  if (url.includes("/clients"))
    return [{ id: "client-1", status: "connected", lastSeenAt: "2026-05-28T00:00:00.000Z" }];
  if (url.includes("/members")) return [{ id: "member-1", displayName: "Ada Lovelace" }];
  if (url.includes("/adapters/status")) return [{ configId: 1, connected: true }];
  if (url.includes("/adapter-mappings")) return [{ id: 1, agentId: "agent-human", platform: "slack" }];
  if (url.includes("/adapters")) return [{ id: 1, agentId: "agent-bot", platform: "slack", status: "active" }];
  if (url.includes("/activity")) return { total: 1, running: 1, byState: {}, clients: 1, agents: [] };
  if (url.includes("/managed-agents")) return [{ uuid: "agent-bot", displayName: "Atlas" }];
  if (url.includes("/skills")) return { skills: [{ name: "review", description: "Review code" }] };
  if (url.includes("/agents") && url.includes("/chats")) return { id: "chat-1" };
  if (url.includes("/agents") && url.includes("/test")) return { status: "success" };
  if (url.includes("/agents") && url.includes("/avatar")) return { avatarImageUrl: "https://example.com/a.png" };
  if (url.includes("/agents") && !url.includes("/sessions")) {
    return {
      items: [{ uuid: "agent-bot", displayName: "Atlas" }],
      nextCursor: null,
      uuid: "agent-bot",
      displayName: "Atlas",
    };
  }
  if (url.includes("/chats")) return { rows: [], items: [], nextCursor: null, chatId: "chat-1", unreadCount: 0 };
  if (url.includes("/organizations") || url.includes("/orgs/org-1"))
    return { id: "org-1", displayName: "Compute Team" };
  return { ok: true };
}

function setupStorage(): void {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  });
}

function setupFetch(): void {
  vi.stubGlobal("window", { dispatchEvent: () => {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ?? null });
      return jsonResponse(responseBodyFor(url));
    }),
  );
}

class TestFileReader {
  error: Error | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  result: string | null = null;

  readAsDataURL(_file: Blob): void {
    this.result = "data:text/plain;base64,ZmFrZQ==";
    this.onload?.();
  }
}

describe("web API wrappers", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
    setupStorage();
    setupFetch();
    vi.stubGlobal("FileReader", TestFileReader);
    setApiSelectedOrganizationId("org-1");
    setStoredTokens({ accessToken: "access-1", refreshToken: "refresh-1" });
  });

  it("formats routes and delegates through the shared API client", async () => {
    await activityApi.getActivityOverview();
    await activityApi.listClients();
    await activityApi.listOrgClients();
    await activityApi.getClient("client-1");
    await activityApi.getClientCapabilities("client-1");
    await activityApi.disconnectClient("client-1");
    await activityApi.resetAgentActivity("agent-bot");
    await activityApi.retireClient("client-1");
    await activityApi.generateConnectToken();

    await adaptersApi.listAdapters();
    await adaptersApi.getAdapter(1);
    await adaptersApi.createAdapter({ agentId: "agent-bot", platform: "slack", status: "active", credentials: {} });
    await adaptersApi.updateAdapter(1, { status: "inactive" });
    await adaptersApi.deleteAdapter(1);
    await adapterMappingsApi.listAdapterMappings();
    await adapterMappingsApi.createAdapterMapping({
      agentId: "agent-human",
      platform: "slack",
      externalUserId: "U123",
      boundVia: "manual",
    });
    await adapterMappingsApi.deleteAdapterMapping(1);
    await adapterStatusApi.getAdapterStatuses();

    await agentsApi.listAgents({ limit: 10, cursor: "c1", type: "agent", query: "atlas" });
    await agentsApi.listAllAgents({ limit: 5, cursor: "c2" });
    await agentsApi.listManagedAgents();
    await agentsApi.getAgent("agent-bot");
    await agentsApi.getAgentSkills("agent-bot");
    await agentsApi.createAgent({ type: "agent", displayName: "Atlas" });
    await agentsApi.checkAgentNameAvailability("atlas");
    await agentsApi.updateAgent("agent-bot", { displayName: "Atlas 2" });
    await agentsApi.rebindAgent("agent-bot", { clientId: "client-1", runtimeProvider: "claude-code" });
    await agentsApi.suspendAgent("agent-bot");
    await agentsApi.reactivateAgent("agent-bot");
    await agentsApi.testAgentConnection("agent-bot");
    await agentsApi.deleteAgentAvatar("agent-bot");
    await agentsApi.deleteAgent("agent-bot");
    await agentsApi.uploadAgentAvatar("agent-bot", new Blob(["avatar"], { type: "image/png" }));

    await agentConfigApi.getAgentConfig("agent-bot");
    await agentConfigApi.updateAgentConfig("agent-bot", { expectedVersion: 1, payload: {} });
    await agentConfigApi.dryRunAgentConfig("agent-bot", { model: "gpt-5.5" });
    await agentConfigApi.getAgentClientStatus("agent-bot");
    expect(agentStatusApi.chatAgentStatusQueryKey("chat-1")).toEqual(["chat-agent-status", "chat-1"]);
    await agentStatusApi.fetchChatAgentStatuses("chat-1");

    expect(attentionApi.attentionsInChatQueryKey("chat-1")).toEqual(["attentions", "chat", "chat-1"]);
    expect(attentionApi.respondAttentionMutationKey("attn-1")).toEqual(["attentions", "respond", "attn-1"]);
    await attentionApi.listAttentionsInChat("chat-1");
    await attentionApi.respondAttention("attn-1", { text: "approved" });

    await chatsApi.listChats({ limit: 10, cursor: "c1" });
    await chatsApi.getChat("chat-1");
    await chatsApi.listChatGithubEntities("chat-1");
    await chatsApi.renameChat("chat-1", "Planning");
    await chatsApi.patchChatEngagement("chat-1", "active");
    await chatsApi.sendChatMessage("chat-1", "hello");
    await chatsApi.sendFileMessage(
      "chat-1",
      { data: "ZmFrZQ==", mimeType: "image/png", filename: "image.png", size: 4, imageId: "image-1" },
      { mentions: ["agent-bot"] },
    );
    await chatsApi.createAgentChat("agent-bot");
    await chatsApi.listChatMessages("chat-1", { limit: 20, cursor: "c2" });
    expect(await chatsApi.readFileAsBase64(new File(["fake"], "fake.txt", { type: "text/plain" }))).toBe("ZmFrZQ==");

    await authApi.login("ada", "password");
    await contextTreeApi.getContextTreeSnapshot("org-1", "7d");
    await githubAppApi.getGithubAppInstallation("org-1");
    await githubAppApi.getGithubAppInstallationExists("org-1");
    await githubAppApi.getGithubAppInstallUrl("org-1", "/onboarding");
    await githubApi.listGithubRepos();
    await meChatsApi.listMeChats({
      limit: 10,
      cursor: "c1",
      filter: "unread",
      engagement: "active",
      origin: ["manual", "github"],
      with: ["agent-bot"],
      watching: true,
    });
    await meChatsApi.listMeChatSourceCounts({ engagement: "active" });
    await meChatsApi.createMeChat({ participantIds: ["agent-bot"], topic: "Plan" });
    await meChatsApi.markMeChatRead("chat-1");
    await meChatsApi.markMeChatUnread("chat-1");
    await meChatsApi.addMeChatParticipants("chat-1", { participantIds: ["agent-team"] });
    await meChatsApi.joinMeChat("chat-1");
    await meChatsApi.leaveMeChat("chat-1");
    await meDocsApi.getMeDoc("chat-1", { agentId: "agent-bot", path: "README.md" });

    await membersApi.listMembers();
    await membersApi.updateMember("member-1", { displayName: "Ada" });
    await membersApi.deleteMember("member-1");
    await onboardingEventsApi.reportOnboardingEvent("team_renamed");
    await onboardingEventsApi.markOnboardingCompleted();
    await orgSettingsApi.getContextTreeSetting("org-1");
    await orgSettingsApi.putContextTreeSetting("org-1", { repo: "agent-team-foundation/first-tree-context" });
    await orgSettingsApi.deleteContextTreeSetting("org-1");
    await orgSettingsApi.getSourceReposSetting("org-1");
    await orgSettingsApi.putSourceReposSetting("org-1", {
      repos: [{ url: "https://github.com/agent-team-foundation/first-tree" }],
    });
    await orgSettingsApi.deleteSourceReposSetting("org-1");
    await organizationsApi.getOrganization("org-1");
    await organizationsApi.updateOrganization("org-1", { displayName: "Compute Team" });
    await overviewApi.getOverview();

    expect(sessionsApi.sessionQueryKey("agent-bot", "chat-1")).toEqual(["session", "agent-bot", "chat-1"]);
    expect(sessionsApi.agentSessionsQueryKey("agent-bot")).toEqual(["agent-sessions", "agent-bot"]);
    expect(sessionsApi.asToolCallPayload({ toolUseId: "1", name: "bash", args: {}, status: "ok" })).toMatchObject({
      name: "bash",
    });
    expect(sessionsApi.asErrorPayload({ source: "runtime", message: "failed" })).toMatchObject({ source: "runtime" });
    expect(sessionsApi.asAssistantTextPayload({ text: "hello" })).toEqual({ text: "hello" });
    expect(sessionsApi.asTurnEndPayload({ status: "success" })).toEqual({ status: "success" });
    await sessionsApi.listSessions({ limit: 10, cursor: "c1", state: "running", agentId: "agent-bot" });
    await sessionsApi.listAgentSessions("agent-bot", { state: "running", runtimeState: "working" });
    await sessionsApi.getSession("agent-bot", "chat-1");
    await sessionsApi.listSessionEvents("agent-bot", "chat-1", { limit: 10, cursor: 2, direction: "desc" });
    await sessionsApi.suspendSession("agent-bot", "chat-1");
    await sessionsApi.terminateSession("agent-bot", "chat-1");

    expect(calls.some((call) => call.url.includes("/orgs/org-1/activity"))).toBe(true);
    expect(calls.some((call) => call.method === "PATCH")).toBe(true);
    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
  });

  it("refreshes tokens on a 401 and surfaces API errors", async () => {
    let protectedCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/auth/refresh")) return jsonResponse({ accessToken: "access-2", refreshToken: "refresh-2" });
        if (url.includes("/protected")) {
          protectedCalls++;
          return protectedCalls === 1 ? jsonResponse({ error: "expired" }, 401) : jsonResponse({ ok: true });
        }
        return jsonResponse({ error: "bad", details: [{ path: ["name"], message: "Required" }] }, 400);
      }),
    );

    await expect(api.get("/protected")).resolves.toEqual({ ok: true });
    expect(getStoredTokens()).toEqual({ accessToken: "access-2", refreshToken: "refresh-2" });
    await expect(api.post("/broken", {})).rejects.toMatchObject({
      status: 400,
      issues: [{ path: ["name"], message: "Required" }],
    });
    await expect(refreshAccessToken()).resolves.toEqual({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(new ApiError(418, "teapot").name).toBe("ApiError");
  });
});
