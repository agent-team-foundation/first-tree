import type {
  ContextReviewerCandidatesOutput,
  OrgContextTreeFeaturesOutput,
  OrgContextTreeInput,
  OrgContextTreeOutput,
  TeamSetupCapabilities,
} from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { setupCapabilitiesQueryKey } from "../api/setup-capabilities.js";
import { AuthContext } from "../auth/auth-context.js";
import { cn } from "../lib/utils.js";
import { buildSetupRows, type SetupFacts, SetupOverview } from "./settings/setup.js";
import { SetupContextTreeControls } from "./settings/setup-context-tree-controls.js";
import { SetupReviewerControls } from "./settings/setup-reviewer-controls.js";
import { SettingsLayout } from "./settings.js";

type PreviewRole = "admin" | "member";
type PreviewState = "ready" | "mixed";

const PREVIEW_CAPABILITIES: TeamSetupCapabilities = {
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
  ...PREVIEW_CAPABILITIES,
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
        adoption: "enabled",
        health: "pending_verification",
        blockers: [],
        observedAt: "2026-07-23T00:00:00.000Z",
      },
    ],
  },
  contextTree: {
    ...PREVIEW_CAPABILITIES.contextTree,
    automaticReview: {
      ...PREVIEW_CAPABILITIES.contextTree.automaticReview,
      health: "degraded",
      blockers: [
        {
          code: "context_review_agent_inactive",
          resolutionOwner: "operator",
          actionKind: null,
        },
      ],
    },
  },
};

const PREVIEW_REVIEWER_CANDIDATES: ContextReviewerCandidatesOutput = {
  items: [
    {
      uuid: "agent-reviewer",
      name: "context-reviewer",
      displayName: "Context Reviewer",
      visibility: "organization",
      runtime: { health: "ready", blockers: [] },
    },
    {
      uuid: "agent-offline-reviewer",
      name: "offline-reviewer",
      displayName: "Offline Reviewer",
      visibility: "organization",
      runtime: {
        health: "degraded",
        blockers: [
          {
            code: "context_review_agent_inactive",
            resolutionOwner: "operator",
            actionKind: null,
          },
        ],
      },
    },
  ],
  blockers: [],
};

async function previewLoadTreeSetting(): Promise<OrgContextTreeOutput> {
  return {
    provider: "github",
    repo: "https://github.com/agent-team-foundation/first-tree-context",
    branch: "main",
  };
}

async function previewSaveTreeSetting(
  _organizationId: string,
  input: OrgContextTreeInput,
): Promise<OrgContextTreeOutput> {
  return {
    provider: "github",
    repo: input.repo ?? undefined,
    branch: input.branch ?? undefined,
  };
}

async function previewAssignReviewer(
  _organizationId: string,
  agentUuid: string | null,
): Promise<OrgContextTreeFeaturesOutput> {
  const candidate = PREVIEW_REVIEWER_CANDIDATES.items.find((item) => item.uuid === agentUuid);
  return {
    contextReviewer: {
      enabled: false,
      agentUuid,
      reviewerAgent: candidate
        ? { uuid: candidate.uuid, name: candidate.name, displayName: candidate.displayName }
        : null,
    },
  };
}

async function previewSetReviewerEnabled(
  _organizationId: string,
  enabled: boolean,
): Promise<OrgContextTreeFeaturesOutput> {
  return {
    contextReviewer: {
      enabled,
      agentUuid: "agent-reviewer",
      reviewerAgent: { uuid: "agent-reviewer", name: "context-reviewer", displayName: "Context Reviewer" },
    },
  };
}

async function previewRefresh(): Promise<void> {}

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
      contextTreeSnapshot: { state: "ready", value: "stale" },
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
    capabilities: { state: "ready", value: PREVIEW_CAPABILITIES },
    contextTreeSnapshot: { state: "ready", value: "active" },
  };
}

export function SetupPreviewPage() {
  const [searchParams] = useSearchParams();
  const [expandedOwnerControl, setExpandedOwnerControl] = useState<
    ReturnType<typeof buildSetupRows>[number]["key"] | null
  >(null);
  const role: PreviewRole = searchParams.get("role") === "member" ? "member" : "admin";
  const state: PreviewState = searchParams.get("state") === "mixed" ? "mixed" : "ready";
  const facts = previewFacts(role, state);
  const capabilities = state === "mixed" ? MIXED_CAPABILITIES : PREVIEW_CAPABILITIES;
  const snapshotStatus = state === "mixed" ? ("stale" as const) : ("active" as const);
  const queryClient = useMemo(() => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    client.setQueryData(setupCapabilitiesQueryKey("org-preview"), capabilities);
    client.setQueryData(["context-tree-snapshot", "org-preview", "7d", false], {
      snapshotStatus,
    });
    client.setQueryData(["org-setting", "org-preview", "context_tree", "raw"], {
      provider: "github",
      repo: "https://github.com/agent-team-foundation/first-tree-context",
      branch: "main",
    });
    client.setQueryData(["context-reviewer", "candidates", "org-preview"], PREVIEW_REVIEWER_CANDIDATES);
    return client;
  }, [capabilities, snapshotStatus]);
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
  const ownerControls =
    role !== "admin"
      ? {}
      : {
          ...(expandedOwnerControl === "context-tree"
            ? {
                "context-tree": (
                  <SetupContextTreeControls
                    binding={capabilities.contextTree.binding}
                    availability={snapshotStatus}
                    loadSetting={previewLoadTreeSetting}
                    saveSetting={previewSaveTreeSetting}
                    refreshFacts={previewRefresh}
                  />
                ),
              }
            : {}),
          ...(expandedOwnerControl === "automatic-review"
            ? {
                "automatic-review": (
                  <SetupReviewerControls
                    review={capabilities.contextTree.automaticReview}
                    loadCandidates={async () => PREVIEW_REVIEWER_CANDIDATES}
                    assignReviewer={previewAssignReviewer}
                    setReviewerEnabled={previewSetReviewerEnabled}
                    refreshFacts={previewRefresh}
                  />
                ),
              }
            : {}),
        };

  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <div style={{ minHeight: "100vh", background: "var(--bg)" }} data-setup-preview={`${role}-${state}`}>
          <SettingsLayout activePathname="/settings/setup">
            <SetupOverview
              facts={facts}
              rows={buildSetupRows(facts)}
              ownerControls={ownerControls}
              onToggleOwnerControl={
                role === "admin"
                  ? (key) => setExpandedOwnerControl((current) => (current === key ? null : key))
                  : undefined
              }
            />
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
