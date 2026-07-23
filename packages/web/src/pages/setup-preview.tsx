import type { TeamSetupCapabilities } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { setupCapabilitiesQueryKey } from "../api/setup-capabilities.js";
import { AuthContext } from "../auth/auth-context.js";
import { cn } from "../lib/utils.js";
import { buildSetupRows, type SetupFacts, SetupOverview } from "./settings/setup.js";
import { SettingsLayout } from "./settings.js";

type PreviewRole = "admin" | "member";
type PreviewState = "ready" | "mixed";

const READY_CAPABILITIES: TeamSetupCapabilities = {
  organizationId: "org-preview",
  repositoryAutomation: {
    providers: [
      {
        provider: "github",
        adoption: "enabled",
        health: "ready",
        blockers: [],
        observedAt: "2026-07-23T00:00:00.000Z",
      },
      {
        provider: "gitlab",
        adoption: "available",
        health: "not_observed",
        blockers: [],
        observedAt: "2026-07-23T00:00:00.000Z",
      },
    ],
  },
  contextTree: {
    binding: {
      state: "bound",
      provider: "github",
      repo: "https://github.com/agent-team-foundation/first-tree-context",
      branch: "main",
    },
    blockers: [],
    automaticReview: {
      adoption: "enabled",
      health: "ready",
      reviewerAgent: {
        uuid: "agent-reviewer",
        displayName: "Context Reviewer",
      },
      blockers: [],
      observedAt: "2026-07-23T00:00:00.000Z",
    },
  },
};

const MIXED_CAPABILITIES: TeamSetupCapabilities = {
  ...READY_CAPABILITIES,
  repositoryAutomation: {
    providers: [
      {
        provider: "github",
        adoption: "available",
        health: "not_observed",
        blockers: [],
        observedAt: "2026-07-23T00:00:00.000Z",
      },
      {
        provider: "gitlab",
        adoption: "configuring",
        health: "pending_verification",
        blockers: [
          {
            code: "gitlab_webhook_not_seen",
            resolutionOwner: "admin",
            actionKind: "configure_gitlab_webhook",
          },
        ],
        observedAt: "2026-07-23T00:00:00.000Z",
      },
    ],
  },
  contextTree: {
    ...READY_CAPABILITIES.contextTree,
    automaticReview: {
      ...READY_CAPABILITIES.contextTree.automaticReview,
      health: "degraded",
      blockers: [
        {
          code: "gitlab_processing_failed",
          resolutionOwner: "admin",
          actionKind: null,
        },
      ],
    },
  },
};

const PREVIEW_CONTEXT_SETTING: SetupFacts["contextTreeSetting"] = {
  state: "ready",
  value: {
    provider: "github",
    repo: "https://github.com/agent-team-foundation/first-tree-context",
    branch: "main",
  },
};

function previewFacts(role: PreviewRole, state: PreviewState): SetupFacts {
  if (state === "mixed") {
    return {
      role,
      teamName: "Gandy's team",
      hasUsableAgent: true,
      hasPersonalAgent: false,
      onboardingSuppressedAt: "2026-07-23T00:00:00.000Z",
      onboardingCompletedAt: null,
      workspaceWillEnterOnboarding: false,
      computers: {
        state: "ready",
        value: { connected: 0, saved: 0, connectedHostname: null },
      },
      repositories: { state: "error" },
      capabilities: { state: "ready", value: MIXED_CAPABILITIES },
      contextTreeSetting: PREVIEW_CONTEXT_SETTING,
      contextTreeSnapshot: { state: "ready", value: "active" },
      github: { state: "ready", value: null },
      gitlab: {
        state: "ready",
        value: { displayName: "First Tree", instanceOrigin: "https://gitlab.com" },
      },
    };
  }

  return {
    role,
    teamName: "Gandy's team",
    hasUsableAgent: true,
    hasPersonalAgent: true,
    onboardingSuppressedAt: "2026-07-23T00:00:00.000Z",
    onboardingCompletedAt: "2026-07-23T00:00:00.000Z",
    workspaceWillEnterOnboarding: false,
    computers: {
      state: "ready",
      value: { connected: 1, saved: 1, connectedHostname: "Gandy-MacBook-Pro" },
    },
    repositories: { state: "ready", value: 3 },
    capabilities: { state: "ready", value: READY_CAPABILITIES },
    contextTreeSetting: PREVIEW_CONTEXT_SETTING,
    contextTreeSnapshot: { state: "ready", value: "active" },
    github: {
      state: "ready",
      value: { accountLogin: "agent-team-foundation", accountType: "Organization" },
    },
    gitlab: { state: "ready", value: null },
  };
}

