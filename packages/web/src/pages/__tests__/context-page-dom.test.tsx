// @vitest-environment happy-dom

import type { ContextTreeIoEvent, ContextTreeSnapshot } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_CONTEXT_SNAPSHOT } from "../context-preview-mock.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const contextApiMocks = vi.hoisted(() => ({
  getContextTreeSnapshot: vi.fn(),
  initializeContextTree: vi.fn(),
}));

const agentApiMocks = vi.hoisted(() => ({
  listManagedAgents: vi.fn(),
}));

const resourceApiMocks = vi.hoisted(() => ({
  createTeamResourceForOrg: vi.fn(),
  listTeamResourcesForOrg: vi.fn(),
}));

const onboardingEventMocks = vi.hoisted(() => ({
  getTreeSetupStatus: vi.fn(),
  postOnboardingStartChat: vi.fn(),
  postTreeSetupStartChat: vi.fn(),
  reportOnboardingEvent: vi.fn(),
}));

const orgSettingsMocks = vi.hoisted(() => ({
  getContextTreeSetting: vi.fn(),
}));

const githubAppMocks = vi.hoisted(() => ({
  getGithubAppInstallation: vi.fn(),
  getGithubAppInstallationExists: vi.fn(),
  getGithubAppInstallUrl: vi.fn(),
}));

const githubMocks = vi.hoisted(() => ({
  listGithubRepos: vi.fn(),
  listOrgGithubRepos: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1" as string | null,
    role: "member" as "admin" | "member" | null,
  },
}));

vi.mock("../../api/context-tree.js", () => contextApiMocks);
vi.mock("../../api/agents.js", () => agentApiMocks);
vi.mock("../../api/resources.js", () => resourceApiMocks);
vi.mock("../../api/onboarding-events.js", () => onboardingEventMocks);
vi.mock("../../api/org-settings.js", () => orgSettingsMocks);
vi.mock("../../api/github-app.js", () => githubAppMocks);
vi.mock("../../api/github.js", () => githubMocks);

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(
  element: ReactElement,
): Promise<{ container: HTMLElement; root: Root; queryClient: QueryClient }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          {/* Outside Routes so it keeps tracking the location after a navigate
              away from "/" (e.g. the Context build entry → Settings/Onboarding). */}
          <LocationProbe />
          <Routes>
            <Route path="/" element={element} />
            <Route path="/settings/resources" element={<div>Resources route</div>} />
            <Route path="/onboarding" element={<div>Onboarding route</div>} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root, queryClient };
}

