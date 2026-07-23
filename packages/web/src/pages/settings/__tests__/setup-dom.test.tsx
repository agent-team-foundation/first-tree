// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSetupRows, SettingsSetupPage, type SetupFacts, SetupOverview } from "../setup.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({ listClients: vi.fn() }));
const contextTreeMocks = vi.hoisted(() => ({ getContextTreeSnapshot: vi.fn() }));
const githubMocks = vi.hoisted(() => ({ getGithubAppInstallation: vi.fn() }));
const gitlabMocks = vi.hoisted(() => ({ listGitlabConnectionsAt: vi.fn() }));
const onboardingEventMocks = vi.hoisted(() => ({ reportOnboardingEvent: vi.fn() }));
const orgSettingsMocks = vi.hoisted(() => ({ getContextTreeSetting: vi.fn() }));
const resourceMocks = vi.hoisted(() => ({ listTeamResourcesForOrg: vi.fn() }));
const authMock = vi.hoisted(() => ({
  value: {
    role: "admin",
    organizationId: "org-1",
    teamDisplayName: "Acme",
    currentOrgHasUsableAgent: true,
    currentOrgHasPersonalAgent: true,
    meLoaded: true,
    onboardingStep: "completed" as "connect" | "create_agent" | "completed" | null,
    onboardingDismissedAt: null as string | null,
    onboardingCompletedAt: "2026-07-23T00:00:00.000Z" as string | null,
    restoreOnboarding: vi.fn(async () => undefined),
  },
}));

vi.mock("../../../api/activity.js", () => activityMocks);
vi.mock("../../../api/context-tree.js", () => contextTreeMocks);
vi.mock("../../../api/github-app.js", () => githubMocks);
vi.mock("../../../api/gitlab-connections.js", () => ({
  ...gitlabMocks,
  gitlabConnectionsQueryKey: (organizationId: string | null) => ["gitlab-connections", organizationId],
}));
vi.mock("../../../api/onboarding-events.js", () => onboardingEventMocks);
vi.mock("../../../api/org-settings.js", () => orgSettingsMocks);
vi.mock("../../../api/resources.js", () => resourceMocks);
vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../../hooks/use-viewport.js", () => ({
  useWorkspaceViewport: () => "xl",
}));

function facts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return {
    role: "admin",
    teamName: "Acme",
    hasUsableAgent: true,
    hasPersonalAgent: true,
    onboardingSuppressedAt: "2026-07-23T00:00:00.000Z",
    onboardingCompletedAt: "2026-07-23T00:00:00.000Z",
    workspaceWillEnterOnboarding: false,
    computers: {
      state: "ready",
      value: { connected: 1, saved: 1, connectedHostname: "acme-mac" },
    },
    repositories: { state: "ready", value: 2 },
    contextTree: {
      state: "ready",
      value: {
        bound: true,
        repo: "https://github.com/acme/context-tree.git",
        branch: "main",
        availability: "active",
      },
    },
    github: {
      state: "ready",
      value: { accountLogin: "acme", accountType: "Organization", suspended: false },
    },
    gitlab: {
      state: "ready",
      value: {
        displayName: "Engineering",
        instanceOrigin: "https://gitlab.acme.test",
        endpointSeen: true,
        health: {
          lastValidInboundAt: "2026-07-23T00:00:00.000Z",
          lastProcessingFailureAt: null,
        },
      },
    },
    ...overrides,
  };
}

async function renderSetup(input: SetupFacts) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SetupOverview facts={input} rows={buildSetupRows(input)} />
      </MemoryRouter>,
    );
  });
  return { host, root };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderSettingsSetupPage() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <SettingsSetupPage />
          <LocationProbe />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { host, root };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-location>{location.pathname}</output>;
}

async function waitForRowText(
  host: ParentNode,
  title: string,
  expected: string,
  timeoutMs = 3000,
): Promise<HTMLElement> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = [...host.querySelectorAll<HTMLElement>("section")].find((section) =>
      section.textContent?.includes(title),
    );
    if (row?.textContent?.includes(expected)) return row;
    await flush();
  }
  throw new Error(`Expected ${title} row to include "${expected}"`);
}

