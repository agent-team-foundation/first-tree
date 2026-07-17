// @vitest-environment happy-dom

import type { ChatGithubEntity, ChatGitlabEntity, ChatParticipantDetail } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityOverview, RuntimeAgent } from "../../../api/activity.js";
import type { SessionListItem } from "../../../api/sessions.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({
  getActivityOverview: vi.fn(),
}));

const chatMocks = vi.hoisted(() => ({
  createAgentChat: vi.fn(),
  listChatGithubEntities: vi.fn(),
  listChatGitlabEntities: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  listAgentSessions: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  role: "admin" as "admin" | "member",
}));

const pulseMock = vi.hoisted(() => ({
  value: {
    stale: false,
    aggregated: [
      { workingCount: 2, errorMask: false },
      { workingCount: 1, errorMask: true },
      { workingCount: 0, errorMask: false },
    ],
  },
}));

vi.mock("../../../api/activity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/activity.js")>()),
  getActivityOverview: activityMocks.getActivityOverview,
}));

vi.mock("../../../api/chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/chats.js")>()),
  createAgentChat: chatMocks.createAgentChat,
  listChatGithubEntities: chatMocks.listChatGithubEntities,
  listChatGitlabEntities: chatMocks.listChatGitlabEntities,
}));

vi.mock("../../../api/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/sessions.js")>()),
  agentSessionsQueryKey: (agentId: string) => ["agent-sessions", agentId] as const,
  listAgentSessions: sessionMocks.listAgentSessions,
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => ({ role: authMock.role }),
}));

vi.mock("../../../components/add-participant-dropdown.js", () => ({
  AddParticipantDropdown: ({ variant }: { variant: "icon" | "inline" }) => (
    <button aria-label="Add participant" type="button">
      Add participant ({variant})
    </button>
  ),
}));

vi.mock("../../../components/avatar.js", () => ({
  Avatar: ({ name }: { name: string }) => (
    <span aria-label={`Avatar ${name}`} role="img">
      {name.slice(0, 1)}
    </span>
  ),
}));

vi.mock("../../../components/chat/agent-status-panel.js", () => ({
  AgentStatusPanel: ({
    agents,
    canManage,
  }: {
    agents: ChatParticipantDetail[];
    canManage: (agentId: string) => boolean;
  }) => (
    <div data-testid="agent-status-panel">
      {agents.map((agent) => (
        <div key={agent.agentId}>
          {agent.displayName} · {canManage(agent.agentId) ? "manageable" : "readonly"}
        </div>
      ))}
    </div>
  ),
}));

vi.mock("../../../hooks/pulse-context.js", () => ({
  usePulse: () => pulseMock.value,
}));

vi.mock("../../../lib/use-agent-name-map.js", () => ({
  useAgentNameMap: () => (id: string) =>
    ({
      "agent-working": "Working Agent",
      "agent-blocked": "Blocked Agent",
      "agent-idle": "Idle Agent",
      "human-1": "Human One",
    })[id] ?? id,
}));

vi.mock("../../../lib/use-client-map.js", () => ({
  useClientMap: () => ({
    resolve: (clientId: string) =>
      ({
        "client-working": { hostname: "workstation.local" },
        "client-blocked": { hostname: "blocked-host.local" },
      })[clientId] ?? null,
  }),
}));

const NOW = "2026-05-28T12:00:00.000Z";

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

async function renderDom(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={createClient()}>{element}</QueryClientProvider>);
  });
  await flush();
  return { container, root };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function keyDown(element: Element | null, key: string): Promise<void> {
  if (!element) throw new Error("Expected element for keydown");
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

async function setValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function waitForText(container: ParentNode, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}"`);
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === text) ?? null;
}

function cssPx(value: number): string {
  return `${value}${"px"}`;
}

function participant(id: string, type: "human" | "agent", displayName = id): ChatParticipantDetail {
  return {
    agentId: id,
    role: "member",
    mode: "full",
    joinedAt: NOW,
    name: id,
    displayName,
    type,
    avatarColorToken: null,
    avatarImageUrl: null,
  };
}

