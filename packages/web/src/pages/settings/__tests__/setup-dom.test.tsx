// @vitest-environment happy-dom

import type { TeamSetupCapabilities } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSetupRows, SettingsSetupPage, type SetupFacts, SetupOverview } from "../setup.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({ listClients: vi.fn() }));
const contextTreeMocks = vi.hoisted(() => ({ getContextTreeSnapshot: vi.fn() }));
const onboardingEventMocks = vi.hoisted(() => ({ reportOnboardingEvent: vi.fn() }));
const resourceMocks = vi.hoisted(() => ({ listTeamResourcesForOrg: vi.fn() }));
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
vi.mock("../../../api/onboarding-events.js", () => onboardingEventMocks);
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
    contextTreeSnapshot: { state: "ready", value: "active" },
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

beforeEach(() => {
  vi.clearAllMocks();
  activityMocks.listClients.mockResolvedValue([]);
  resourceMocks.listTeamResourcesForOrg.mockResolvedValue([]);
  setupCapabilityMocks.getTeamSetupCapabilitiesAt.mockResolvedValue(capabilityFixture());
  contextTreeMocks.getContextTreeSnapshot.mockResolvedValue({
    snapshotStatus: "active",
    contextStatus: { severity: "ok", label: "Available", detail: null },
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
      "Repository automation",
      "Context Tree",
      "Automatic review",
    ]);
    expect(view.host.querySelector('[data-setup-row="automatic-review"]')?.getAttribute("data-setup-parent")).toBe(
      "context-tree",
    );
    expect(view.host.querySelector('[data-setup-row="work-access"] .lucide-message-circle')).not.toBeNull();
    const readyMarks = view.host.querySelectorAll("[data-setup-status-kind='ready'] .lucide-circle-check");
    expect(readyMarks).toHaveLength(7);
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
        contextTreeSnapshot: { state: "ready", value: "stale" },
      }),
    );
    const expectation = [
      ["work-access", "ready", "circle-check", "--success"],
      ["computer", "optional", "circle-minus", "--fg-4"],
      ["agent", "attention", "circle-alert", "--state-needs-you"],
      ["repositories", "unknown", "circle-question-mark", "--fg-3"],
      ["repository-automation", "pending", "clock-3", "--state-idle"],
      ["context-tree", "neutral", "circle-alert", "--fg-3"],
      ["automatic-review", "neutral", "circle-alert", "--fg-3"],
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
    expect(rowFor("context-tree", input).action).toBeUndefined();
    expect(rowFor("automatic-review", input).status.label).toBe("Available after Context Tree");

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
    expect(member.status).toMatchObject({ label: "Service unavailable", kind: "neutral" });
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
    ["active", "Available", "ready", "Manage"],
    ["stale", "Available · update delayed", "neutral", "Manage"],
    ["unavailable", "Needs recovery", "attention", "Recover"],
  ] as const)("maps bound Context Tree snapshot %s without equating binding to health", (value, label, kind, action) => {
    const row = rowFor("context-tree", facts({ contextTreeSnapshot: { state: "ready", value } }));

    expect(row.status).toMatchObject({ label, kind });
    expect(row.status.detail).toBe("acme/context-tree · main branch · GitHub");
    expect(row.action?.label).toBe(action);
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
    expect(unbound.action).toEqual({ label: "Set up", to: "/context" });
    expect(unboundMember.status).toMatchObject({ label: "Not set up", kind: "optional" });
    expect(unboundMember.status.detail).toContain("Ask an admin");
    expect(unboundMember.action).toBeUndefined();
    expect(invalidAdmin.status).toMatchObject({ label: "Needs repair", kind: "attention" });
    expect(invalidAdmin.action).toEqual({ label: "Repair", to: "/settings/repositories#context-tree" });
    expect(invalidMember.status).toMatchObject({ label: "Unavailable", kind: "neutral" });
    expect(invalidMember.status.detail).toContain("Ask an admin");
    expect(invalidMember.action).toEqual({ label: "View", to: "/context" });
  });

  it("keeps bound Context Tree recovery read-only and explicit for a member", () => {
    const row = rowFor(
      "context-tree",
      facts({
        role: "member",
        contextTreeSnapshot: { state: "ready", value: "unavailable" },
      }),
    );

    expect(row.status).toMatchObject({ label: "Unavailable", kind: "neutral" });
    expect(row.status.detail).toContain("Ask an admin to recover");
    expect(row.action).toEqual({ label: "View", to: "/context" });
  });

  it("keeps snapshot lookup failure unknown rather than claiming recovery is needed", () => {
    const row = rowFor("context-tree", facts({ contextTreeSnapshot: { state: "error" } }));

    expect(row.status).toMatchObject({ label: "Status unknown", kind: "unknown" });
    expect(row.action).toEqual({ label: "Manage", to: "/settings/repositories#context-tree" });
  });

  it.each([
    [
      "unavailable",
      capabilityFixture({
        binding: { state: "unbound" },
        review: { adoption: "unavailable", health: "not_observed", reviewerAgent: null },
      }),
      "Available after Context Tree",
      "optional",
      undefined,
    ],
    [
      "disabled",
      capabilityFixture({
        review: { adoption: "disabled", health: "not_observed", reviewerAgent: null },
      }),
      "Off",
      "optional",
      "Set up",
    ],
    ["ready", capabilityFixture(), "On", "ready", "Manage"],
    [
      "pending",
      capabilityFixture({
        review: {
          adoption: "enabled",
          health: "pending_verification",
          blockers: [{ code: "provider_probe_failed", resolutionOwner: "operator", actionKind: null }],
        },
      }),
      "Verification pending",
      "pending",
      undefined,
    ],
    [
      "degraded",
      capabilityFixture({
        review: {
          adoption: "enabled",
          health: "degraded",
          blockers: [{ code: "gitlab_processing_failed", resolutionOwner: "admin", actionKind: null }],
        },
      }),
      "Degraded",
      "attention",
      undefined,
    ],
  ] as const)("maps Automatic review %s without making it a Start Chat gate", (_name, capabilities, label, kind, action) => {
    const input = facts({ capabilities: { state: "ready", value: capabilities } });
    const review = rowFor("automatic-review", input);

    expect(review.status).toMatchObject({ label, kind });
    expect(review.action?.label).toBe(action);
    expect(rowFor("work-access", input).status.label).toBe("Can work now");
  });

  it("makes reviewer replacement admin-only while preserving the same Team fact", () => {
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
    const admin = rowFor("automatic-review", facts({ role: "admin", capabilities: { state: "ready", value: shared } }));
    const member = rowFor(
      "automatic-review",
      facts({ role: "member", capabilities: { state: "ready", value: shared } }),
    );

    expect(admin.status).toMatchObject({ label: "Needs attention", kind: "attention" });
    expect(admin.action).toEqual({ label: "Replace reviewer", to: "/settings/repositories#context-tree" });
    expect(member.status).toMatchObject({ label: "Service unavailable", kind: "neutral" });
    expect(member.status.detail).toContain("Ask an admin");
    expect(member.action).toEqual({ label: "View", to: "/settings/repositories#context-tree" });
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

  it("does not request a tree snapshot when the Team projection says it is unbound", async () => {
    setupCapabilityMocks.getTeamSetupCapabilitiesAt.mockResolvedValue(
      capabilityFixture({
        binding: { state: "unbound" },
        review: { adoption: "unavailable", health: "not_observed", reviewerAgent: null },
      }),
    );

    const view = await renderSettingsSetupPage();
    await waitForRowText(view.host, "context-tree", "Not set up");

    expect(contextTreeMocks.getContextTreeSnapshot).not.toHaveBeenCalled();
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
    const review = await waitForRowText(view.host, "automatic-review", "Status unavailable");

    expect(automation.querySelector("a")).toBeNull();
    expect(tree.querySelector("a")).toBeNull();
    expect(review.querySelector("a")).toBeNull();
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