beforeEach(() => {
  vi.clearAllMocks();
  activityMocks.listClients.mockResolvedValue([]);
  resourceMocks.listTeamResourcesForOrg.mockResolvedValue([]);
  orgSettingsMocks.getContextTreeSetting.mockResolvedValue({
    repo: null,
    branch: null,
  });
  contextTreeMocks.getContextTreeSnapshot.mockResolvedValue({
    snapshotStatus: "active",
    contextStatus: { severity: "ok", label: "Available", detail: null },
  });
  githubMocks.getGithubAppInstallation.mockResolvedValue(null);
  gitlabMocks.listGitlabConnectionsAt.mockResolvedValue([]);
  authMock.value = {
    role: "admin",
    organizationId: "org-1",
    teamDisplayName: "Acme",
    currentOrgHasUsableAgent: true,
    currentOrgHasPersonalAgent: true,
    meLoaded: true,
    onboardingStep: "completed",
    onboardingDismissedAt: null,
    onboardingCompletedAt: "2026-07-23T00:00:00.000Z",
    restoreOnboarding: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Settings Setup overview", () => {
  it("renders the six approved facts with separate capability and status icons", async () => {
    const view = await renderSetup(facts());
    const titles = [...view.host.querySelectorAll("[data-setup-row] > div:first-child .text-body")].map(
      (node) => node.textContent,
    );

    expect(titles).toEqual([
      "Work access",
      "Your computer",
      "Your agent",
      "Code repositories",
      "Context Tree",
      "GitHub / GitLab",
    ]);
    expect(view.host.textContent).not.toContain("Resources");
    expect(view.host.textContent).not.toContain("Integrations");
    expect(view.host.textContent).not.toContain("Team agents");
    expect(view.host.textContent).not.toContain("%");
    expect(view.host.textContent).not.toContain("Onboarding completed");
    expect(view.host.querySelector("h1")).toBeNull();
    expect(view.host.querySelector("[data-setup-lead]")?.textContent).toBe("See what's ready and what you can set up.");
    expect(view.host.querySelector("[data-setup-context]")?.textContent).toBe("Acme · Admin");
    expect(view.host.textContent).not.toContain("set up for Acme");
    expect(view.host.textContent).not.toContain("Your access and configuration");
    expect(view.host.textContent).not.toContain("finish setup");
    expect(view.host.textContent).not.toContain("complete setup");
    expect(view.host.querySelector('[data-setup-row="work-access"] .lucide-message-circle')).not.toBeNull();
    const readyMarks = view.host.querySelectorAll("[data-setup-status-kind='ready'] .lucide-circle-check");
    expect(readyMarks).toHaveLength(6);
    expect([...readyMarks].every((mark) => mark.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(view.host.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(0);

    await act(async () => view.root.unmount());
  });

  it("uses form and color together for ready, optional, attention, unknown, blocked, and pending facts", async () => {
    const view = await renderSetup(
      facts({
        hasPersonalAgent: false,
        onboardingSuppressedAt: "2026-07-23T00:00:00.000Z",
        onboardingCompletedAt: null,
        computers: {
          state: "ready",
          value: { connected: 0, saved: 0, connectedHostname: null },
        },
        repositories: { state: "error" },
        contextTree: {
          state: "ready",
          value: {
            bound: true,
            repo: "https://github.com/acme/context-tree.git",
            branch: "main",
            availability: "stale",
          },
        },
        github: { state: "ready", value: null },
        gitlab: {
          state: "ready",
          value: {
            displayName: "Engineering",
            instanceOrigin: "https://gitlab.acme.test",
            endpointSeen: false,
            health: {
              lastValidInboundAt: null,
              lastProcessingFailureAt: null,
            },
          },
        },
      }),
    );
    const expectation = [
      ["work-access", "ready", "circle-check", "--success"],
      ["computer", "optional", "circle-minus", "--fg-4"],
      ["agent", "attention", "circle-alert", "--state-needs-you"],
      ["repositories", "unknown", "circle-question-mark", "--fg-3"],
      ["context-tree", "blocked", "circle-alert", "--state-blocked"],
      ["providers", "pending", "clock-3", "--state-idle"],
    ] as const;

    for (const [key, kind, glyph, token] of expectation) {
      const status = view.host.querySelector<HTMLElement>(
        `[data-setup-row="${key}"] [data-setup-status-kind="${kind}"]`,
      );
      expect(status?.querySelector(`.lucide-${glyph}`)).not.toBeNull();
      expect(status?.querySelector("svg")?.getAttribute("style")).toContain(token);
    }
    expect(
      view.host.querySelector('[data-setup-row="providers"] [data-setup-status-kind] svg')?.getAttribute("class"),
    ).not.toContain("animate-spin");

    await act(async () => view.root.unmount());
  });

  it("reserves a reduced-motion-safe spinner for transient loading", async () => {
    const view = await renderSetup(facts({ computers: { state: "loading" } }));
    const status = view.host.querySelector('[data-setup-row="computer"] [data-setup-status-kind="loading"]');
    const icon = status?.querySelector(".lucide-loader-circle");

    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("class")).toContain("motion-safe:animate-spin");

    await act(async () => view.root.unmount());
  });

  it("treats a team agent as work access while personal computer and agent stay optional", async () => {
    const input = facts({
      role: "member",
      hasUsableAgent: true,
      hasPersonalAgent: false,
      computers: {
        state: "ready",
        value: { connected: 0, saved: 0, connectedHostname: null },
      },
      repositories: { state: "ready", value: 0 },
      contextTree: {
        state: "ready",
        value: { bound: false, repo: null, branch: null, availability: "unavailable" },
      },
      github: { state: "ready", value: null },
      gitlab: { state: "ready", value: null },
    });
    const view = await renderSetup(input);

    expect(view.host.textContent).toContain("Can work now");
    expect(view.host.textContent).toContain("A team agent is available");
    expect(view.host.textContent).toContain("Optional while a team agent is available");
    expect(view.host.textContent).not.toContain("Action required");
    const computerRow = [...view.host.querySelectorAll("section")].find((section) =>
      section.textContent?.includes("Your computer"),
    );
    expect(computerRow?.textContent).toContain("Optional while a team agent is available");

    const actionByTitle = new Map(
      [...view.host.querySelectorAll("section")].map((section) => [
        section.querySelector(".text-body")?.textContent,
        section.querySelector("a")?.textContent,
      ]),
    );
    expect(actionByTitle.get("Code repositories")).toBe("View");
    expect(actionByTitle.get("Context Tree")).toBe("View");
    expect(actionByTitle.get("GitHub / GitLab")).toBeUndefined();
    expect(view.host.textContent).not.toContain("Manage");
    expect(view.host.querySelector("button[disabled]")).toBeNull();
    expect(view.host.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(0);

    await act(async () => view.root.unmount());
  });

  it("routes an unsuppressed team-agent member through quick start instead of the workspace gate", async () => {
    authMock.value = {
      ...authMock.value,
      role: "member",
      currentOrgHasUsableAgent: true,
      currentOrgHasPersonalAgent: false,
      onboardingStep: "completed",
      onboardingDismissedAt: null,
      onboardingCompletedAt: null,
    };
    const view = await renderSettingsSetupPage();
    const workAccess = await waitForRowText(view.host, "Work access", "Can work now");

    expect(workAccess.querySelector("a")?.textContent).toBe("Start a chat");
    expect(workAccess.querySelector("a")?.getAttribute("href")).toBe("/onboarding");
    await act(async () => view.root.unmount());
  });

  it("keeps a Resume setup path for suppressed onboarding that is not complete", () => {
    const rows = buildSetupRows(
      facts({
        hasPersonalAgent: false,
        onboardingSuppressedAt: "2026-07-23T00:00:00.000Z",
        onboardingCompletedAt: null,
      }),
    );

    expect(rows.find((row) => row.key === "agent")?.action).toEqual({
      label: "Resume setup",
      to: "/onboarding",
      intent: "resume-onboarding",
    });
    expect(rows.find((row) => row.key === "agent")?.status).toEqual({
      label: "Setup paused",
      detail: "Resume to create your agent",
      kind: "attention",
    });
  });

  it("clears suppression before resuming incomplete setup", async () => {
    let releaseRestore: (() => void) | undefined;
    const restoreOnboarding = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRestore = resolve;
        }),
    );
    authMock.value = {
      ...authMock.value,
      currentOrgHasPersonalAgent: true,
      onboardingDismissedAt: "2026-07-23T00:00:00.000Z",
      onboardingCompletedAt: null,
      restoreOnboarding,
    };
    const view = await renderSettingsSetupPage();
    const resume = [...view.host.querySelectorAll<HTMLAnchorElement>("a")].find(
      (link) => link.textContent === "Resume setup",
    );

    expect(resume).toBeDefined();
    await act(async () => {
      resume?.click();
      await Promise.resolve();
    });

    expect(restoreOnboarding).toHaveBeenCalledOnce();
    expect(onboardingEventMocks.reportOnboardingEvent).not.toHaveBeenCalled();
    expect(view.host.querySelector("[data-location]")?.textContent).toBe("/");

    await act(async () => {
      releaseRestore?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onboardingEventMocks.reportOnboardingEvent).toHaveBeenCalledWith("resumed", { source: "settings" });
    expect(view.host.querySelector("[data-location]")?.textContent).toBe("/onboarding");
    await act(async () => view.root.unmount());
  });

  it("uses actual availability instead of treating a Context Tree binding as healthy", () => {
    const input = facts({
      contextTree: {
        state: "ready",
        value: {
          bound: true,
          repo: "git@github.com:acme/context-tree.git",
          branch: "main",
          availability: "unavailable",
        },
      },
    });
    const row = buildSetupRows(input).find((candidate) => candidate.key === "context-tree");

    expect(row?.status.label).toBe("Bound · unavailable");
    expect(row?.status.kind).toBe("blocked");
    expect(row?.status.detail).toBe("acme/context-tree · main branch");
  });

  it("keeps optional provider gaps neutral and gives only admins a connect action", () => {
    const rows = buildSetupRows(
      facts({
        github: { state: "ready", value: null },
        gitlab: { state: "ready", value: null },
      }),
    );
    const providers = rows.find((row) => row.key === "providers");

    expect(providers?.status).toEqual({ label: "Not connected", detail: "Optional", kind: "optional" });
    expect(providers?.action).toEqual({ label: "Connect", to: "/settings/integrations" });
  });

  it("summarizes one or two real provider connections in a single row", () => {
    const githubOnly = buildSetupRows(facts({ gitlab: { state: "ready", value: null } })).find(
      (row) => row.key === "providers",
    );
    const both = buildSetupRows(facts()).find((row) => row.key === "providers");

    expect(githubOnly?.status.label).toBe("GitHub · acme");
    expect(githubOnly?.action).toEqual({ label: "Manage", to: "/settings/integrations/github" });
    expect(both?.status.label).toBe("GitHub + GitLab");
    expect(both?.status.detail).toBe("acme · Engineering");
  });

  it("keeps unverified GitLab inbound and either combined provider degradation neutral", () => {
    const waitingGitlab = {
      state: "ready" as const,
      value: {
        displayName: "Engineering",
        instanceOrigin: "https://gitlab.acme.test",
        endpointSeen: false,
        health: {
          lastValidInboundAt: null,
          lastProcessingFailureAt: null,
        },
      },
    };
    const gitlabOnly = buildSetupRows(
      facts({
        github: { state: "ready", value: null },
        gitlab: waitingGitlab,
      }),
    ).find((row) => row.key === "providers");
    const combinedGitlabDegraded = buildSetupRows(
      facts({
        github: {
          state: "ready",
          value: { accountLogin: "acme", accountType: "Organization", suspended: false },
        },
        gitlab: waitingGitlab,
      }),
    ).find((row) => row.key === "providers");
    const combinedGithubDegraded = buildSetupRows(
      facts({
        github: {
          state: "ready",
          value: { accountLogin: "acme", accountType: "Organization", suspended: true },
        },
        gitlab: waitingGitlab,
      }),
    ).find((row) => row.key === "providers");
    const githubOnlySuspended = buildSetupRows(
      facts({
        github: {
          state: "ready",
          value: { accountLogin: "acme", accountType: "Organization", suspended: true },
        },
        gitlab: { state: "ready", value: null },
      }),
    ).find((row) => row.key === "providers");

    expect(gitlabOnly?.status).toMatchObject({
      label: "GitLab · Engineering",
      detail: "Waiting for inbound webhook",
      kind: "pending",
    });
    expect(combinedGitlabDegraded?.status).toMatchObject({
      label: "GitHub + GitLab",
      detail: "GitHub connected · GitLab waiting for inbound webhook",
      kind: "pending",
    });
    expect(combinedGithubDegraded?.status).toMatchObject({
      label: "GitHub + GitLab",
      detail: "GitHub suspended · GitLab waiting for inbound webhook",
      kind: "blocked",
    });
    expect(githubOnlySuspended?.status).toMatchObject({
      label: "GitHub · acme",
      detail: "Connection suspended",
      kind: "blocked",
    });
  });

  it("surfaces a current GitLab processing failure before first-inbound readiness", () => {
    const providers = buildSetupRows(
      facts({
        github: { state: "ready", value: null },
        gitlab: {
          state: "ready",
          value: {
            displayName: "Engineering",
            instanceOrigin: "https://gitlab.acme.test",
            endpointSeen: false,
            health: {
              lastValidInboundAt: null,
              lastProcessingFailureAt: "2026-07-23T00:01:00.000Z",
            },
          },
        },
      }),
    ).find((row) => row.key === "providers");

    expect(providers?.status.kind).toBe("blocked");
    expect(providers?.status.detail).toBe("Processing issue");
  });

  it("does not offer Connect until both provider queries prove there is no connection", () => {
    const loading = buildSetupRows(
      facts({
        github: { state: "loading" },
        gitlab: { state: "ready", value: null },
      }),
    ).find((row) => row.key === "providers");
    const failed = buildSetupRows(
      facts({
        github: { state: "error" },
        gitlab: { state: "ready", value: null },
      }),
    ).find((row) => row.key === "providers");

    expect(loading?.status.label).toBe("Checking…");
    expect(loading?.status.kind).toBe("loading");
    expect(loading?.action).toBeUndefined();
    expect(failed?.status).toEqual({
      label: "Status unavailable",
      detail: "We couldn't check this right now.",
      kind: "unknown",
    });
    expect(failed?.action).toBeUndefined();
  });

  it("does not claim a team agent makes the computer optional when work access is personal", () => {
    const computer = buildSetupRows(
      facts({
        hasUsableAgent: true,
        hasPersonalAgent: true,
        computers: {
          state: "ready",
          value: { connected: 0, saved: 0, connectedHostname: null },
        },
      }),
    ).find((row) => row.key === "computer");

    expect(computer?.status.detail).toBe("No computer connected");
  });

  it.each([
    ["active", "Available"],
    ["stale", "Available · update delayed"],
    ["unavailable", "Bound · unavailable"],
  ] as const)("maps a successful Context Tree %s snapshot through the real page", async (snapshotStatus, expected) => {
    orgSettingsMocks.getContextTreeSetting.mockResolvedValue({
      repo: "https://github.com/acme/context-tree",
      branch: "main",
    });
    contextTreeMocks.getContextTreeSnapshot.mockResolvedValue({
      snapshotStatus,
      contextStatus: {
        severity: snapshotStatus === "active" ? "warning" : "error",
        label: "Diagnostic status",
        detail: "Diagnostic detail",
      },
    });

    const view = await renderSettingsSetupPage();
    const row = await waitForRowText(view.host, "Context Tree", expected);
    expect(row.textContent).toContain(expected);
    await act(async () => view.root.unmount());
  });

  it("treats a Context Tree snapshot request failure as unknown status, not tree unavailability", async () => {
    orgSettingsMocks.getContextTreeSetting.mockResolvedValue({
      repo: "https://github.com/acme/context-tree",
      branch: "main",
    });
    contextTreeMocks.getContextTreeSnapshot.mockRejectedValue(new Error("snapshot failed"));

    const view = await renderSettingsSetupPage();
    const row = await waitForRowText(view.host, "Context Tree", "We couldn't check this right now.");
    expect(row.textContent).toContain("Status unavailable");
    expect(row.textContent).not.toContain("Bound · unavailable");
    await act(async () => view.root.unmount());
  });
});