function runtimeAgent(overrides: Partial<RuntimeAgent> & { agentId: string }): RuntimeAgent {
  return {
    agentId: overrides.agentId,
    clientId: overrides.clientId ?? "client-working",
    runtimeType: overrides.runtimeType ?? "claude-code",
    runtimeState: overrides.runtimeState ?? "idle",
    activeSessions: overrides.activeSessions ?? 0,
    totalSessions: overrides.totalSessions ?? 0,
    runtimeUpdatedAt: overrides.runtimeUpdatedAt ?? NOW,
    type: overrides.type ?? "agent",
    managedByMe: overrides.managedByMe ?? true,
  };
}

function activityOverview(agents: RuntimeAgent[]): ActivityOverview {
  return {
    total: agents.length,
    running: agents.filter((agent) => agent.runtimeState === "working").length,
    byState: {
      idle: agents.filter((agent) => agent.runtimeState === "idle").length,
      working: agents.filter((agent) => agent.runtimeState === "working").length,
      blocked: agents.filter((agent) => agent.runtimeState === "blocked").length,
      error: agents.filter((agent) => agent.runtimeState === "error").length,
    },
    clients: 2,
    agents,
  };
}

function session(overrides: Partial<SessionListItem> & { chatId: string }): SessionListItem {
  return {
    agentId: overrides.agentId ?? "agent-working",
    chatId: overrides.chatId,
    state: overrides.state ?? "active",
    runtimeState: overrides.runtimeState ?? "working",
    startedAt: overrides.startedAt ?? NOW,
    lastActivityAt: overrides.lastActivityAt ?? NOW,
    messageCount: overrides.messageCount ?? 1,
    summary: overrides.summary ?? null,
    topic: overrides.topic ?? null,
  };
}

function githubEntity(
  overrides: Partial<ChatGithubEntity> & { entityType: ChatGithubEntity["entityType"] },
): ChatGithubEntity {
  return {
    entityType: overrides.entityType,
    entityKey: overrides.entityKey ?? "acme/web#1",
    boundVia: overrides.boundVia ?? "direct",
    htmlUrl: overrides.htmlUrl ?? "https://github.com/acme/web/pull/1",
    title: overrides.title ?? null,
    state: overrides.state ?? null,
    number: overrides.number ?? null,
  };
}