async function rerender(root: Root, queryClient: QueryClient, element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <LocationProbe />
          <Routes>
            <Route path="/" element={element} />
            <Route path="/settings/resources" element={<div>Resources route</div>} />
            <Route path="/onboarding" element={<div>Onboarding route</div>} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function waitForText(container: ParentNode, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Missing text: ${text}\n${container.textContent ?? ""}`);
}

async function waitForCondition(check: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await flush();
  }
  throw new Error(message);
}

function snapshot(overrides: Partial<ContextTreeSnapshot> = {}): ContextTreeSnapshot {
  return {
    ...MOCK_CONTEXT_SNAPSHOT,
    syncedAt: "2026-05-28T12:00:00.000Z",
    ...overrides,
    contextStatus: overrides.contextStatus ?? MOCK_CONTEXT_SNAPSHOT.contextStatus,
    summary: overrides.summary ?? MOCK_CONTEXT_SNAPSHOT.summary,
    usage: overrides.usage ?? MOCK_CONTEXT_SNAPSHOT.usage,
    io: overrides.io ?? MOCK_CONTEXT_SNAPSHOT.io,
    nodes: overrides.nodes ?? MOCK_CONTEXT_SNAPSHOT.nodes,
    updates: overrides.updates ?? MOCK_CONTEXT_SNAPSHOT.updates,
    edges: overrides.edges ?? MOCK_CONTEXT_SNAPSHOT.edges,
    changes: overrides.changes ?? MOCK_CONTEXT_SNAPSHOT.changes,
  };
}

function ioEvent(index: number, overrides: Partial<ContextTreeIoEvent> = {}): ContextTreeIoEvent {
  const isWrite = index % 3 === 0;
  return {
    id: `io-event-${index}`,
    agentId: `agent-${index}`,
    agentName: index % 2 === 0 ? `qa.bot-${index}` : `Reviewer ${index}`,
    agentAvatarColorToken: index % 2 === 0 ? "hue-2" : null,
    runtimeProvider: isWrite ? "codex" : "claude-code",
    action: isWrite ? "write" : "read",
    source: isWrite ? "codex_file_change" : "claude_read_tool",
    targetKind: "file",
    targetPath: `domains/topic-${index}/NODE.md`,
    chatId: `chat-${index}`,
    chatTitle: index % 3 === 0 ? "" : `topic-${index}`,
    viewerCanAccess: index % 5 !== 0,
    createdAt: new Date(Date.UTC(2026, 4, 28, 12, 0, 0) - index * 60_000).toISOString(),
    ...overrides,
  };
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  authMock.value = { organizationId: "org-1", role: "member" };
  contextApiMocks.getContextTreeSnapshot.mockReset();
  contextApiMocks.initializeContextTree.mockReset();
  agentApiMocks.listManagedAgents.mockReset();
  resourceApiMocks.listTeamResourcesForOrg.mockReset();
  resourceApiMocks.createTeamResourceForOrg.mockReset();
  onboardingEventMocks.getTreeSetupStatus.mockReset();
  onboardingEventMocks.postOnboardingStartChat.mockReset();
  onboardingEventMocks.postTreeSetupStartChat.mockReset();
  onboardingEventMocks.reportOnboardingEvent.mockReset();
  orgSettingsMocks.getContextTreeSetting.mockReset();
  agentApiMocks.listManagedAgents.mockResolvedValue([]);
  resourceApiMocks.listTeamResourcesForOrg.mockResolvedValue([]);
  resourceApiMocks.createTeamResourceForOrg.mockResolvedValue({
    id: "repo-1",
    type: "repo",
    defaultEnabled: "recommended",
    payload: { url: "https://github.com/acme/acme-web.git" },
  });
  orgSettingsMocks.getContextTreeSetting.mockResolvedValue({
    repo: "https://github.com/acme/context-tree",
    branch: "main",
  });
  onboardingEventMocks.getTreeSetupStatus.mockResolvedValue({
    needsTreeSetup: false,
    hasTreeBinding: true,
    hasTreeSetupStartChat: true,
  });
  onboardingEventMocks.postOnboardingStartChat.mockResolvedValue({ chatId: "chat-onboarding-1" });
  onboardingEventMocks.postTreeSetupStartChat.mockResolvedValue({ chatId: "chat-tree-1" });
  githubAppMocks.getGithubAppInstallation.mockReset();
  githubAppMocks.getGithubAppInstallationExists.mockReset();
  githubAppMocks.getGithubAppInstallUrl.mockReset();
  githubMocks.listGithubRepos.mockReset();
  githubMocks.listOrgGithubRepos.mockReset();
  // Default: GitHub App not connected and no repos granted — the inline build
  // entry shows its install CTA. Tests that exercise the connected/pick states
  // override these.
  githubAppMocks.getGithubAppInstallation.mockResolvedValue(null);
  githubAppMocks.getGithubAppInstallationExists.mockResolvedValue(false);
  githubAppMocks.getGithubAppInstallUrl.mockResolvedValue(
    "https://github.com/apps/first-tree/installations/new?state=test",
  );
  githubMocks.listGithubRepos.mockResolvedValue([]);
  githubMocks.listOrgGithubRepos.mockResolvedValue([]);
  contextApiMocks.initializeContextTree.mockResolvedValue({
    repo: "https://github.com/acme/acme-context-tree.git",
    htmlUrl: "https://github.com/acme/acme-context-tree",
    branch: "main",
    nodePath: "NODE.md",
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("ContextPage DOM behavior", () => {
  it("renders live preview, selects change groups, expands IO, and navigates accessible chats", async () => {
    vi.setSystemTime(new Date("2026-05-28T12:15:00.000Z"));
    const { ContextPage } = await import("../context.js");
    // 22 events so the 20-row default still leaves rows behind "Show all".
    const events = Array.from({ length: 22 }, (_, index) => ioEvent(index + 1));
    const liveSnapshot = snapshot({
      contextStatus: { label: "Needs attention", detail: "Tree sync is stale.", severity: "warning" },
      summary: { addedCount: 2, editedCount: 8, removedCount: 1, changedNodeCount: 3 },
      io: {
        ...MOCK_CONTEXT_SNAPSHOT.io,
        recentEvents: events,
        // This case exercises the reads stream + pagination; writes are covered
        // by the dedicated write-feed test below.
        writes: [],
        writesTotal: 0,
      },
    });

    const { container, root, queryClient } = await renderDom(<ContextPage previewSnapshot={liveSnapshot} />);
    expect(contextApiMocks.getContextTreeSnapshot).not.toHaveBeenCalled();
    // The old centered "Context tree is live" hero is now a LIVE chip in the
    // PageHeader right slot; the warning detail still renders via ContextStatusNote.
    expect(container.textContent).toContain("LIVE");
    expect(container.textContent).toContain("Tree sync is stale.");
    expect(container.textContent).toContain("4 agents");
    expect(container.textContent).toContain("read the tree 18 times");
    expect(container.textContent).toContain("2 agents");
    expect(container.textContent).toContain("wrote 5 times");
    expect(container.textContent).toContain("23total nodes");
    expect(container.textContent).toContain("+6 updates");
    // The usage-feed avatar is a generated identicon (an svg), not text initials.
    expect(container.querySelector(".context-usage-feed-avatar svg")).not.toBeNull();
    expect(container.textContent).toContain("qa.bot-2");
    expect(container.textContent).toContain("#chat-3");

    await click(buttonByText(container, "Show all 22"));
    expect(container.textContent).toContain("#hat-21");

    await click(buttonByText(container, "Nova"));
    expect(container.querySelector(".context-network-card.is-live")?.textContent).toContain("Nova");

    await click(buttonByText(container, "#topic-1"));
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/?c=chat-1");

    const nextSnapshot = snapshot({
      ...liveSnapshot,
      io: {
        ...liveSnapshot.io,
        recentEvents: [ioEvent(99, { id: "new-event", agentName: "Fresh Agent" }), ...events],
      },
    });
    await rerender(root, queryClient, <ContextPage previewSnapshot={nextSnapshot} />);
    expect(container.querySelector(".context-usage-feed-row.is-fresh")?.textContent).toContain("Fresh Agent");

    await act(async () => root.unmount());
  });

  it("renders empty usage and empty change map states", async () => {
    const { ContextPage } = await import("../context.js");
    const empty = snapshot({
      summary: { addedCount: 0, editedCount: 0, removedCount: 0, changedNodeCount: 0 },
      usage: {
        windowDays: 7,
        agentCount: 0,
        usageCount: 0,
        recentEvents: [],
      },
      io: {
        windowDays: 7,
        summary: {
          read: { agentCount: 0, eventCount: 0, targetCount: 0 },
          write: { agentCount: 0, eventCount: 0, targetCount: 0 },
        },
        agents: [],
        recentEvents: [],
        writes: [],
        writesTotal: 0,
        skipped: { windowDays: 7, totalEventCount: 0, reasons: [] },
      },
      nodes: MOCK_CONTEXT_SNAPSHOT.nodes.map((node) => ({ ...node, changeType: null, changedAtCommit: null })),
      updates: [],
    });

    const { container, root } = await renderDom(<ContextPage previewSnapshot={empty} />);
    expect(container.textContent).toContain("No context updates in the past 7 days.");
    expect(container.textContent).toContain("No Context Tree reads or writes in the past 7 days.");
    // LIVE reflects the tree's sync liveness, not usage: a synced (active)
    // snapshot shows the header LIVE chip even with zero reads/writes / no
    // events (the streaming IO feed is what hides when empty).
    expect(container.textContent).toContain("LIVE");
    await act(async () => root.unmount());
  });

  it("renders git-derived writes (PR, risk, attribution) and filters reads vs writes", async () => {
    vi.setSystemTime(new Date("2026-05-28T12:15:00.000Z"));
    const { ContextPage } = await import("../context.js");
    // MOCK_CONTEXT_SNAPSHOT.io carries 3 sample writes + 3 reads.
    const { container, root } = await renderDom(<ContextPage previewSnapshot={snapshot()} />);

    const feed = container.querySelector(".context-usage-feed");
    expect(feed).not.toBeNull();

    // Default All: both a write row and a read row are present.
    const writeRows = () => [...container.querySelectorAll(".context-usage-feed-row.is-write")];
    const readRows = () =>
      [...container.querySelectorAll(".context-usage-feed-row")].filter((row) => !row.classList.contains("is-write"));
    expect(writeRows().length).toBeGreaterThan(0);
    expect(readRows().length).toBeGreaterThan(0);

    // Agent-attributed write carries the PR chip as a real GitHub link + summary.
    const prLinks = [...container.querySelectorAll<HTMLAnchorElement>("a.context-usage-feed-pr")];
    const pr514 = prLinks.find((link) => link.textContent === `#${514}`);
    expect(pr514).toBeDefined();
    expect(pr514?.getAttribute("href")).toContain("/pull/514");
    expect(container.textContent).toContain("record team deletion semantics");

    // Unmatched git author (a PR merge) is shown honestly as the git author,
    // with the high-risk badge on the removal.
    expect(container.textContent).toContain("yuezengwu");
    expect(container.textContent).toContain("git author");
    expect(container.querySelector(".context-usage-feed-risk.is-high")).not.toBeNull();

    // Root write (empty node path) renders a friendly label, never a blank target.
    const rootWriteRow = writeRows().find((row) => row.textContent?.includes("refresh the root index"));
    expect(rootWriteRow).toBeDefined();
    expect(rootWriteRow?.querySelector(".context-usage-feed-node")).toBeNull();
    expect(rootWriteRow?.textContent).toContain("the Context Tree");

    // Filter → Writes: only write rows remain.
    await click(buttonByText(container, "Writes"));
    expect(readRows().length).toBe(0);
    expect(writeRows().length).toBeGreaterThan(0);

    // Filter → Reads: writes disappear, PR chip gone.
    await click(buttonByText(container, "Reads"));
    expect(writeRows().length).toBe(0);
    expect(container.querySelector("a.context-usage-feed-pr")).toBeNull();

    await act(async () => root.unmount());
  });

  it("renders unavailable states with redacted repo details", async () => {
    const { ContextPage } = await import("../context.js");
    const unavailable = snapshot({
      repo: "https://token@example.com/acme/context-tree.git",
      branch: "main",
      snapshotStatus: "unavailable",
      contextStatus: { label: "Sync failed", detail: "Permission denied", severity: "error" },
    });

    const { container, root } = await renderDom(<ContextPage previewSnapshot={unavailable} />);
    expect(container.textContent).toContain("Context Tree sync unavailable");
    expect(container.textContent).toContain("Permission denied");
    expect(container.textContent).toContain("Repo: https://[redacted]@example.com/acme/context-tree.git");
    expect(container.textContent).toContain("Branch: main");
    await act(async () => root.unmount());

    const disconnected = await renderDom(
      <ContextPage
        previewSnapshot={snapshot({
          repo: null,
          branch: null,
          snapshotStatus: "unavailable",
          contextStatus: { label: "Not configured", detail: null, severity: "warning" },
        })}
      />,
    );
    expect(disconnected.container.textContent).toContain("Connect Context Tree");
    expect(disconnected.container.textContent).toContain("Ask an admin to set up your team's Context Tree.");
    expect(buttonByText(disconnected.container, "Create private GitHub repo")).toBeNull();
    await act(async () => disconnected.root.unmount());
  });

  it("shows an admin the add-repo-to-App recovery CTA when a bound tree repo is unreadable", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    githubAppMocks.getGithubAppInstallation.mockResolvedValue({
      installationId: 7,
      accountLogin: "acme",
      accountType: "Organization",
      manageUrl: "https://github.com/organizations/acme/settings/installations/7",
      suspended: false,
      permissions: {},
      events: [],
    });
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(
      snapshot({
        repo: "https://github.com/acme/context-tree",
        branch: "main",
        snapshotStatus: "unavailable",
        // Server probed and confirmed the App can't read the repo.
        recoveryAction: "manage_github_app_installation",
        contextStatus: { label: "Sync failed", detail: "Permission denied", severity: "error" },
      }),
    );

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "Add repo to the GitHub App");
    const cta = [...container.querySelectorAll("a")].find((anchor) =>
      anchor.textContent?.includes("Add repo to the GitHub App"),
    );
    expect(cta?.getAttribute("href")).toBe("https://github.com/organizations/acme/settings/installations/7");
    expect(cta?.getAttribute("target")).toBe("_blank");
    // Security: external target must not leak the opener.
    expect(cta?.getAttribute("rel")).toBe("noreferrer");
    expect(container.textContent).toContain("First Tree can't read this repo yet.");
    await act(async () => root.unmount());
  });

  it("keeps the generic copy and shows no CTA for a non-coverage unavailable cause", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    const { ContextPage } = await import("../context.js");
    // Unavailable but NOT a GitHub App coverage gap (e.g. bad branch / transient
    // clone): the server leaves recoveryAction unset, so the admin sees the
    // generic sync copy and no misdirecting "Add repo" CTA, and the admin-only
    // installation endpoint is never fetched.
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(
      snapshot({
        repo: "https://github.com/acme/context-tree",
        branch: "main",
        snapshotStatus: "unavailable",
        recoveryAction: null,
        contextStatus: { label: "Sync failed", detail: "Invalid branch", severity: "error" },
      }),
    );

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "First Tree cannot read the team Context Tree yet.");
    expect(
      [...container.querySelectorAll("a")].some((anchor) => anchor.textContent?.includes("Add repo to the GitHub App")),
    ).toBe(false);
    expect(container.textContent).not.toContain("Ask an admin to add it to the GitHub App");
    expect(githubAppMocks.getGithubAppInstallation).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("shows an admin the problem without a dead button when the manage URL never resolves", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    // Coverage gap confirmed by the server, but the manage-URL fetch resolves to
    // null (e.g. the installation row raced away): the button must not render,
    // and the copy must not dangle an "add it" instruction with nothing to click.
    githubAppMocks.getGithubAppInstallation.mockResolvedValue(null);
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(
      snapshot({
        repo: "https://github.com/acme/context-tree",
        branch: "main",
        snapshotStatus: "unavailable",
        recoveryAction: "manage_github_app_installation",
        contextStatus: { label: "Sync failed", detail: "Permission denied", severity: "error" },
      }),
    );

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "First Tree can't read this repo yet.");
    expect(
      [...container.querySelectorAll("a")].some((anchor) => anchor.textContent?.includes("Add repo to the GitHub App")),
    ).toBe(false);
    await act(async () => root.unmount());
  });

  it("directs a member to ask an admin (no CTA, no admin-only fetch) when the App can't read the repo", async () => {
    authMock.value = { organizationId: "org-1", role: "member" };
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(
      snapshot({
        repo: "https://github.com/acme/context-tree",
        branch: "main",
        snapshotStatus: "unavailable",
        recoveryAction: "manage_github_app_installation",
        contextStatus: { label: "Sync failed", detail: "Permission denied", severity: "error" },
      }),
    );

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "Ask an admin to add it to the GitHub App.");
    expect(
      [...container.querySelectorAll("a")].some((anchor) => anchor.textContent?.includes("Add repo to the GitHub App")),
    ).toBe(false);
    // The manage-URL endpoint is admin-only; a member must never trigger it.
    expect(githubAppMocks.getGithubAppInstallation).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  const treeAgent = {
    uuid: "agent-1",
    name: "agent-1",
    displayName: "Tree Agent",
    type: "agent",
    organizationId: "org-1",
    inboxId: "inbox-agent-1",
    visibility: "private",
    runtimeProvider: "claude-code",
    clientId: "client-agent-1",
    status: "active",
    avatarImageUrl: null,
  };
  const secondTreeAgent = {
    ...treeAgent,
    uuid: "agent-2",
    name: "backup-agent",
    displayName: "",
    inboxId: "inbox-agent-2",
    clientId: "client-agent-2",
  };
  const grantedRepo = {
    fullName: "acme/acme-web",
    cloneUrl: "https://github.com/acme/acme-web.git",
    htmlUrl: "https://github.com/acme/acme-web",
    private: true,
    defaultBranch: "main",
    pushedAt: null,
  };
  const grantedApiRepo = {
    fullName: "acme/api",
    cloneUrl: "https://github.com/acme/api.git",
    htmlUrl: "https://github.com/acme/api",
    private: false,
    defaultBranch: "main",
    pushedAt: null,
  };
  const recommendedRepoResource = {
    id: "repo-1",
    type: "repo",
    defaultEnabled: "recommended",
    payload: { url: "https://github.com/acme/acme-web.git" },
  };
  const unavailableSnapshot = () =>
    snapshot({
      repo: null,
      branch: null,
      snapshotStatus: "unavailable",
      contextStatus: { label: "Not configured", detail: null, severity: "warning" },
    });

  it("links to Settings → GitHub for a no-repo admin instead of installing inline or bouncing to Resources", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    agentApiMocks.listManagedAgents.mockResolvedValue([treeAgent]);
    resourceApiMocks.listTeamResourcesForOrg.mockResolvedValue([]);
    githubAppMocks.getGithubAppInstallation.mockResolvedValue(null); // GitHub not connected yet
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(unavailableSnapshot());

    const { container, root } = await renderDom(<ContextPage />);
    // No GitHub connection → a link to the single connect place (Settings → GitHub),
    // NOT an inline install and NOT a bounce to /settings/resources.
    await waitForText(container, "Connect GitHub in Settings");
    expect(container.textContent).not.toContain("Install First Tree on GitHub");
    expect(container.textContent).not.toContain("Create private GitHub repo");
    expect(contextApiMocks.initializeContextTree).not.toHaveBeenCalled();

    // The CTA is a link carrying the `from=context` return marker so Settings can
    // hand the user back to building once connected — no inline install machinery.
    expect(container.querySelector('a[href="/settings/github?from=context"]')).not.toBeNull();
    expect(githubAppMocks.getGithubAppInstallUrl).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("lists the granted repos inline for a connected no-repo admin (no settings bounce)", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    agentApiMocks.listManagedAgents.mockResolvedValue([treeAgent]);
    resourceApiMocks.listTeamResourcesForOrg.mockResolvedValue([]);
    githubAppMocks.getGithubAppInstallation.mockResolvedValue({
      installationId: 7,
      accountLogin: "acme",
      accountType: "Organization",
      manageUrl: "https://github.com/organizations/acme/settings/installations/7",
      suspended: false,
      permissions: {},
      events: [],
    });
    githubMocks.listOrgGithubRepos.mockResolvedValue([
      {
        fullName: "acme/acme-web",
        cloneUrl: "https://github.com/acme/acme-web.git",
        htmlUrl: "https://github.com/acme/acme-web",
        private: true,
        defaultBranch: "main",
        pushedAt: null,
      },
    ]);
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(unavailableSnapshot());

    const { container, root } = await renderDom(<ContextPage />);
    // Connected → the repos the App grants are listed inline for the user to pick.
    await waitForText(container, "Repos your agent can use");
    await waitForText(container, "acme-web");
    // The build CTA only appears after a repo is picked, and the user is never
    // routed away to a settings page to wire up a repo.
    expect(buttonByText(container, "Build your Context Tree")).toBeNull();
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/");

    // Picking a repo reveals the build CTA (inline pick → build wiring) without
    // navigating anywhere — the actual kickoff mechanics are covered by the
    // bound-tree recovery test below, which shares handleBuild.
    await click(container.querySelector('input[type="checkbox"]'));
    await waitForText(container, "Build your Context Tree");
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/");
    await click(buttonByText(container, "Clear all"));
    await waitForCondition(
      () => buttonByText(container, "Build your Context Tree") === null,
      "Expected clearing selected repos to hide the build CTA",
    );

    await act(async () => root.unmount());
  });

  it("starts the tree setup chat for selected repos and the chosen builder agent", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    agentApiMocks.listManagedAgents.mockResolvedValue([treeAgent, secondTreeAgent]);
    resourceApiMocks.listTeamResourcesForOrg.mockResolvedValueOnce([]).mockResolvedValueOnce([recommendedRepoResource]);
    githubAppMocks.getGithubAppInstallation.mockResolvedValue({
      installationId: 7,
      accountLogin: "acme",
      accountType: "Organization",
      manageUrl: "https://github.com/organizations/acme/settings/installations/7",
      suspended: false,
      permissions: {},
      events: [],
    });
    githubMocks.listOrgGithubRepos.mockResolvedValue([grantedRepo]);
    onboardingEventMocks.postTreeSetupStartChat.mockResolvedValue({ chatId: "chat-tree-success" });
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(unavailableSnapshot());

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "acme-web");
    await click(container.querySelector('input[type="checkbox"]'));
    await waitForText(container, "Which agent builds the tree?");
    expect(container.textContent).toContain("backup-agent");

    await click(container.querySelector('button[aria-label="Agent that builds the Context Tree"]'));
    await click(
      [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Tree Agent") ?? null,
    );
    await click(buttonByText(container, "Build your Context Tree"));

    await waitForCondition(
      () => onboardingEventMocks.postTreeSetupStartChat.mock.calls.length > 0,
      "Expected tree setup chat kickoff",
    );
    expect(resourceApiMocks.createTeamResourceForOrg).toHaveBeenCalledWith("org-1", {
      type: "repo",
      name: "acme/acme-web",
      defaultEnabled: "recommended",
      payload: { url: "https://github.com/acme/acme-web.git" },
    });
    expect(onboardingEventMocks.postTreeSetupStartChat).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        agentUuid: "agent-1",
        topic: "Set up shared context",
        complete: true,
      }),
    );
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/?c=chat-tree-success");

    await act(async () => root.unmount());
  });

  it("re-checks the current GitHub App grant before registering an inline-picked repo", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    agentApiMocks.listManagedAgents.mockResolvedValue([treeAgent]);
    resourceApiMocks.listTeamResourcesForOrg.mockResolvedValue([]);
    githubAppMocks.getGithubAppInstallation.mockResolvedValue({
      installationId: 7,
      accountLogin: "acme",
      accountType: "Organization",
      manageUrl: "https://github.com/organizations/acme/settings/installations/7",
      suspended: false,
      permissions: {},
      events: [],
    });
    githubMocks.listOrgGithubRepos
      .mockResolvedValueOnce([
        {
          fullName: "acme/acme-web",
          cloneUrl: "https://github.com/acme/acme-web.git",
          htmlUrl: "https://github.com/acme/acme-web",
          private: true,
          defaultBranch: "main",
          pushedAt: null,
        },
      ])
      .mockResolvedValueOnce([]);
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(unavailableSnapshot());

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "acme-web");
    await click(container.querySelector('input[type="checkbox"]'));
    await waitForText(container, "Build your Context Tree");
    await click(buttonByText(container, "Build your Context Tree"));

    await waitForText(container, "The selected source repo is no longer available to First Tree");
    expect(githubMocks.listOrgGithubRepos).toHaveBeenCalledWith("org-1");
    expect(githubMocks.listOrgGithubRepos.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(resourceApiMocks.createTeamResourceForOrg).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/");

    await act(async () => root.unmount());
  });

  it("keeps still-granted repos selected when only part of the GitHub App grant is revoked", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    agentApiMocks.listManagedAgents.mockResolvedValue([treeAgent]);
    resourceApiMocks.listTeamResourcesForOrg.mockResolvedValue([]);
    githubAppMocks.getGithubAppInstallation.mockResolvedValue({
      installationId: 7,
      accountLogin: "acme",
      accountType: "Organization",
      manageUrl: "https://github.com/organizations/acme/settings/installations/7",
      suspended: false,
      permissions: {},
      events: [],
    });
    githubMocks.listOrgGithubRepos
      .mockResolvedValueOnce([grantedRepo, grantedApiRepo])
      .mockResolvedValueOnce([grantedRepo])
      .mockResolvedValue([grantedRepo]);
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(unavailableSnapshot());

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "acme-web");
    await waitForText(container, "api");
    const repoInputs = [...container.querySelectorAll('input[type="checkbox"]')];
    await click(repoInputs[0] ?? null);
    await click(repoInputs[1] ?? null);
    await waitForText(container, "2 selected");
    await click(buttonByText(container, "Build your Context Tree"));

    await waitForText(container, "Some selected source repos are no longer available to First Tree");
    expect(container.textContent).toContain("1 selected");
    expect(resourceApiMocks.createTeamResourceForOrg).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("surfaces GitHub grant check failures before writing repo resources", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    agentApiMocks.listManagedAgents.mockResolvedValue([treeAgent]);
    resourceApiMocks.listTeamResourcesForOrg.mockResolvedValue([]);
    githubAppMocks.getGithubAppInstallation.mockResolvedValue({
      installationId: 7,
      accountLogin: "acme",
      accountType: "Organization",
      manageUrl: "https://github.com/organizations/acme/settings/installations/7",
      suspended: false,
      permissions: {},
      events: [],
    });
    githubMocks.listOrgGithubRepos.mockResolvedValueOnce([grantedRepo]).mockRejectedValueOnce(new Error("GitHub down"));
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(unavailableSnapshot());

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "acme-web");
    await click(container.querySelector('input[type="checkbox"]'));
    await waitForText(container, "Build your Context Tree");
    await click(buttonByText(container, "Build your Context Tree"));

    await waitForText(container, "Couldn't check your repositories with GitHub just now");
    expect(resourceApiMocks.createTeamResourceForOrg).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("retries repo loading after a connected GitHub App query fails", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    agentApiMocks.listManagedAgents.mockResolvedValue([treeAgent]);
    resourceApiMocks.listTeamResourcesForOrg.mockResolvedValue([]);
    githubAppMocks.getGithubAppInstallation.mockResolvedValue({
      installationId: 7,
      accountLogin: "acme",
      accountType: "Organization",
      manageUrl: "https://github.com/organizations/acme/settings/installations/7",
      suspended: false,
      permissions: {},
      events: [],
    });
    githubMocks.listOrgGithubRepos.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([grantedRepo]);
    const { ContextTreeBuildEntry } = await import("../context-tree-build-entry.js");

    const { container, root } = await renderDom(<ContextTreeBuildEntry />);
    await waitForText(container, "Couldn't load your team's repos");
    await click(buttonByText(container, "Try again"));
    await waitForText(container, "acme-web");

    await act(async () => root.unmount());
  });

  it("resets the build button and shows an error when tree setup chat kickoff fails", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    agentApiMocks.listManagedAgents.mockResolvedValue([treeAgent]);
    resourceApiMocks.listTeamResourcesForOrg.mockResolvedValue([]);
    onboardingEventMocks.postTreeSetupStartChat.mockRejectedValueOnce(new Error("tree setup unavailable"));
    const { ContextTreeBuildEntry } = await import("../context-tree-build-entry.js");

    const { container, root } = await renderDom(
      <ContextTreeBuildEntry treeBindingPlan="useBoundTree" detectedTreeUrl="https://github.com/acme/context-tree" />,
    );
    await waitForText(container, "Build your Context Tree");
    await click(buttonByText(container, "Build your Context Tree"));
    await waitForText(container, "tree setup unavailable");
    expect(buttonByText(container, "Build your Context Tree")?.hasAttribute("disabled")).toBe(false);

    await act(async () => root.unmount());
  });

  it("routes a no-tree admin without an active agent into onboarding before tree build", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    agentApiMocks.listManagedAgents.mockResolvedValue([]);
    resourceApiMocks.listTeamResourcesForOrg.mockResolvedValue([
      { id: "repo-1", type: "repo", defaultEnabled: "recommended", payload: { url: "https://github.com/acme/web" } },
    ]);
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(
      snapshot({
        repo: null,
        branch: null,
        snapshotStatus: "unavailable",
        contextStatus: { label: "Not configured", detail: null, severity: "warning" },
      }),
    );

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "Create an agent for your team first");
    await click(buttonByText(container, "Create an agent"));
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/onboarding");

    await act(async () => root.unmount());
  });

  it("does not show setup recovery on a live tree even when setup kickoff was never sent", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    onboardingEventMocks.getTreeSetupStatus.mockResolvedValueOnce({
      needsTreeSetup: true,
      hasTreeBinding: true,
      hasTreeSetupStartChat: false,
    });
    agentApiMocks.listManagedAgents.mockResolvedValue([
      {
        uuid: "agent-1",
        name: "agent-1",
        displayName: "Tree Agent",
        type: "agent",
        organizationId: "org-1",
        inboxId: "inbox-agent-1",
        visibility: "private",
        runtimeProvider: "claude-code",
        clientId: "client-agent-1",
        status: "active",
        avatarImageUrl: null,
      },
    ]);
    resourceApiMocks.listTeamResourcesForOrg.mockResolvedValue([]);
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(
      snapshot({
        repo: "https://github.com/acme/context-tree",
        branch: "main",
        snapshotStatus: "active",
        contextStatus: { label: "Live", detail: null, severity: "ok" },
      }),
    );

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "LIVE");
    expect(container.textContent).not.toContain("Finish Context Tree setup");
    expect(container.textContent).not.toContain("Build your Context Tree");

    await act(async () => root.unmount());
  });

  it("does not show setup recovery on a bootstrap-only live tree", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    onboardingEventMocks.getTreeSetupStatus.mockResolvedValueOnce({
      needsTreeSetup: true,
      hasTreeBinding: true,
      hasTreeSetupStartChat: false,
    });
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(
      snapshot({
        repo: "https://github.com/acme/context-tree",
        branch: "main",
        snapshotStatus: "active",
        contextStatus: { label: "Live", detail: null, severity: "ok" },
        nodes: [
          {
            id: "root",
            parentId: null,
            path: "",
            sourcePath: "NODE.md",
            title: "Context Tree",
            kind: "root",
            owners: [],
            preview: null,
            relatedNodeIds: [],
            affectedContextArea: "root",
            changeType: null,
            changedAtCommit: null,
          },
        ],
        edges: [],
      }),
    );

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "LIVE");
    expect(container.textContent).not.toContain("Finish Context Tree setup");
    expect(container.textContent).not.toContain("Build your Context Tree");

    await act(async () => root.unmount());
  });

  it("loads and errors through the live query path", async () => {
    const { ContextPage } = await import("../context.js");
    let resolveSnapshot: (value: ContextTreeSnapshot) => void = () => undefined;
    contextApiMocks.getContextTreeSnapshot.mockReturnValue(
      new Promise<ContextTreeSnapshot>((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const loading = await renderDom(<ContextPage />);
    expect(loading.container.textContent).toContain("Loading team context...");
    expect(contextApiMocks.getContextTreeSnapshot).toHaveBeenCalledWith("org-1", "7d");
    await act(async () => {
      resolveSnapshot(snapshot());
    });
    await waitForText(loading.container, "LIVE");
    await act(async () => loading.root.unmount());

    contextApiMocks.getContextTreeSnapshot.mockRejectedValueOnce(new Error("Snapshot unavailable"));
    const failed = await renderDom(<ContextPage />);
    await waitForText(failed.container, "Snapshot unavailable");
    await act(async () => failed.root.unmount());

    authMock.value = { organizationId: null, role: null };
    const noOrg = await renderDom(<ContextPage />);
    // No org → query disabled, no snapshot. The page renders only its
    // PageHeader chrome (always present, like every other tab) — no live
    // chip, no IO feed, and no navigation occurs.
    expect(noOrg.container.querySelector('[data-testid="location"]')?.textContent).toBe("/");
    expect(noOrg.container.textContent).not.toContain("LIVE");
    // Assert the IO feed section element is absent (robust to its label text)
    // rather than matching a sublabel string that the data model may rename.
    expect(noOrg.container.querySelector(".context-usage-feed")).toBeNull();
    expect(contextApiMocks.getContextTreeSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => noOrg.root.unmount());
  });
});
