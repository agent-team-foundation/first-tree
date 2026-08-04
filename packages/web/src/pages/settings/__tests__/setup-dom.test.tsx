// @vitest-environment happy-dom

import type { OrgContextTreeFeaturesOutput, OrgContextTreeOutput, TeamSetupCapabilities } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client.js";
import { SettingsContextTreePage } from "../context-tree.js";
import { buildSetupRows, SettingsSetupPage, type SetupFacts, SetupOverview } from "../setup.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({ generateConnectToken: vi.fn(), listClients: vi.fn() }));
const contextTreeMocks = vi.hoisted(() => ({ getContextTreeSnapshot: vi.fn() }));
const contextEnablementMocks = vi.hoisted(() => ({ getContextEnablementHandoff: vi.fn() }));
const onboardingEventMocks = vi.hoisted(() => ({ reportOnboardingEvent: vi.fn() }));
const orgSettingsMocks = vi.hoisted(() => ({
  getRawContextTreeSetting: vi.fn(),
  putContextTreeSetting: vi.fn(),
}));
const resourceMocks = vi.hoisted(() => ({ listTeamResourcesForOrg: vi.fn() }));
const reviewerMocks = vi.hoisted(() => ({
  getContextReviewerCandidates: vi.fn(),
  putContextReviewerAssignment: vi.fn(),
  putContextReviewerEnablement: vi.fn(),
}));
const setupCapabilityMocks = vi.hoisted(() => ({ getTeamSetupCapabilitiesAt: vi.fn() }));
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
vi.mock("../../../api/context-enablement.js", () => contextEnablementMocks);
vi.mock("../../../api/context-reviewer-settings.js", () => reviewerMocks);
vi.mock("../../../api/onboarding-events.js", () => onboardingEventMocks);
vi.mock("../../../api/org-settings.js", () => orgSettingsMocks);
vi.mock("../../../api/resources.js", () => resourceMocks);
vi.mock("../../../api/setup-capabilities.js", () => ({
  ...setupCapabilityMocks,
  setupCapabilitiesQueryKey: (organizationId: string | null) => ["setup-capabilities", organizationId],
}));
vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../../hooks/use-viewport.js", () => ({
  useWorkspaceViewport: () => "xl",
}));

const observedAt = "2026-07-23T00:00:00.000Z";
type Provider = TeamSetupCapabilities["repositoryAutomation"]["providers"][number];
type Binding = TeamSetupCapabilities["contextTree"]["binding"];
type Review = TeamSetupCapabilities["contextTree"]["automaticReview"];
type Blocker = Review["blockers"][number];

function capabilityFixture(
  overrides: {
    github?: Partial<Provider>;
    gitlab?: Partial<Provider>;
    binding?: Binding;
    contextTreeBlockers?: Blocker[];
    review?: Partial<Review>;
  } = {},
): TeamSetupCapabilities {
  const github: Provider = {
    provider: "github",
    adoption: "enabled",
    health: "ready",
    blockers: [],
    observedAt,
    ...overrides.github,
  };
  const gitlab: Provider = {
    provider: "gitlab",
    adoption: "available",
    health: "not_observed",
    blockers: [],
    observedAt,
    ...overrides.gitlab,
  };
  const review: Review = {
    adoption: "enabled",
    health: "ready",
    reviewerAgent: { uuid: "reviewer-1", displayName: "Context Reviewer" },
    blockers: [],
    observedAt,
    ...overrides.review,
  };

  return {
    organizationId: "org-1",
    repositoryAutomation: { providers: [github, gitlab] },
    contextTree: {
      binding:
        overrides.binding ??
        ({
          state: "bound",
          provider: "github",
          repo: "https://github.com/acme/context-tree.git",
          branch: "main",
        } satisfies Binding),
      blockers: overrides.contextTreeBlockers ?? [],
      automaticReview: review,
    },
  };
}

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
    capabilities: { state: "ready", value: capabilityFixture() },
    contextTreeSnapshot: { state: "ready", value: { snapshotStatus: "active" } },
    ...overrides,
  };
}

function rowFor(key: ReturnType<typeof buildSetupRows>[number]["key"], input: SetupFacts = facts()) {
  const row = buildSetupRows(input).find((candidate) => candidate.key === key);
  if (!row) throw new Error(`Missing Setup row ${key}`);
  return row;
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

async function renderSettingsSetupPage(initialEntry = "/") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const page = () => (
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={queryClient}>
        <LocationProbe />
        <Routes>
          <Route path="/" element={<SettingsSetupPage />} />
          <Route path="/settings/setup" element={<SettingsSetupPage />} />
          <Route path="/settings/context" element={<SettingsContextTreePage />} />
          <Route path="/settings/integrations/github" element={<div>GitHub settings</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
  await act(async () => {
    root.render(page());
  });
  await flush();
  return {
    host,
    root,
    queryClient,
    rerender: async () => {
      await act(async () => {
        root.render(page());
      });
      await flush();
    },
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-location>{`${location.pathname}${location.hash}`}</output>;
}

async function waitForRowText(
  host: ParentNode,
  key: ReturnType<typeof buildSetupRows>[number]["key"],
  expected: string,
  timeoutMs = 3000,
): Promise<HTMLElement> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = host.querySelector<HTMLElement>(`[data-setup-row="${key}"]`);
    if (row?.textContent?.includes(expected)) return row;
    await flush();
  }
  throw new Error(`Expected ${key} row to include "${expected}"`);
}

async function waitForSelector<T extends Element>(host: ParentNode, selector: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const element = host.querySelector<T>(selector);
    if (element) return element;
    await flush();
  }
  throw new Error(`Expected selector "${selector}"`);
}

async function waitForText(host: ParentNode, expected: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (host.textContent?.includes(expected)) return;
    await flush();
  }
  throw new Error(`Expected content to include "${expected}"`);
}

async function openContextTreeControls(view: Awaited<ReturnType<typeof renderSettingsSetupPage>>) {
  const tree = await waitForRowText(view.host, "context-tree", "Available");
  const manage = tree.querySelector<HTMLAnchorElement>('a[href="/settings/context"]');
  await act(async () => manage?.click());
  const page = await waitForSelector<HTMLElement>(view.host, '[data-context-tree-settings="admin"]');
  const controls = await waitForSelector<HTMLElement>(page, '[data-setup-owner-controls="context-tree"]');
  const reviewerControls = await waitForSelector<HTMLElement>(page, '[data-setup-owner-controls="automatic-review"]');
  return { tree, manage, page, controls, reviewerControls };
}