function gitlabEntity(
  overrides: Partial<ChatGitlabEntity> & { entityType: ChatGitlabEntity["entityType"] },
): ChatGitlabEntity {
  return {
    entityType: overrides.entityType,
    entityUrl: overrides.entityUrl ?? "https://gitlab.internal/acme/web/-/merge_requests/1",
    projectPath: overrides.projectPath ?? "acme/web",
    entityIid: overrides.entityIid ?? 1,
    title: overrides.title ?? null,
    state: overrides.state ?? null,
    status: overrides.status ?? "active",
    boundVia: overrides.boundVia ?? "identity_target",
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  vi.clearAllMocks();
  authMock.role = "admin";
  pulseMock.value = {
    stale: false,
    aggregated: [
      { workingCount: 2, errorMask: false },
      { workingCount: 1, errorMask: true },
      { workingCount: 0, errorMask: false },
    ],
  };
  activityMocks.getActivityOverview.mockResolvedValue(
    activityOverview([
      runtimeAgent({
        agentId: "agent-working",
        runtimeState: "working",
        activeSessions: 1,
        totalSessions: 2,
        clientId: "client-working",
      }),
      runtimeAgent({
        agentId: "agent-blocked",
        runtimeState: "blocked",
        activeSessions: 0,
        totalSessions: 1,
        clientId: "client-blocked",
      }),
      runtimeAgent({ agentId: "agent-idle", runtimeState: "idle", clientId: null, totalSessions: 0 }),
      runtimeAgent({ agentId: "human-1", runtimeState: "idle", clientId: null, type: "human" }),
    ]),
  );
  chatMocks.createAgentChat.mockResolvedValue({ id: "chat-new" });
  chatMocks.listChatGithubEntities.mockResolvedValue({ items: [] });
  chatMocks.listChatGitlabEntities.mockResolvedValue({ items: [] });
  sessionMocks.listAgentSessions.mockResolvedValue([
    session({ chatId: "chat-build", topic: "Build deploy", state: "active" }),
    session({ chatId: "chat-notes", topic: null, summary: "Notes summary", state: "suspended" }),
    session({ chatId: "chat-evicted", topic: "Hidden old session", state: "evicted" }),
  ]);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ParticipantsSection extra DOM behavior", () => {
  it("shows loading, empty, capped roster, and read-only add gates", async () => {
    const { ParticipantsSection } = await import("../right-sidebar/participants-section.js");
    const loading = await renderDom(
      <ParticipantsSection
        chatId="chat-1"
        participants={[]}
        participantsLoading
        managedByMe={new Map()}
        onAdded={() => undefined}
        readOnly={false}
      />,
    );
    expect(loading.container.textContent).toContain("Loading…");
    await act(async () => loading.root.unmount());

    const empty = await renderDom(
      <ParticipantsSection
        chatId="chat-1"
        participants={[]}
        participantsLoading={false}
        managedByMe={new Map()}
        onAdded={() => undefined}
        readOnly={false}
      />,
    );
    expect(empty.container.textContent).toContain("No participants yet.");
    expect(empty.container.querySelector('button[aria-label="Add participant"]')).not.toBeNull();
    await act(async () => empty.root.unmount());

    authMock.role = "member";
    const people = [
      participant("agent-1", "agent", "Agent One"),
      participant("agent-2", "agent", "Agent Two"),
      participant("agent-3", "agent", "Agent Three"),
      participant("agent-4", "agent", "Agent Four"),
      participant("human-1", "human", "Human One"),
      participant("human-2", "human", "Human Two"),
    ];
    const roster = await renderDom(
      <ParticipantsSection
        chatId="chat-1"
        participants={people}
        participantsLoading={false}
        managedByMe={new Map([["agent-2", true]])}
        onAdded={() => undefined}
        readOnly
      />,
    );
    expect(roster.container.textContent).toContain("Participants · 6");
    expect(roster.container.textContent).toContain("Agent Two · manageable");
    expect(roster.container.textContent).toContain("Agent One · readonly");
    expect(roster.container.textContent).toContain("Human One");
    expect(roster.container.textContent).not.toContain("Human Two");
    expect(roster.container.querySelector('button[aria-label="Add participant"]')).toBeNull();

    await click(buttonByText(roster.container, "Show all · 6"));
    expect(roster.container.textContent).toContain("Human Two");
    await click(buttonByText(roster.container, "Show less"));
    expect(roster.container.textContent).not.toContain("Human Two");
    await act(async () => roster.root.unmount());
  });
});