export function SetupPreviewPage() {
  const [searchParams] = useSearchParams();
  const role: PreviewRole = searchParams.get("role") === "member" ? "member" : "admin";
  const state: PreviewState = searchParams.get("state") === "mixed" ? "mixed" : "ready";
  const facts = previewFacts(role, state);
  const capabilities = state === "mixed" ? MIXED_CAPABILITIES : READY_CAPABILITIES;
  const queryClient = useMemo(() => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    client.setQueryData(setupCapabilitiesQueryKey("org-preview"), capabilities);
    return client;
  }, [capabilities]);
  const auth = {
    isAuthenticated: true,
    meLoaded: true,
    role,
    organizationId: "org-preview",
    teamDisplayName: facts.teamName,
    currentOrgHasUsableAgent: facts.hasUsableAgent,
    currentOrgHasPersonalAgent: facts.hasPersonalAgent,
    onboardingDismissedAt: facts.onboardingSuppressedAt,
    onboardingCompletedAt: facts.onboardingCompletedAt,
  } as unknown as Parameters<typeof AuthContext.Provider>[0]["value"];

  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <div style={{ minHeight: "100vh", background: "var(--bg)" }} data-setup-preview={`${role}-${state}`}>
          <SettingsLayout activePathname="/settings/setup">
            <SetupOverview facts={facts} rows={buildSetupRows(facts)} />
          </SettingsLayout>
          <nav
            aria-label="Setup preview controls"
            className="fixed flex"
            style={{
              right: "var(--sp-4)",
              bottom: "var(--sp-4)",
              gap: "var(--sp-1)",
              padding: "var(--sp-1)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-input)",
              background: "var(--bg-raised)",
              boxShadow: "var(--shadow-md)",
            }}
          >
            <PreviewControlGroup
              label="Role"
              options={["admin", "member"]}
              selected={role}
              href={(candidate) => `/preview/setup?role=${candidate}&state=${state}`}
            />
            <PreviewControlGroup
              label="State"
              options={["ready", "mixed"]}
              selected={state}
              href={(candidate) => `/preview/setup?role=${role}&state=${candidate}`}
            />
          </nav>
        </div>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

function PreviewControlGroup<T extends string>({
  label,
  options,
  selected,
  href,
}: {
  label: string;
  options: readonly T[];
  selected: T;
  href: (candidate: T) => string;
}) {
  return (
    <span className="flex" style={{ gap: "var(--sp-1)" }}>
      <span className="sr-only">{label}</span>
      {options.map((candidate) => (
        <Link
          key={candidate}
          to={href(candidate)}
          aria-current={selected === candidate ? "page" : undefined}
          className={cn(
            "text-label font-medium",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
          style={{
            padding: "var(--sp-1_5) var(--sp-3)",
            borderRadius: "var(--radius-input)",
            color: selected === candidate ? "var(--fg)" : "var(--fg-3)",
            background: selected === candidate ? "var(--bg-hover)" : "transparent",
            textDecoration: "none",
            textTransform: "capitalize",
          }}
        >
          {candidate}
        </Link>
      ))}
    </span>
  );
}