beforeEach(() => {
  vi.clearAllMocks();
  activityMocks.listClients.mockResolvedValue([]);
  activityMocks.generateConnectToken.mockResolvedValue({
    bootstrapCommand: "first-tree-dev login short-lived-code",
    installerUrl: null,
    binName: "first-tree-dev",
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
  resourceMocks.listTeamResourcesForOrg.mockResolvedValue([]);
  orgSettingsMocks.getRawContextTreeSetting.mockResolvedValue({
    repo: "https://github.com/acme/context-tree.git",
    branch: "main",
    provider: "github",
  });
  orgSettingsMocks.putContextTreeSetting.mockResolvedValue({
    repo: "https://github.com/acme/context-tree.git",
    branch: "release",
    provider: "github",
  });
  reviewerMocks.getContextReviewerCandidates.mockResolvedValue({
    items: [
      {
        uuid: "reviewer-1",
        name: "context-reviewer",
        displayName: "Context Reviewer",
        visibility: "organization",
        runtime: { health: "ready", blockers: [] },
      },
    ],
    blockers: [],
  });
  reviewerMocks.putContextReviewerAssignment.mockResolvedValue({
    contextReviewer: {
      enabled: false,
      agentUuid: "reviewer-1",
      reviewerAgent: { uuid: "reviewer-1", name: "context-reviewer", displayName: "Context Reviewer" },
    },
  });
  reviewerMocks.putContextReviewerEnablement.mockResolvedValue({
    contextReviewer: {
      enabled: true,
      agentUuid: "reviewer-1",
      reviewerAgent: { uuid: "reviewer-1", name: "context-reviewer", displayName: "Context Reviewer" },
    },
  });
  setupCapabilityMocks.getTeamSetupCapabilitiesAt.mockResolvedValue(capabilityFixture());
  contextTreeMocks.getContextTreeSnapshot.mockResolvedValue({
    snapshotStatus: "active",
    contextStatus: { severity: "ok", label: "Available", detail: null },
  });
  contextEnablementMocks.getContextEnablementHandoff.mockResolvedValue({
    protocolVersion: 1,
    organizationId: "org-1",
    teamDisplayName: "Acme",
    role: "admin",
    provider: "claude-code",
    intent: "settings",
    command: "first-tree-dev --json context enable --provider claude-code --team org-1 --plan",
    workingDirectoryInstruction: "Run this from the target repository.",
  });
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
  it("renders the permanent capability hierarchy without a completion score", async () => {
    const view = await renderSetup(facts());
    const titles = [...view.host.querySelectorAll("[data-setup-row] .text-body")].map((node) => node.textContent);

    expect(titles).toEqual([
      "Work access",
      "Your computer",
      "Your agent",
      "Code repositories",
      "GitHub & GitLab",
      "Context Tree",
    ]);
    expect(view.host.querySelector('[data-setup-row="repository-automation"]')?.textContent).toContain(
      "Repository events, identity, and GitHub task routing.",
    );
    expect(view.host.querySelector('[data-setup-row="automatic-review"]')).toBeNull();
    expect(view.host.querySelector('[data-setup-row="work-access"] .lucide-message-circle')).not.toBeNull();
    const readyMarks = view.host.querySelectorAll("[data-setup-status-kind='ready'] .lucide-circle-check");
    expect(readyMarks).toHaveLength(6);
    expect([...readyMarks].every((mark) => mark.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(view.host.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(0);
    expect(view.host.textContent).not.toContain("%");
    expect(view.host.textContent).not.toContain("Onboarding completed");
    expect(view.host.querySelector("h1")).toBeNull();
    expect(view.host.querySelector("[data-setup-lead]")?.textContent).toBe("See what's ready and what you can set up.");
    expect(view.host.querySelector("[data-setup-context]")?.textContent).toBe("Acme · Admin");

    await act(async () => view.root.unmount());
  });

  it("uses form and color together for mixed capability states", async () => {
    const mixed = capabilityFixture({
      gitlab: {
        adoption: "configuring",
        health: "pending_verification",
        blockers: [],
      },
      review: {
        adoption: "enabled",
        health: "degraded",
        blockers: [{ code: "provider_probe_failed", resolutionOwner: "operator", actionKind: null }],
      },
    });
    const view = await renderSetup(
      facts({
        hasPersonalAgent: false,
        onboardingSuppressedAt: "2026-07-23T00:00:00.000Z",
        onboardingCompletedAt: null,
        computers: { state: "ready", value: { connected: 0, saved: 0, connectedHostname: null } },
        repositories: { state: "error" },
        capabilities: { state: "ready", value: mixed },
        contextTreeSnapshot: { state: "ready", value: { snapshotStatus: "stale" } },
      }),
    );
    const expectation = [
      ["work-access", "ready", "circle-check", "--success"],
      ["computer", "optional", "circle-minus", "--fg-4"],
      ["agent", "attention", "circle-alert", "--state-needs-you"],
      ["repositories", "unknown", "circle-question-mark", "--fg-3"],
      ["repository-automation", "pending", "clock-3", "--state-idle"],
      ["context-tree", "neutral", "circle-alert", "--fg-3"],
    ] as const;

    for (const [key, kind, glyph, token] of expectation) {
      const status = view.host.querySelector<HTMLElement>(
        `[data-setup-row="${key}"] [data-setup-status-kind="${kind}"]`,
      );
      expect(status?.querySelector(`.lucide-${glyph}`)).not.toBeNull();
      expect(status?.querySelector("svg")?.getAttribute("style")).toContain(token);
    }

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

  it("keeps Start Chat value-first when a member can use a team agent", async () => {
    const input = facts({
      role: "member",
      hasUsableAgent: true,
      hasPersonalAgent: false,
      computers: {
        state: "ready",
        value: { connected: 0, saved: 0, connectedHostname: null },
      },
      repositories: { state: "ready", value: 0 },
      capabilities: {
        state: "ready",
        value: capabilityFixture({
          binding: { state: "unbound" },
          review: {
            adoption: "unavailable",
            health: "not_observed",
            reviewerAgent: null,
          },
        }),
      },
      contextTreeSnapshot: { state: "ready", value: null },
    });
    const view = await renderSetup(input);

    expect(rowFor("work-access", input).status).toMatchObject({
      label: "Can work now",
      detail: "A team agent is available",
    });
    expect(rowFor("work-access", input).action).toEqual({ label: "Start a chat", to: "/" });
    expect(rowFor("computer", input).status.detail).toBe("Optional while a team agent is available");
    expect(rowFor("agent", input).status.detail).toBe("Optional while a team agent is available");
    expect(view.host.textContent).not.toContain("Action required");
    expect(view.host.textContent).not.toContain("Manage");
    expect(rowFor("context-tree", input).action).toEqual({ label: "View", to: "/settings/context" });
    expect(view.host.querySelector('[data-setup-row="automatic-review"]')).toBeNull();

    await act(async () => view.root.unmount());
  });

  it("keeps optional unconfigured providers neutral and actionable only for admins", () => {
    const optional = capabilityFixture({
      github: { adoption: "available", health: "not_observed" },
      gitlab: { adoption: "available", health: "not_observed" },
    });
    const admin = rowFor("repository-automation", facts({ capabilities: { state: "ready", value: optional } }));
    const member = rowFor(
      "repository-automation",
      facts({ role: "member", capabilities: { state: "ready", value: optional } }),
    );

    expect(admin.status).toEqual({ label: "Not configured", detail: "Optional", kind: "optional" });
    expect(admin.action).toEqual({ label: "Set up", to: "/settings/integrations/github" });
    expect(member.status).toEqual(admin.status);
    expect(member.action).toBeUndefined();
  });

  it.each([
    ["GitHub only", capabilityFixture(), "GitHub ready", "ready"],
    [
      "GitLab only",
      capabilityFixture({
        github: { adoption: "available", health: "not_observed" },
        gitlab: { adoption: "enabled", health: "ready" },
      }),
      "GitLab ready",
      "ready",
    ],
    ["both", capabilityFixture({ gitlab: { adoption: "enabled", health: "ready" } }), "GitHub + GitLab ready", "ready"],
    [
      "partial",
      capabilityFixture({
        gitlab: {
          adoption: "configuring",
          health: "pending_verification",
          blockers: [
            {
              code: "gitlab_webhook_not_seen",
              resolutionOwner: "admin",
              actionKind: "configure_gitlab_webhook",
            },
          ],
        },
      }),
      "Partial coverage",
      "attention",
    ],
    [
      "degraded",
      capabilityFixture({
        github: {
          adoption: "enabled",
          health: "degraded",
          blockers: [{ code: "provider_probe_failed", resolutionOwner: "operator", actionKind: null }],
        },
      }),
      "Degraded",
      "neutral",
    ],
  ] as const)("summarizes %s repository automation coverage", (_name, capabilities, label, kind) => {
    const row = rowFor("repository-automation", facts({ capabilities: { state: "ready", value: capabilities } }));

    expect(row.status.label).toBe(label);
    expect(row.status.kind).toBe(kind);
  });

  it("explains GitLab merge-request routing verification from the canonical Team projection", () => {
    const capabilities = capabilityFixture({
      github: { adoption: "available", health: "not_observed" },
      gitlab: {
        adoption: "configuring",
        health: "pending_verification",
        gitlabHookSources: {
          legacyTransportObserved: false,
          system: "transport_received",
          project: "observed",
        },
        blockers: [
          {
            code: "gitlab_merge_request_event_not_seen",
            resolutionOwner: "admin",
            actionKind: "configure_gitlab_webhook",
          },
        ],
      },
    });
    const admin = rowFor(
      "repository-automation",
      facts({ role: "admin", capabilities: { state: "ready", value: capabilities } }),
    );
    const member = rowFor(
      "repository-automation",
      facts({ role: "member", capabilities: { state: "ready", value: capabilities } }),
    );

    expect(admin.status).toMatchObject({ label: "Verification pending", kind: "attention" });
    expect(admin.status.detail).toContain("GitLab Project Hook active");
    expect(admin.status.detail).toContain("GitLab System Hook waiting for an MR event");
    expect(admin.status.detail).toContain("Waiting for a valid Merge Request event from the System Hook.");
    expect(admin.action).toEqual({ label: "Set up GitLab", to: "/settings/integrations/gitlab" });
    expect(member.status).toMatchObject({ label: "Verification pending", kind: "pending" });
    expect(member.status.detail).toContain("Ask an admin");
    expect(member.action).toBeUndefined();
  });

  it("keeps historical GitLab transport neutral until a configured Hook identifies its source", () => {
    const capabilities = capabilityFixture({
      github: { adoption: "available", health: "not_observed" },
      gitlab: {
        adoption: "configuring",
        health: "pending_verification",
        gitlabHookSources: {
          legacyTransportObserved: true,
          system: "unobserved",
          project: "unobserved",
        },
        blockers: [
          {
            code: "gitlab_hook_source_not_identified",
            resolutionOwner: "admin",
            actionKind: "configure_gitlab_webhook",
          },
        ],
      },
    });
    const admin = rowFor(
      "repository-automation",
      facts({ role: "admin", capabilities: { state: "ready", value: capabilities } }),
    );

    expect(admin.status).toMatchObject({ label: "Verification pending", kind: "attention" });
    expect(admin.status.detail).toContain("GitLab webhook received · Hook source not yet identified");
    expect(admin.status.detail).toContain("Trigger an enabled event from the configured Hook.");
    expect(admin.status.detail).not.toContain("System Hook waiting");
  });

  it("routes GitLab processing recovery for both adopted capabilities to the owner surface", () => {
    const capabilities = capabilityFixture({
      github: { adoption: "available", health: "not_observed" },
      gitlab: {
        adoption: "enabled",
        health: "degraded",
        blockers: [
          {
            code: "gitlab_processing_failed",
            resolutionOwner: "admin",
            actionKind: "configure_gitlab_webhook",
          },
        ],
      },
      review: {
        adoption: "enabled",
        health: "degraded",
        blockers: [
          {
            code: "gitlab_processing_failed",
            resolutionOwner: "admin",
            actionKind: "configure_gitlab_webhook",
          },
        ],
      },
    });
    const adminFacts = facts({ role: "admin", capabilities: { state: "ready", value: capabilities } });
    const memberFacts = facts({ role: "member", capabilities: { state: "ready", value: capabilities } });

    expect(rowFor("repository-automation", adminFacts).action).toEqual({
      label: "Set up GitLab",
      to: "/settings/integrations/gitlab",
    });
    expect(rowFor("context-tree", adminFacts).status).toMatchObject({
      label: "Review degraded",
      kind: "attention",
    });
    expect(rowFor("repository-automation", memberFacts).action).toBeUndefined();
    expect(rowFor("context-tree", memberFacts).action).toEqual({
      label: "View",
      to: "/context",
    });
  });

  it("turns the same Team blocker into admin attention and member read-only explanation", () => {
    const shared = capabilityFixture({
      github: {
        adoption: "enabled",
        health: "unavailable",
        blockers: [
          {
            code: "github_app_suspended",
            resolutionOwner: "admin",
            actionKind: "manage_github_installation",
          },
        ],
      },
    });
    const admin = rowFor(
      "repository-automation",
      facts({ role: "admin", capabilities: { state: "ready", value: shared } }),
    );
    const member = rowFor(
      "repository-automation",
      facts({ role: "member", capabilities: { state: "ready", value: shared } }),
    );

    expect(admin.status).toMatchObject({ label: "Needs attention", kind: "attention" });
    expect(admin.action).toEqual({ label: "Manage GitHub", to: "/settings/integrations/github" });
    expect(member.status).toMatchObject({ label: "Service unavailable", kind: "blocked" });
    expect(member.status.detail).toContain("Ask an admin");
    expect(member.action).toBeUndefined();
  });

  it("does not present operator-owned failures as user-actionable debt", () => {
    const shared = capabilityFixture({
      github: {
        adoption: "enabled",
        health: "unavailable",
        blockers: [{ code: "github_app_not_configured", resolutionOwner: "operator", actionKind: null }],
      },
    });
    const row = rowFor("repository-automation", facts({ capabilities: { state: "ready", value: shared } }));

    expect(row.status).toMatchObject({ label: "Service unavailable", kind: "neutral" });
    expect(row.status.detail).toContain("deployment");
    expect(row.action).toBeUndefined();
  });

  it.each([
    ["active", "Available", "ready", "Manage", "acme/context-tree · Review on"],
    ["stale", "Available · update delayed", "pending", "Manage", "acme/context-tree · Review on"],
    ["unavailable", "Needs recovery", "attention", "Recover", "acme/context-tree · main branch · GitHub"],
  ] as const)("maps bound Context Tree snapshot %s without equating binding to health", (value, label, kind, action, detail) => {
    const row = rowFor(
      "context-tree",
      facts({ contextTreeSnapshot: { state: "ready", value: { snapshotStatus: value } } }),
    );

    expect(row.status).toMatchObject({ label, kind });
    expect(row.status.detail).toBe(detail);
    expect(row.action?.label).toBe(action);
  });

  it.each([
    "gitlab_authentication_required",
    "gitlab_origin_not_authorized",
    "gitlab_dns_unavailable",
    "gitlab_address_not_authorized",
    "gitlab_egress_denied",
  ] as const)("keeps non-actionable GitLab preview status out of Setup for %s", (reason) => {
    const capabilities = capabilityFixture({
      binding: {
        state: "bound",
        provider: "gitlab",
        repo: "https://gitlab.example/acme/context-tree.git",
        branch: "main",
      },
    });
    const privateGitlabSnapshot = {
      snapshotStatus: "unavailable",
      provider: "gitlab",
      contentAvailability: {
        status: "unavailable",
        accessMode: "anonymous",
        reason,
      },
    } as const;
    const admin = rowFor(
      "context-tree",
      facts({
        capabilities: { state: "ready", value: capabilities },
        contextTreeSnapshot: { state: "ready", value: privateGitlabSnapshot },
      }),
    );
    const member = rowFor(
      "context-tree",
      facts({
        role: "member",
        capabilities: { state: "ready", value: capabilities },
        contextTreeSnapshot: { state: "ready", value: privateGitlabSnapshot },
      }),
    );

    for (const row of [admin, member]) {
      expect(row.status).toEqual({
        label: "Connected",
        kind: "ready",
        detail: "acme/context-tree · Review on",
      });
    }
    expect(admin.action?.label).toBe("Manage");
    expect(member.action).toEqual({
      label: "View",
      to: "/context",
    });
  });

  it("keeps unbound optional and invalid role-aware", () => {
    const unboundCapabilities = capabilityFixture({
      binding: { state: "unbound" },
      review: { adoption: "unavailable", health: "not_observed", reviewerAgent: null },
    });
    const invalidCapabilities = capabilityFixture({
      binding: { state: "invalid" },
      contextTreeBlockers: [
        {
          code: "context_tree_binding_invalid",
          resolutionOwner: "admin",
          actionKind: "repair_tree_binding",
        },
      ],
      review: { adoption: "unavailable", health: "not_observed", reviewerAgent: null },
    });
    const unbound = rowFor(
      "context-tree",
      facts({
        capabilities: { state: "ready", value: unboundCapabilities },
        contextTreeSnapshot: { state: "ready", value: null },
      }),
    );
    const unboundMember = rowFor(
      "context-tree",
      facts({
        role: "member",
        capabilities: { state: "ready", value: unboundCapabilities },
        contextTreeSnapshot: { state: "ready", value: null },
      }),
    );
    const invalidAdmin = rowFor(
      "context-tree",
      facts({
        capabilities: { state: "ready", value: invalidCapabilities },
        contextTreeSnapshot: { state: "ready", value: null },
      }),
    );
    const invalidMember = rowFor(
      "context-tree",
      facts({
        role: "member",
        capabilities: { state: "ready", value: invalidCapabilities },
        contextTreeSnapshot: { state: "ready", value: null },
      }),
    );

    expect(unbound.status).toEqual({ label: "Not set up", detail: "Optional", kind: "optional" });
    expect(unbound.action).toEqual({
      label: "Set up",
      to: "/settings/context#binding",
    });
    expect(unboundMember.status).toMatchObject({ label: "Not set up", kind: "optional" });
    expect(unboundMember.status.detail).toContain("Ask an admin");
    expect(unboundMember.action).toEqual({ label: "View", to: "/settings/context" });
    expect(invalidAdmin.status).toMatchObject({ label: "Needs repair", kind: "attention" });
    expect(invalidAdmin.action).toEqual({
      label: "Repair",
      to: "/settings/context#binding",
    });
    expect(invalidMember.status).toMatchObject({ label: "Unavailable", kind: "blocked" });
    expect(invalidMember.status.detail).toContain("Ask an admin");
    expect(invalidMember.action).toEqual({ label: "View", to: "/settings/context" });
  });

  it("keeps Team recovery read-only while preserving Member personal Context access", () => {
    const row = rowFor(
      "context-tree",
      facts({
        role: "member",
        contextTreeSnapshot: { state: "ready", value: { snapshotStatus: "unavailable" } },
      }),
    );

    expect(row.status).toMatchObject({ label: "Unavailable", kind: "blocked" });
    expect(row.status.detail).toContain("Ask an admin to recover");
    expect(row.action).toEqual({
      label: "View",
      to: "/context",
    });
  });

  it("keeps snapshot lookup failure unknown rather than claiming recovery is needed", () => {
    const row = rowFor("context-tree", facts({ contextTreeSnapshot: { state: "error" } }));

    expect(row.status).toMatchObject({ label: "Status unknown", kind: "unknown" });
    expect(row.action).toEqual({
      label: "Manage",
      to: "/settings/context",
    });
  });

  it.each([
    ["enabled", capabilityFixture(), "Available", "ready", "acme/context-tree · Review on"],
    [
      "disabled with a retained Reviewer",
      capabilityFixture({
        review: {
          adoption: "disabled",
          health: "not_observed",
          reviewerAgent: { uuid: "reviewer-1", displayName: "Context Reviewer" },
        },
      }),
      "Available",
      "ready",
      "acme/context-tree · Review off",
    ],
    [
      "degraded",
      capabilityFixture({
        review: {
          adoption: "enabled",
          health: "degraded",
          blockers: [
            {
              code: "gitlab_processing_failed",
              resolutionOwner: "admin",
              actionKind: "configure_gitlab_webhook",
            },
          ],
        },
      }),
      "Review degraded",
      "attention",
      "Recent GitLab webhook processing failed. · acme/context-tree · Context Tree available",
    ],
    [
      "pending verification",
      capabilityFixture({
        review: {
          adoption: "enabled",
          health: "pending_verification",
          blockers: [{ code: "provider_probe_failed", resolutionOwner: "operator", actionKind: null }],
        },
      }),
      "Review verification pending",
      "pending",
      "First Tree could not verify provider readiness. · acme/context-tree · Context Tree available",
    ],
    [
      "disabled with an actionless Reviewer diagnostic",
      capabilityFixture({
        review: {
          adoption: "disabled",
          health: "degraded",
          reviewerAgent: { uuid: "reviewer-1", displayName: "Context Reviewer" },
          blockers: [{ code: "provider_probe_failed", resolutionOwner: "operator", actionKind: null }],
        },
      }),
      "Available",
      "ready",
      "Review off · Reviewer degraded · First Tree could not verify provider readiness. · acme/context-tree",
    ],
  ] as const)("summarizes Automatic review %s in the Context Tree row", (_name, capabilities, label, kind, detail) => {
    const input = facts({ capabilities: { state: "ready", value: capabilities } });
    const contextTree = rowFor("context-tree", input);

    expect(contextTree.status).toMatchObject({ label, kind, detail });
    expect(contextTree.action?.label).toBe("Manage");
    expect(rowFor("work-access", input).status.label).toBe("Can work now");
  });

  it("keeps reviewer replacement admin-only while preserving the same Team fact", () => {
    const shared = capabilityFixture({
      review: {
        adoption: "enabled",
        health: "unavailable",
        reviewerAgent: null,
        blockers: [
          {
            code: "context_review_agent_missing",
            resolutionOwner: "admin",
            actionKind: "replace_review_agent",
          },
        ],
      },
    });
    const admin = rowFor("context-tree", facts({ role: "admin", capabilities: { state: "ready", value: shared } }));
    const member = rowFor("context-tree", facts({ role: "member", capabilities: { state: "ready", value: shared } }));

    expect(admin.status).toMatchObject({ label: "Review needs attention", kind: "attention" });
    expect(admin.status.detail).toContain("The configured reviewer is missing.");
    expect(admin.status.detail).toContain("Context Tree available");
    expect(admin.action?.label).toBe("Manage");
    expect(member.status).toMatchObject({ label: "Review service unavailable", kind: "blocked" });
    expect(member.status.detail).toContain("Ask an admin to resolve this: The configured reviewer is missing.");
    expect(member.status.detail).toContain("Context Tree available");
    expect(member.action).toEqual({
      label: "View",
      to: "/context",
    });
  });

  it("uses the Team projection and only asks the snapshot owner endpoint for a bound tree", async () => {
    const view = await renderSettingsSetupPage();
    const automation = await waitForRowText(view.host, "repository-automation", "GitHub ready");
    const tree = await waitForRowText(view.host, "context-tree", "Available");

    expect(automation.textContent).toContain("GitLab not configured");
    expect(tree.textContent).toContain("acme/context-tree");
    expect(setupCapabilityMocks.getTeamSetupCapabilitiesAt).toHaveBeenCalledWith("org-1");
    expect(contextTreeMocks.getContextTreeSnapshot).toHaveBeenCalledWith("org-1", "7d");
    await act(async () => view.root.unmount());
  });

  it("routes an Admin from the Setup summary to Context Tree owner controls", async () => {
    const view = await renderSettingsSetupPage();
    const tree = await waitForRowText(view.host, "context-tree", "Available");
    const manage = tree.querySelector<HTMLAnchorElement>('a[href="/settings/context"]');

    expect(tree.querySelector("[data-setup-owner-controls]")).toBeNull();
    const { controls, reviewerControls } = await openContextTreeControls(view);
    expect(view.host.querySelector("[data-location]")?.textContent).toBe("/settings/context");
    expect(controls.textContent).toContain("acme/context-tree · main branch · GitHub");
    expect(orgSettingsMocks.getRawContextTreeSetting).toHaveBeenCalledWith("org-1");
    await waitForSelector(reviewerControls, '[aria-label="Automatic review Agent"]');
    expect(reviewerControls.textContent).toContain("Context Reviewer");
    expect(reviewerControls.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    expect(reviewerMocks.getContextReviewerCandidates).toHaveBeenCalledWith("org-1");

    expect(manage?.textContent).toBe("Manage");

    await act(async () => view.root.unmount());
  });

  it("nests optional personal coding-agent access under a bound Context Tree without assuming this browser's Computer", async () => {
    resourceMocks.listTeamResourcesForOrg.mockResolvedValue([]);
    contextEnablementMocks.getContextEnablementHandoff.mockImplementation(
      async (_organizationId: string, provider: "claude-code" | "codex") => ({
        organizationId: "org-1",
        teamDisplayName: "Acme",
        role: "admin",
        provider,
        command: `first-tree-dev --json context enable --provider ${provider} --team org-1 --plan`,
        workingDirectoryInstruction: "Run this from the target repository.",
      }),
    );

    const view = await renderSettingsSetupPage();
    expect(view.host.querySelector("#context-access")).toBeNull();
    const { page } = await openContextTreeControls(view);
    const personalAccess = await waitForSelector<HTMLElement>(page, "[data-setup-personal-access]");

    expect(personalAccess.textContent).toContain("Use with Claude Code or Codex");
    expect(personalAccess.textContent).toContain(
      "Open your project in Claude Code or Codex, then copy and paste the setup prompt.",
    );
    expect(personalAccess.textContent).toContain("Copy setup prompt");
    expect(personalAccess.textContent).toContain("Preview prompt");
    expect(personalAccess.textContent).not.toContain("context enable --provider");
    expect(contextEnablementMocks.getContextEnablementHandoff).not.toHaveBeenCalled();

    const preview = [...personalAccess.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Preview prompt",
    );
    await act(async () => preview?.click());
    await flush();

    expect(activityMocks.generateConnectToken).toHaveBeenCalledTimes(1);
    expect(contextEnablementMocks.getContextEnablementHandoff).toHaveBeenCalledWith("org-1", "claude-code");
    expect(contextEnablementMocks.getContextEnablementHandoff).toHaveBeenCalledWith("org-1", "codex");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(document.body.querySelector<HTMLTextAreaElement>("[data-byo-setup-prompt-preview]")?.value).toContain(
      "first-tree-dev login short-lived-code",
    );

    const copy = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Copy prompt",
    );
    await act(async () => copy?.click());
    await flush();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("first-tree-dev login short-lived-code"),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("exact `applyCommand`"));

    await act(async () => view.root.unmount());
  });

  it("lets a Member use personal Context access without loading Admin Tree or Reviewer controls", async () => {
    authMock.value = { ...authMock.value, role: "member" };
    resourceMocks.listTeamResourcesForOrg.mockResolvedValue([]);
    contextEnablementMocks.getContextEnablementHandoff.mockImplementation(
      async (_organizationId: string, provider: "claude-code" | "codex") => ({
        organizationId: "org-1",
        teamDisplayName: "Acme",
        role: "member",
        provider,
        command: `first-tree-dev --json context enable --provider ${provider} --team org-1 --plan`,
        workingDirectoryInstruction: "Run this from the target repository.",
      }),
    );

    const view = await renderSettingsSetupPage("/settings/context");
    const page = await waitForSelector<HTMLElement>(view.host, '[data-context-tree-settings="member"]');
    const personalAccess = await waitForSelector<HTMLElement>(page, "[data-setup-personal-access]");
    expect(personalAccess.textContent).toContain("Use with Claude Code or Codex");
    expect(personalAccess.textContent).toContain("Copy setup prompt");
    expect(personalAccess.textContent).toContain("Preview prompt");
    expect(page.querySelector<HTMLAnchorElement>('a[href="/context"]')?.textContent).toContain("Open Context");
    expect(page.querySelector("[data-setup-owner-controls]")).toBeNull();
    expect(page.querySelector('[role="switch"]')).toBeNull();
    expect(reviewerMocks.getContextReviewerCandidates).not.toHaveBeenCalled();
    expect(orgSettingsMocks.getRawContextTreeSetting).not.toHaveBeenCalled();

    const copy = [...personalAccess.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Copy setup prompt",
    );
    await act(async () => copy?.click());
    await flush();
    expect(contextEnablementMocks.getContextEnablementHandoff).toHaveBeenCalledWith("org-1", "claude-code");
    expect(contextEnablementMocks.getContextEnablementHandoff).toHaveBeenCalledWith("org-1", "codex");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("first-tree-dev login short-lived-code"),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("exact `applyCommand`"));

    await act(async () => view.root.unmount());
  });

  it("does not offer Personal access when the Context Tree binding is incomplete", () => {
    const input = facts({
      repositories: { state: "ready", value: 0 },
      capabilities: {
        state: "ready",
        value: capabilityFixture({
          binding: { state: "unbound" },
        }),
      },
      contextTreeSnapshot: { state: "ready", value: null },
    });

    expect(rowFor("context-tree", input).action).toEqual({
      label: "Set up",
      to: "/settings/context#binding",
    });
    expect(contextEnablementMocks.getContextEnablementHandoff).not.toHaveBeenCalled();
  });

  it("keeps the binding editor open and reflects the saved Server response immediately", async () => {
    const view = await renderSettingsSetupPage();
    const { controls } = await openContextTreeControls(view);
    const edit = [...controls.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Change repository or branch",
    );
    await act(async () => edit?.click());
    const save = await waitForSelector<HTMLButtonElement>(controls, 'button[aria-label="Save"]');
    await act(async () => save.click());
    await flush();

    expect(orgSettingsMocks.putContextTreeSetting).toHaveBeenCalledWith("org-1", {
      provider: null,
      repo: "https://github.com/acme/context-tree.git",
      branch: "main",
    });
    expect(controls.textContent).toContain("release branch");
    expect(controls.textContent).toContain("Saved");
    expect(controls.querySelector('button[aria-label="Save"]')).not.toBeNull();
    await act(async () => view.root.unmount());
  });

  it("drops binding editor state and a late save response when switching to a cached Team", async () => {
    const teamACapabilities = capabilityFixture();
    const teamBCapabilities: TeamSetupCapabilities = {
      ...capabilityFixture({
        binding: {
          state: "bound",
          provider: "gitlab",
          repo: "https://gitlab.com/beta/context-tree.git",
          branch: "stable",
        },
        review: {
          reviewerAgent: { uuid: "reviewer-2", displayName: "Beta Reviewer" },
        },
      }),
      organizationId: "org-2",
    };
    setupCapabilityMocks.getTeamSetupCapabilitiesAt.mockImplementation(async (organizationId: string) =>
      organizationId === "org-2" ? teamBCapabilities : teamACapabilities,
    );
    orgSettingsMocks.getRawContextTreeSetting.mockImplementation(async (organizationId: string) =>
      organizationId === "org-2"
        ? {
            repo: "https://gitlab.com/beta/context-tree.git",
            branch: "stable",
            provider: "gitlab",
          }
        : {
            repo: "https://github.com/acme/context-tree.git",
            branch: "main",
            provider: "github",
          },
    );
    let resolveTeamASave!: (value: OrgContextTreeOutput) => void;
    orgSettingsMocks.putContextTreeSetting.mockImplementationOnce(
      () =>
        new Promise<OrgContextTreeOutput>((resolve) => {
          resolveTeamASave = resolve;
        }),
    );

    const view = await renderSettingsSetupPage("/settings/context");
    const teamAControls = await waitForSelector<HTMLElement>(
      view.host,
      '[data-context-tree-settings="admin"] [data-setup-owner-controls="context-tree"]',
    );
    const edit = [...teamAControls.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Change repository or branch",
    );
    await act(async () => edit?.click());
    const save = await waitForSelector<HTMLButtonElement>(teamAControls, 'button[aria-label="Save"]');
    await act(async () => save.click());
    await flush();
    expect(orgSettingsMocks.putContextTreeSetting).toHaveBeenCalledWith("org-1", {
      provider: null,
      repo: "https://github.com/acme/context-tree.git",
      branch: "main",
    });

    view.queryClient.setQueryData(["setup-capabilities", "org-2"], teamBCapabilities);
    authMock.value = {
      ...authMock.value,
      organizationId: "org-2",
      teamDisplayName: "Beta",
    };
    await view.rerender();

    const teamBControls = await waitForSelector<HTMLElement>(
      view.host,
      '[data-context-tree-settings="admin"] [data-setup-owner-controls="context-tree"]',
    );
    expect(teamBControls.textContent).toContain("beta/context-tree · stable branch · GitLab");
    expect(teamBControls.textContent).not.toContain("acme/context-tree");
    expect(teamBControls.querySelector('input[placeholder*="github.com"]')).toBeNull();

    await act(async () => {
      resolveTeamASave({
        repo: "https://github.com/acme/context-tree.git",
        branch: "release",
        provider: "github",
      });
    });
    await flush();

    expect(teamBControls.textContent).toContain("beta/context-tree · stable branch · GitLab");
    expect(teamBControls.textContent).not.toContain("release branch");
    await act(async () => view.root.unmount());
  });

  it("keeps a cached Team's Reviewer projection when the previous Team mutation settles late", async () => {
    const teamACapabilities = capabilityFixture();
    const teamBCapabilities: TeamSetupCapabilities = {
      ...capabilityFixture({
        review: {
          adoption: "enabled",
          health: "ready",
          reviewerAgent: { uuid: "reviewer-2", displayName: "Beta Reviewer" },
        },
      }),
      organizationId: "org-2",
    };
    setupCapabilityMocks.getTeamSetupCapabilitiesAt.mockImplementation(async (organizationId: string) =>
      organizationId === "org-2" ? teamBCapabilities : teamACapabilities,
    );
    reviewerMocks.getContextReviewerCandidates.mockImplementation(async (organizationId: string) => ({
      items: [
        {
          uuid: organizationId === "org-2" ? "reviewer-2" : "reviewer-1",
          name: organizationId === "org-2" ? "beta-reviewer" : "context-reviewer",
          displayName: organizationId === "org-2" ? "Beta Reviewer" : "Context Reviewer",
          visibility: "organization",
          runtime: { health: "ready", blockers: [] },
        },
      ],
      blockers: [],
    }));
    let resolveTeamAEnablement!: (value: OrgContextTreeFeaturesOutput) => void;
    reviewerMocks.putContextReviewerEnablement.mockImplementationOnce(
      () =>
        new Promise<OrgContextTreeFeaturesOutput>((resolve) => {
          resolveTeamAEnablement = resolve;
        }),
    );

    const view = await renderSettingsSetupPage("/settings/context");
    const teamAReviewer = await waitForSelector<HTMLElement>(
      view.host,
      '[data-context-tree-settings="admin"] [data-setup-owner-controls="automatic-review"]',
    );
    const teamASwitch = teamAReviewer.querySelector<HTMLButtonElement>('[role="switch"]');
    await act(async () => teamASwitch?.click());
    await flush();
    expect(reviewerMocks.putContextReviewerEnablement).toHaveBeenCalledWith("org-1", false);

    view.queryClient.setQueryData(["setup-capabilities", "org-2"], teamBCapabilities);
    authMock.value = {
      ...authMock.value,
      organizationId: "org-2",
      teamDisplayName: "Beta",
    };
    await view.rerender();

    const teamBReviewer = await waitForSelector<HTMLElement>(
      view.host,
      '[data-context-tree-settings="admin"] [data-setup-owner-controls="automatic-review"]',
    );
    await waitForText(teamBReviewer, "Beta Reviewer");
    expect(teamBReviewer.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      resolveTeamAEnablement({
        contextReviewer: {
          enabled: false,
          agentUuid: "reviewer-1",
          reviewerAgent: {
            uuid: "reviewer-1",
            name: "context-reviewer",
            displayName: "Context Reviewer",
            managerHumanAgentId: "human-admin",
            managerActiveAdmin: true,
          },
        },
      });
    });
    await flush();

    expect(teamBReviewer.textContent).toContain("Beta Reviewer");
    expect(teamBReviewer.textContent).not.toContain("Context Reviewer");
    expect(teamBReviewer.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    await act(async () => view.root.unmount());
  });

  it.each([
    [
      "GitHub to GitLab",
      "github",
      "https://github.com/acme/context-tree.git",
      "https://gitlab.com/acme/context-tree.git",
      "gitlab",
    ],
    [
      "GitLab to GitHub",
      "gitlab",
      "https://gitlab.com/acme/context-tree.git",
      "https://github.com/acme/context-tree.git",
      "github",
    ],
  ] as const)("clears the stale provider declaration when rebinding %s", async (_name, previousProvider, previousRepo, nextRepo, nextProvider) => {
    orgSettingsMocks.getRawContextTreeSetting.mockResolvedValue({
      repo: previousRepo,
      branch: "main",
      provider: previousProvider,
    });
    orgSettingsMocks.putContextTreeSetting.mockResolvedValue({
      repo: nextRepo,
      branch: "main",
      provider: nextProvider,
    });
    setupCapabilityMocks.getTeamSetupCapabilitiesAt.mockResolvedValue(
      capabilityFixture({
        binding: {
          state: "bound",
          provider: previousProvider,
          repo: previousRepo,
          branch: "main",
        },
      }),
    );

    const view = await renderSettingsSetupPage();
    const { controls } = await openContextTreeControls(view);
    const edit = [...controls.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Change repository or branch",
    );
    await act(async () => edit?.click());
    const repoInput = await waitForSelector<HTMLInputElement>(controls, 'input[placeholder*="github.com"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(repoInput, nextRepo);
      repoInput.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextRepo, inputType: "insertText" }));
      repoInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    const save = await waitForSelector<HTMLButtonElement>(controls, 'button[aria-label="Save"]');
    await act(async () => save.click());
    await flush();

    expect(orgSettingsMocks.putContextTreeSetting).toHaveBeenCalledWith("org-1", {
      provider: null,
      repo: nextRepo,
      branch: "main",
    });
    expect(controls.textContent).toContain(`main branch · ${nextProvider === "github" ? "GitHub" : "GitLab"}`);
    expect(controls.textContent).toContain("Saved");
    await act(async () => view.root.unmount());
  });

  it.each([
    ["#context-tree", "/settings/context#binding", "binding"],
    ["#automatic-review", "/settings/context#automatic-review", "automatic-review"],
  ] as const)("redirects legacy hash %s to and focuses %s", async (hash, destination, targetId) => {
    const view = await renderSettingsSetupPage(`/settings/setup${hash}`);
    await waitForText(view.host, destination);
    const target = await waitForSelector<HTMLElement>(view.host, `#${targetId}`);
    await waitForSelector(view.host, '[data-context-tree-settings="admin"]');

    expect(view.host.querySelector("[data-location]")?.textContent).toBe(destination);
    expect(document.activeElement).toBe(target);
    await act(async () => view.root.unmount());
  });

  it("redirects the retired Team Agent hash to GitHub task routing", async () => {
    const view = await renderSettingsSetupPage("/settings/setup#team-agent");
    await waitForText(view.host, "/settings/integrations/github#task-routing");

    expect(view.host.querySelector("[data-location]")?.textContent).toBe("/settings/integrations/github#task-routing");
    await act(async () => view.root.unmount());
  });

  it("keeps Member Setup read-only without loading owner-only settings", async () => {
    authMock.value = { ...authMock.value, role: "member" };
    const view = await renderSettingsSetupPage("/settings/setup#automatic-review");
    await waitForText(view.host, "/settings/context#automatic-review");
    const page = await waitForSelector<HTMLElement>(view.host, '[data-context-tree-settings="member"]');

    expect(view.host.querySelector("[data-location]")?.textContent).toBe("/settings/context#automatic-review");
    expect(page.textContent).toContain("Context Reviewer");
    expect(page.querySelector("[data-setup-owner-controls]")).toBeNull();
    expect(page.querySelector('[role="switch"]')).toBeNull();
    expect(reviewerMocks.getContextReviewerCandidates).not.toHaveBeenCalled();
    expect(orgSettingsMocks.getRawContextTreeSetting).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });

  it("keeps provider recovery secondary to the initial degraded Reviewer editor", async () => {
    setupCapabilityMocks.getTeamSetupCapabilitiesAt.mockResolvedValue(
      capabilityFixture({
        review: {
          adoption: "disabled",
          health: "degraded",
          blockers: [
            {
              code: "context_review_agent_runtime_unavailable",
              resolutionOwner: "admin",
              actionKind: "open_agent_owner_flow",
            },
          ],
        },
      }),
    );
    const view = await renderSettingsSetupPage();
    const { reviewerControls } = await openContextTreeControls(view);
    expect(reviewerControls.querySelector('[role="switch"]')).not.toBeNull();
    expect([...reviewerControls.querySelectorAll("a")].some((link) => link.textContent === "Manage Team Agents")).toBe(
      true,
    );
    expect(reviewerControls.textContent).toContain("The configured reviewer's runtime is currently unavailable.");
    await act(async () => view.root.unmount());
  });

  it("enables Automatic Review without rewriting its retained assignment", async () => {
    setupCapabilityMocks.getTeamSetupCapabilitiesAt.mockResolvedValue(
      capabilityFixture({
        review: {
          adoption: "disabled",
          health: "not_observed",
          reviewerAgent: { uuid: "reviewer-1", displayName: "Context Reviewer" },
        },
      }),
    );
    const view = await renderSettingsSetupPage();
    const { reviewerControls } = await openContextTreeControls(view);
    const enablement = reviewerControls.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(enablement?.getAttribute("aria-checked")).toBe("false");
    await waitForSelector(reviewerControls, '[aria-label="Automatic review Agent"]');
    expect(reviewerControls.textContent).toContain("Reviewer selection retained while Automatic review is off.");

    await act(async () => enablement?.click());
    await flush();

    expect(reviewerMocks.putContextReviewerEnablement).toHaveBeenCalledWith("org-1", true);
    expect(reviewerMocks.putContextReviewerAssignment).not.toHaveBeenCalled();
    expect(reviewerControls.textContent).toContain(
      "Reviews eligible Context Tree pull requests and merge requests as webhook events arrive.",
    );
    expect(reviewerControls.querySelector('[role="alert"]')).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("preserves precise mutation details for state changes and unknown blocker codes", async () => {
    setupCapabilityMocks.getTeamSetupCapabilitiesAt.mockResolvedValue(
      capabilityFixture({
        review: {
          adoption: "disabled",
          health: "ready",
          reviewerAgent: { uuid: "reviewer-1", displayName: "Context Reviewer" },
        },
      }),
    );
    reviewerMocks.putContextReviewerEnablement
      .mockRejectedValueOnce(
        new ApiError(
          409,
          "Reviewer ownership or Computer binding changed; retry with current Team state",
          undefined,
          "context_review_state_changed",
        ),
      )
      .mockRejectedValueOnce(new ApiError(409, "Precise future blocker detail", undefined, "future_blocker_code"));
    const view = await renderSettingsSetupPage();
    const { reviewerControls } = await openContextTreeControls(view);
    const enablement = reviewerControls.querySelector<HTMLButtonElement>('[role="switch"]');

    await act(async () => enablement?.click());
    await waitForSelector(reviewerControls, '[role="alert"]');
    expect(reviewerControls.textContent).toContain(
      "Reviewer ownership or Computer binding changed; retry with current Team state",
    );

    await act(async () => enablement?.click());
    await flush();
    expect(reviewerControls.textContent).toContain("Precise future blocker detail");
    expect(reviewerControls.textContent).not.toContain("Provider or Agent recovery is still required");
    await act(async () => view.root.unmount());
  });

  it("changes assignment through its split endpoint and keeps an offline candidate selectable", async () => {
    setupCapabilityMocks.getTeamSetupCapabilitiesAt
      .mockResolvedValueOnce(capabilityFixture())
      .mockResolvedValueOnce(capabilityFixture())
      .mockResolvedValue(
        capabilityFixture({
          review: {
            adoption: "disabled",
            health: "degraded",
            reviewerAgent: { uuid: "reviewer-2", displayName: "Offline Reviewer" },
          },
        }),
      );
    reviewerMocks.getContextReviewerCandidates.mockResolvedValue({
      items: [
        {
          uuid: "reviewer-1",
          name: "context-reviewer",
          displayName: "Context Reviewer",
          visibility: "organization",
          runtime: { health: "ready", blockers: [] },
        },
        {
          uuid: "reviewer-2",
          name: "offline-reviewer",
          displayName: "Offline Reviewer",
          visibility: "organization",
          runtime: {
            health: "degraded",
            blockers: [{ code: "context_review_agent_inactive", resolutionOwner: "operator", actionKind: null }],
          },
        },
      ],
      blockers: [],
    });
    reviewerMocks.putContextReviewerAssignment.mockResolvedValue({
      contextReviewer: {
        enabled: false,
        agentUuid: "reviewer-2",
        reviewerAgent: { uuid: "reviewer-2", name: "offline-reviewer", displayName: "Offline Reviewer" },
      },
    });
    const view = await renderSettingsSetupPage();
    const { reviewerControls } = await openContextTreeControls(view);
    const agentSelect = await waitForSelector<HTMLButtonElement>(
      reviewerControls,
      '[aria-label="Automatic review Agent"]',
    );
    await act(async () => agentSelect?.click());
    await waitForSelector(document.body, '[role="listbox"][aria-label="Automatic review Agent"]');
    const offlineOption = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) =>
      option.textContent?.includes("Offline Reviewer"),
    );

    expect(offlineOption?.disabled).toBe(false);
    expect(offlineOption?.textContent).toContain("Runtime currently unavailable");
    await act(async () => offlineOption?.click());
    await flush();

    expect(reviewerMocks.putContextReviewerAssignment).toHaveBeenCalledWith("org-1", "reviewer-2");
    expect(reviewerMocks.putContextReviewerEnablement).not.toHaveBeenCalled();
    expect(reviewerControls.textContent).toContain("Offline Reviewer");
    expect(reviewerControls.textContent).toContain("Reviewer selection retained while Automatic review is off.");
    expect(reviewerControls.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    await act(async () => view.root.unmount());
  });

  it("keeps an empty eligible-candidate result in Setup without a create escape hatch", async () => {
    reviewerMocks.getContextReviewerCandidates.mockResolvedValue({ items: [], blockers: [] });
    setupCapabilityMocks.getTeamSetupCapabilitiesAt.mockResolvedValue(
      capabilityFixture({
        review: {
          adoption: "disabled",
          health: "not_observed",
          reviewerAgent: null,
        },
      }),
    );
    const view = await renderSettingsSetupPage();
    const { reviewerControls } = await openContextTreeControls(view);
    await waitForSelector<HTMLAnchorElement>(reviewerControls, 'a[href="/team"]');

    expect(reviewerControls.querySelector('[aria-label="Automatic review Agent"]')).toBeNull();
    expect(reviewerControls.querySelector<HTMLAnchorElement>('a[href="/team"]')?.textContent).toBe(
      "Manage Team Agents",
    );
    expect(reviewerControls.textContent).toContain("No eligible organization-visible managed Agent");
    expect(reviewerControls.textContent).not.toContain("Create Agent");
    await act(async () => view.root.unmount());
  });

  it("keeps the projected Reviewer visible when eligible candidates fail to load", async () => {
    reviewerMocks.getContextReviewerCandidates.mockRejectedValue(new Error("candidate lookup failed"));
    const view = await renderSettingsSetupPage();
    const { reviewerControls } = await openContextTreeControls(view);
    await waitForSelector(reviewerControls, '[role="alert"]');

    expect(reviewerControls.textContent).toContain("Reviewer · Context Reviewer");
    expect(reviewerControls.textContent).toContain("candidate lookup failed");
    expect(reviewerControls.querySelector('[aria-label="Automatic review Agent"]')).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("allows an Admin to clear the retained Reviewer assignment", async () => {
    reviewerMocks.putContextReviewerAssignment.mockResolvedValue({
      contextReviewer: { enabled: false, agentUuid: null, reviewerAgent: null },
    });
    const view = await renderSettingsSetupPage();
    const { reviewerControls } = await openContextTreeControls(view);
    const agentSelect = await waitForSelector<HTMLButtonElement>(
      reviewerControls,
      '[aria-label="Automatic review Agent"]',
    );
    await act(async () => agentSelect.click());
    const clearOption = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (option) => option.textContent === "No Reviewer selected",
    );
    await act(async () => clearOption?.click());
    await flush();

    expect(reviewerMocks.putContextReviewerAssignment).toHaveBeenCalledWith("org-1", null);
    expect(reviewerControls.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    await act(async () => view.root.unmount());
  });

  it("offers binding repair without a misleading build-chat entry for an invalid Context Tree", async () => {
    setupCapabilityMocks.getTeamSetupCapabilitiesAt.mockResolvedValue(
      capabilityFixture({
        binding: { state: "invalid" },
        contextTreeBlockers: [
          {
            code: "context_tree_binding_invalid",
            resolutionOwner: "admin",
            actionKind: "repair_tree_binding",
          },
        ],
        review: { adoption: "unavailable", health: "not_observed", reviewerAgent: null },
      }),
    );
    const view = await renderSettingsSetupPage();
    const tree = await waitForRowText(view.host, "context-tree", "Needs repair");
    const repair = tree.querySelector<HTMLAnchorElement>('a[href="/settings/context#binding"]');

    await act(async () => repair?.click());
    const controls = await waitForSelector<HTMLElement>(
      view.host,
      '[data-context-tree-settings="admin"] [data-setup-owner-controls="context-tree"]',
    );
    expect(controls.textContent).toContain("Bind it manually");
    expect(controls.textContent).not.toContain("Build your Context Tree");
    await act(async () => view.root.unmount());
  });

  it.each([
    ["active", "Available"],
    ["stale", "Available · update delayed"],
    ["unavailable", "Needs recovery"],
  ] as const)("maps a successful Context Tree %s snapshot through the real page", async (snapshotStatus, expected) => {
    contextTreeMocks.getContextTreeSnapshot.mockResolvedValue({
      snapshotStatus,
      contextStatus: {
        severity: snapshotStatus === "active" ? "ok" : "warning",
        label: "Diagnostic status",
        detail: "Diagnostic detail",
      },
    });

    const view = await renderSettingsSetupPage();
    const row = await waitForRowText(view.host, "context-tree", expected);
    expect(row.textContent).toContain(expected);
    await act(async () => view.root.unmount());
  });

  it("suppresses non-actionable GitLab recovery chat while keeping independent review controls", async () => {
    setupCapabilityMocks.getTeamSetupCapabilitiesAt.mockResolvedValue(
      capabilityFixture({
        binding: {
          state: "bound",
          provider: "gitlab",
          repo: "https://gitlab.example/acme/context-tree.git",
          branch: "main",
        },
      }),
    );
    contextTreeMocks.getContextTreeSnapshot.mockResolvedValue({
      snapshotStatus: "unavailable",
      provider: "gitlab",
      contentAvailability: {
        status: "unavailable",
        accessMode: "anonymous",
        reason: "gitlab_origin_not_authorized",
      },
      contextStatus: {
        severity: "error",
        label: "Team context unavailable",
        detail: "GitLab deployment allowlist diagnostic",
      },
    });

    const view = await renderSettingsSetupPage();
    const row = await waitForRowText(view.host, "context-tree", "Connected");

    expect(row.textContent).not.toContain("Needs recovery");
    expect(row.textContent).not.toContain("Web Context unavailable");
    expect(row.textContent).not.toContain("GitLab deployment allowlist diagnostic");
    const manage = row.querySelector<HTMLAnchorElement>('a[href="/settings/context"]');
    await act(async () => manage?.click());
    const page = await waitForSelector<HTMLElement>(view.host, '[data-context-tree-settings="admin"]');
    const controls = await waitForSelector<HTMLElement>(page, '[data-setup-owner-controls="context-tree"]');
    const reviewerControls = await waitForSelector<HTMLElement>(page, '[data-setup-owner-controls="automatic-review"]');
    expect(controls.textContent).not.toContain("Open Context");
    expect(reviewerControls.textContent).toContain("Enable automatic review");
    expect(controls.textContent).not.toContain("Work on this in chat");
    await act(async () => view.root.unmount());
  });

  it("treats a snapshot request failure as unknown, not unavailable", async () => {
    contextTreeMocks.getContextTreeSnapshot.mockRejectedValue(new Error("snapshot failed"));

    const view = await renderSettingsSetupPage();
    const row = await waitForRowText(view.host, "context-tree", "Status unknown");
    expect(row.textContent).not.toContain("Needs recovery");
    await act(async () => view.root.unmount());
  });

  it("fails closed when the capability projection cannot be loaded", async () => {
    setupCapabilityMocks.getTeamSetupCapabilitiesAt.mockRejectedValue(new Error("projection failed"));

    const view = await renderSettingsSetupPage();
    const automation = await waitForRowText(view.host, "repository-automation", "Status unavailable");
    const tree = await waitForRowText(view.host, "context-tree", "Status unavailable");

    expect(automation.querySelector("a")).toBeNull();
    expect(tree.querySelector("a")).toBeNull();
    expect(view.host.querySelector('[data-setup-row="automatic-review"]')).toBeNull();
    expect(contextTreeMocks.getContextTreeSnapshot).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });

  it("routes an unsuppressed team-agent member through quick start", async () => {
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
    const workAccess = await waitForRowText(view.host, "work-access", "Can work now");

    expect(workAccess.querySelector("a")?.textContent).toBe("Start a chat");
    expect(workAccess.querySelector("a")?.getAttribute("href")).toBe("/onboarding");
    await act(async () => view.root.unmount());
  });

  it("clears onboarding suppression before resuming incomplete setup", async () => {
    let releaseRestore: (() => void) | undefined;
    const restoreOnboarding = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRestore = resolve;
        }),
    );
    authMock.value = {
      ...authMock.value,
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
});