describe("ChatRightSidebar extra DOM behavior", () => {
  it("resizes with keyboard, persists commits, resets, and disables resize for fixed width", async () => {
    const { ChatRightSidebar } = await import("../right-sidebar/index.js");
    localStorage.setItem("first-tree:chat-right-sidebar:width:v1", "320");
    const participants = [participant("agent-1", "agent", "Agent One")];
    const resizable = await renderDom(
      <ChatRightSidebar
        chatId="chat-1"
        participants={participants}
        participantsLoading={false}
        managedByMe={new Map([["agent-1", true]])}
        onAdded={() => undefined}
        readOnly={false}
      />,
    );
    const aside = resizable.container.querySelector<HTMLElement>('aside[aria-label="Chat details"]');
    expect(aside?.style.width).toBe(cssPx(320));

    const handle = resizable.container.querySelector('button[aria-label="Resize chat details"]');
    await keyDown(handle, "ArrowLeft");
    expect(aside?.style.width).toBe(cssPx(336));
    expect(localStorage.getItem("first-tree:chat-right-sidebar:width:v1")).toBe("336");
    await keyDown(handle, "ArrowRight");
    expect(aside?.style.width).toBe(cssPx(320));
    await act(async () => {
      handle?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(aside?.style.width).toBe(cssPx(360));
    expect(localStorage.getItem("first-tree:chat-right-sidebar:width:v1")).toBe("360");
    await act(async () => resizable.root.unmount());

    const fixed = await renderDom(
      <ChatRightSidebar
        chatId="chat-1"
        participants={participants}
        participantsLoading={false}
        managedByMe={new Map()}
        onAdded={() => undefined}
        readOnly
        width={312}
      />,
    );
    const fixedAside = fixed.container.querySelector<HTMLElement>('aside[aria-label="Chat details"]');
    expect(fixedAside?.style.width).toBe(cssPx(312));
    expect(fixed.container.querySelector('button[aria-label="Resize chat details"]')).toBeNull();
    expect(fixed.container.querySelector('button[aria-label="Add participant"]')).toBeNull();
    await act(async () => fixed.root.unmount());
  });
});

describe("GitHubSection extra DOM behavior", () => {
  it("renders nothing for empty bindings and sorts populated rows by type", async () => {
    const { GitHubSection } = await import("../right-sidebar/github-section.js");
    const empty = await renderDom(<GitHubSection chatId="chat-empty" />);
    await flush();
    expect(empty.container.textContent).toBe("");
    await act(async () => empty.root.unmount());

    chatMocks.listChatGithubEntities.mockResolvedValueOnce({
      items: [
        githubEntity({
          entityType: "commit",
          entityKey: "acme/web@abc123",
          htmlUrl: "https://github.com/acme/web/commit/abc123",
        }),
        githubEntity({
          entityType: "issue",
          entityKey: "acme/web#8",
          htmlUrl: "https://github.com/acme/web/issues/8",
          title: "Crash on launch",
          state: "closed",
        }),
        githubEntity({
          entityType: "pull_request",
          entityKey: "acme/web#9",
          htmlUrl: "https://github.com/acme/web/pull/9",
          title: "Ship release",
          state: "merged",
        }),
        githubEntity({
          entityType: "discussion",
          entityKey: "acme/web#10",
          htmlUrl: "https://github.com/acme/web/discussions/10",
          title: "Roadmap",
          state: "open",
        }),
      ],
    });
    const populated = await renderDom(<GitHubSection chatId="chat-populated" />);
    await waitForText(populated.container, "GitHub · 4");

    const hrefs = [...populated.container.querySelectorAll<HTMLAnchorElement>("a")].map((a) => a.href);
    expect(hrefs).toEqual([
      "https://github.com/acme/web/pull/9",
      "https://github.com/acme/web/issues/8",
      "https://github.com/acme/web/discussions/10",
      "https://github.com/acme/web/commit/abc123",
    ]);
    expect(populated.container.textContent).toContain("Ship release");
    expect(populated.container.textContent).toContain("web#9");
    expect(populated.container.textContent).not.toContain("acme/web#9Merged");
    expect(populated.container.textContent).toContain("Closed");
    expect(populated.container.textContent).toContain("Open");
    expect(populated.container.textContent).toContain("acme/web@abc123");
    await act(async () => populated.root.unmount());
  });
});

describe("GitLabSection extra DOM behavior", () => {
  it("renders an automatic merge-request binding and sorts it before issues", async () => {
    const { GitLabSection } = await import("../right-sidebar/gitlab-section.js");
    const mergeRequestUrl = "https://gitlab.internal/Acme/Reviews/-/merge_requests/17";
    chatMocks.listChatGitlabEntities.mockResolvedValueOnce({
      items: [
        gitlabEntity({
          entityType: "issue",
          entityUrl: "https://gitlab.internal/Acme/Reviews/-/issues/8",
          projectPath: "Acme/Reviews",
          entityIid: 8,
          title: "Follow-up issue",
          state: "closed",
          boundVia: "human_declared",
        }),
        gitlabEntity({
          entityType: "pull_request",
          entityUrl: mergeRequestUrl,
          projectPath: "Acme/Reviews",
          entityIid: 17,
          title: "Review this change",
          state: "open",
          boundVia: "identity_target",
        }),
      ],
    });

    const rendered = await renderDom(<GitLabSection chatId="chat-gitlab" />);
    await waitForText(rendered.container, "Review this change");

    const hrefs = [...rendered.container.querySelectorAll<HTMLAnchorElement>("a")].map((anchor) => anchor.href);
    expect(hrefs).toEqual([mergeRequestUrl, "https://gitlab.internal/Acme/Reviews/-/issues/8"]);
    expect(rendered.container.textContent).toContain("GitLab · 2");
    expect(rendered.container.textContent).toContain("Reviews!17");
    expect(rendered.container.textContent).toContain("Open");
    expect(rendered.container.textContent).toContain("Closed");
    await act(async () => rendered.root.unmount());
  });
});

describe("AgentRoster extra DOM behavior", () => {
  it("filters by search and attention pill, opens sessions, and starts a new chat", async () => {
    const { AgentRoster } = await import("../roster/index.js");
    const onSelectAgent = vi.fn();
    const onSelectChat = vi.fn();
    const { container, root } = await renderDom(
      <AgentRoster
        selectedAgentId="agent-working"
        selectedChatId="chat-build"
        onSelectAgent={onSelectAgent}
        onSelectChat={onSelectChat}
      />,
    );

    await waitForText(container, "4 members");
    await waitForText(container, "Build deploy");
    expect(container.textContent).toContain("1 / 2");
    expect(container.textContent).not.toContain("Hidden old session");

    await click(buttonByText(container, "Notes summary"));
    expect(onSelectChat).toHaveBeenCalledWith("agent-working", "chat-notes");

    await click(buttonByText(container, "New chat"));
    await flush();
    expect(chatMocks.createAgentChat).toHaveBeenCalledWith("agent-working");
    expect(onSelectChat).toHaveBeenCalledWith("agent-working", "chat-new");

    const input = container.querySelector<HTMLInputElement>('input[placeholder="Filter…"]');
    if (!input) throw new Error("Roster filter input missing");
    await setValue(input, "blocked-host");
    expect(container.textContent).toContain("Blocked Agent");
    expect(container.textContent).not.toContain("Working Agent");

    const attnButton =
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.replace(/\s+/g, "").startsWith("attn") ?? false,
      ) ?? null;
    await click(attnButton);
    expect(container.textContent).toContain("Blocked Agent");
    expect(container.textContent).not.toContain("Human One");

    await act(async () => root.unmount());
  });

  it("renders the no-agents and no-matches empty states", async () => {
    const { AgentRoster } = await import("../roster/index.js");
    activityMocks.getActivityOverview.mockResolvedValueOnce(activityOverview([]));
    const empty = await renderDom(
      <AgentRoster
        selectedAgentId={null}
        selectedChatId={null}
        onSelectAgent={() => undefined}
        onSelectChat={() => undefined}
      />,
    );
    await waitForText(empty.container, "No agents");
    expect(empty.container.textContent).toContain("Your first agent will appear here.");
    await act(async () => empty.root.unmount());

    const noMatches = await renderDom(
      <AgentRoster
        selectedAgentId={null}
        selectedChatId={null}
        onSelectAgent={() => undefined}
        onSelectChat={() => undefined}
      />,
    );
    await waitForText(noMatches.container, "4 members");
    const input = noMatches.container.querySelector<HTMLInputElement>('input[placeholder="Filter…"]');
    if (!input) throw new Error("Roster filter input missing");
    await setValue(input, "does-not-match");
    expect(noMatches.container.textContent).toContain("No matches");
    await act(async () => noMatches.root.unmount());
  });
});
