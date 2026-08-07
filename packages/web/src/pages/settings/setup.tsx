import type {
  ContextTreeSnapshot,
  SetupActionKind,
  SetupAutomaticReview,
  SetupBlocker,
  SetupCapabilityHealth,
  SetupContextTreeBinding,
  SetupRepositoryAutomationProvider,
  TeamSetupCapabilities,
} from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  Clock3,
  FolderGit2,
  GitFork,
  Laptop,
  LoaderCircle,
  type LucideIcon,
  MessageCircle,
  Webhook,
} from "lucide-react";
import { useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { listClients } from "../../api/activity.js";
import { getContextTreeSnapshot } from "../../api/context-tree.js";
import { reportOnboardingEvent } from "../../api/onboarding-events.js";
import { listTeamResourcesForOrg } from "../../api/resources.js";
import { getTeamSetupCapabilitiesAt, setupCapabilitiesQueryKey } from "../../api/setup-capabilities.js";
import { useAuth } from "../../auth/auth-context.js";
import { useWorkspaceViewport } from "../../hooks/use-viewport.js";
import { cn } from "../../lib/utils.js";
import { isTeamNonActionableGitlabWebContext } from "../context-tree-availability.js";
import { shouldEnterOnboarding } from "../onboarding/steps.js";
import { setupBlockerCopy } from "./setup-blocker-copy.js";

type Fact<T> =
  | { state: "loading" }
  | { state: "error" }
  | {
      state: "ready";
      value: T;
    };

type ContextTreeFact = {
  binding: SetupContextTreeBinding;
  availability: "active" | "stale" | "unavailable" | "checking" | "unknown" | null;
  teamNonActionableGitlabWebContext: boolean;
};

type ContextTreeSnapshotFact = Pick<ContextTreeSnapshot, "snapshotStatus" | "provider" | "contentAvailability">;

export type SetupStatusKind =
  | "ready"
  | "optional"
  | "loading"
  | "pending"
  | "attention"
  | "neutral"
  | "blocked"
  | "unknown";

export type SetupFacts = {
  role: string | null;
  teamName: string | null;
  hasUsableAgent: boolean;
  hasPersonalAgent: boolean;
  onboardingSuppressedAt: string | null;
  onboardingCompletedAt: string | null;
  workspaceWillEnterOnboarding: boolean;
  computers: Fact<{ connected: number; saved: number; connectedHostname: string | null }>;
  repositories: Fact<number>;
  capabilities: Fact<TeamSetupCapabilities>;
  contextTreeSnapshot: Fact<ContextTreeSnapshotFact | null>;
};

export type SetupRowModel = {
  key: "work-access" | "computer" | "agent" | "repositories" | "repository-automation" | "context-tree";
  title: string;
  description: string;
  icon: LucideIcon;
  status: {
    label: string;
    detail?: string;
    kind: SetupStatusKind;
  };
  action?: {
    label: string;
    to: string;
    intent?: "resume-onboarding";
  };
};

function queryFact<T>(query: { data: T | undefined; isPending: boolean; isError: boolean }): Fact<T> {
  if (query.isPending) return { state: "loading" };
  if (query.isError || query.data === undefined) return { state: "error" };
  return { state: "ready", value: query.data };
}

function contextTreeFact(
  capabilities: Fact<TeamSetupCapabilities>,
  snapshot: Fact<ContextTreeSnapshotFact | null>,
): Fact<ContextTreeFact> {
  if (capabilities.state === "loading") return { state: "loading" };
  if (capabilities.state === "error") return { state: "error" };

  const binding = capabilities.value.contextTree.binding;
  if (binding.state !== "bound") {
    return {
      state: "ready",
      value: { binding, availability: null, teamNonActionableGitlabWebContext: false },
    };
  }
  if (snapshot.state === "loading") {
    return {
      state: "ready",
      value: { binding, availability: "checking", teamNonActionableGitlabWebContext: false },
    };
  }
  if (snapshot.state === "error") {
    return {
      state: "ready",
      value: { binding, availability: "unknown", teamNonActionableGitlabWebContext: false },
    };
  }
  return {
    state: "ready",
    value: {
      binding,
      availability: snapshot.value?.snapshotStatus ?? "unknown",
      teamNonActionableGitlabWebContext: isTeamNonActionableGitlabWebContext(snapshot.value),
    },
  };
}

function loadingStatus(): SetupRowModel["status"] {
  return { label: "Checking…", kind: "loading" };
}

function unknownStatus(): SetupRowModel["status"] {
  return { label: "Status unavailable", detail: "We couldn't check this right now.", kind: "unknown" };
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function repositoryLabel(repo: string | null): string | undefined {
  if (!repo) return undefined;
  try {
    const url = new URL(repo);
    const path = url.pathname.replace(/^\/|\.git$/g, "");
    return path || url.hostname;
  } catch {
    return repo.replace(/^git@[^:]+:/, "").replace(/\.git$/, "");
  }
}

const PROVIDER_LABELS = {
  github: "GitHub",
  gitlab: "GitLab",
} as const;

const ACTION_DESTINATIONS = {
  connect_github: "/settings/integrations/github",
  manage_github_installation: "/settings/integrations/github",
  connect_gitlab: "/settings/integrations/gitlab",
  configure_gitlab_webhook: "/settings/integrations/gitlab",
  repair_tree_binding: "/settings/context#binding",
  open_tree_setup_chat: "/settings/context#binding",
  select_review_agent: "/settings/context#automatic-review",
  replace_review_agent: "/settings/context#automatic-review",
  open_agent_owner_flow: "/team",
  manage_review_agent: "/settings/context#automatic-review",
  configure_github_app: "/settings/integrations/github",
  select_team_agent: "/settings/integrations/github#task-routing",
} satisfies Record<SetupActionKind, string>;

const ACTION_LABELS = {
  connect_github: "Connect GitHub",
  manage_github_installation: "Manage GitHub",
  connect_gitlab: "Connect GitLab",
  configure_gitlab_webhook: "Set up GitLab",
  repair_tree_binding: "Repair",
  open_tree_setup_chat: "Open setup chat",
  select_review_agent: "Choose reviewer",
  replace_review_agent: "Replace reviewer",
  open_agent_owner_flow: "Manage agents",
  manage_review_agent: "Manage reviewer",
  configure_github_app: "Configure GitHub App",
  select_team_agent: "Choose GitHub Task Agent",
} satisfies Record<SetupActionKind, string>;

function blockerDetail(blockers: SetupBlocker[], isAdmin: boolean): string | undefined {
  const details = blockers.map((item) =>
    !isAdmin && item.resolutionOwner === "admin"
      ? `Ask an admin to resolve this: ${setupBlockerCopy(item.code)}`
      : setupBlockerCopy(item.code),
  );
  const unique = [...new Set(details)];
  return unique.length > 0 ? unique.join(" · ") : undefined;
}

function firstAdminAction(blockers: SetupBlocker[]): SetupActionKind | null {
  for (const item of blockers) {
    if (item.resolutionOwner === "admin" && item.actionKind) return item.actionKind;
  }
  return null;
}

function actionFromBlockers(blockers: SetupBlocker[], isAdmin: boolean): SetupRowModel["action"] | undefined {
  if (!isAdmin) return undefined;
  const actionKind = firstAdminAction(blockers);
  return actionKind
    ? {
        label: ACTION_LABELS[actionKind],
        to: ACTION_DESTINATIONS[actionKind],
      }
    : undefined;
}

function hasAdminBlocker(blockers: SetupBlocker[]): boolean {
  return blockers.some((item) => item.resolutionOwner === "admin");
}

function providerHealthLabel(provider: SetupRepositoryAutomationProvider): string {
  if (provider.adoption === "available") return "not configured";
  const labels = {
    not_observed: "not observed",
    pending_verification: "verification pending",
    ready: "ready",
    degraded: "degraded",
    unavailable: "unavailable",
  } satisfies Record<SetupCapabilityHealth, string>;
  return labels[provider.health];
}

function providerSummary(providers: SetupRepositoryAutomationProvider[], isAdmin: boolean): SetupRowModel["status"] {
  const configured = providers.filter((provider) => provider.adoption !== "available");
  if (configured.length === 0) {
    return { label: "Not configured", detail: "Optional", kind: "optional" };
  }

  const ready = configured.filter((provider) => provider.health === "ready");
  const providerDetail = providers
    .flatMap((provider) => {
      const details = [`${PROVIDER_LABELS[provider.provider]} ${providerHealthLabel(provider)}`];
      if (!provider.gitlabHookSources) return details;
      if (provider.gitlabHookSources.legacyTransportObserved) {
        details.push("GitLab webhook received · Hook source not yet identified");
      }
      if (provider.gitlabHookSources.project === "observed") {
        details.push("GitLab Project Hook active");
      }
      if (provider.gitlabHookSources.system === "transport_received") {
        details.push("GitLab System Hook waiting for an MR event");
      } else if (provider.gitlabHookSources.system === "routing_verified") {
        details.push("GitLab System Hook MR routing verified");
      } else if (provider.gitlabHookSources.system === "needs_attention") {
        details.push("GitLab System Hook needs attention");
      }
      return details;
    })
    .join(" · ");
  const blockers = configured.flatMap((provider) => provider.blockers);
  const issues = blockerDetail(blockers, isAdmin);
  const detail = [providerDetail, issues].filter((item): item is string => Boolean(item)).join(" · ");
  const hasAdminOwnedBlocker = hasAdminBlocker(blockers);
  const adminAttention = isAdmin && hasAdminOwnedBlocker;
  const inactiveKind: SetupStatusKind = adminAttention ? "attention" : hasAdminOwnedBlocker ? "blocked" : "neutral";

  if (ready.length === configured.length) {
    return {
      label: ready.length === 2 ? "GitHub + GitLab ready" : `${PROVIDER_LABELS[ready[0]?.provider ?? "github"]} ready`,
      detail,
      kind: "ready",
    };
  }
  if (ready.length > 0) return { label: "Partial coverage", detail, kind: adminAttention ? "attention" : "pending" };
  if (configured.some((provider) => provider.health === "pending_verification")) {
    return { label: "Verification pending", detail, kind: adminAttention ? "attention" : "pending" };
  }
  if (configured.some((provider) => provider.health === "degraded")) {
    return { label: "Degraded", detail, kind: inactiveKind };
  }
  return {
    label: hasAdminBlocker(blockers) && isAdmin ? "Needs attention" : "Service unavailable",
    detail,
    kind: inactiveKind,
  };
}

function providerAction(
  providers: SetupRepositoryAutomationProvider[],
  isAdmin: boolean,
): SetupRowModel["action"] | undefined {
  const configured = providers.filter((provider) => provider.adoption !== "available");
  const blockers = configured.flatMap((provider) => provider.blockers);
  const blockerAction = actionFromBlockers(blockers, isAdmin);
  if (blockerAction) return blockerAction;
  if (blockers.length > 0) return undefined;
  if (!isAdmin) {
    const first = configured[0];
    return first
      ? {
          label: "View",
          to: `/settings/integrations/${first.provider}`,
        }
      : undefined;
  }
  const first = configured[0];
  return {
    label: configured.length === 0 ? "Set up" : "Manage",
    to: first ? `/settings/integrations/${first.provider}` : "/settings/integrations/github",
  };
}

function contextTreeStatus(
  contextTree: Fact<ContextTreeFact>,
  blockers: SetupBlocker[],
  isAdmin: boolean,
): SetupRowModel["status"] {
  if (contextTree.state === "loading") return loadingStatus();
  if (contextTree.state === "error") return unknownStatus();

  const { binding, availability, teamNonActionableGitlabWebContext } = contextTree.value;
  if (binding.state === "unbound") {
    return {
      label: "Not set up",
      detail: isAdmin ? "Optional" : "Optional · Ask an admin to set this up if your team needs it.",
      kind: "optional",
    };
  }
  if (binding.state === "invalid") {
    return {
      label: isAdmin ? "Needs repair" : "Unavailable",
      detail:
        blockerDetail(blockers, isAdmin) ??
        (isAdmin ? "The Context Tree binding is invalid." : "Ask an admin to repair the Context Tree binding."),
      kind: isAdmin ? "attention" : "blocked",
    };
  }

  const bindingDetail = [
    repositoryLabel(binding.repo),
    `${binding.branch} branch`,
    PROVIDER_LABELS[binding.provider],
  ].join(" · ");
  const issueDetail = blockerDetail(blockers, isAdmin);
  const detail = [bindingDetail, issueDetail].filter((item): item is string => Boolean(item)).join(" · ");
  if (teamNonActionableGitlabWebContext) {
    return {
      label: "Connected",
      detail: bindingDetail,
      kind: "ready",
    };
  }
  if (availability === "active") return { label: "Available", detail, kind: "ready" };
  if (availability === "stale") return { label: "Available · update delayed", detail, kind: "pending" };
  if (availability === "unavailable") {
    return isAdmin
      ? { label: "Needs recovery", detail, kind: "attention" }
      : {
          label: "Unavailable",
          detail: issueDetail ? detail : `${bindingDetail} · Ask an admin to recover Context Tree access.`,
          kind: "blocked",
        };
  }
  if (availability === "checking") return { label: "Checking availability", detail, kind: "loading" };
  return { label: "Status unknown", detail, kind: "unknown" };
}

function contextTreeAction(contextTree: Fact<ContextTreeFact>, isAdmin: boolean): SetupRowModel["action"] | undefined {
  if (contextTree.state !== "ready") return undefined;
  const { binding, availability, teamNonActionableGitlabWebContext } = contextTree.value;
  if (binding.state === "unbound") {
    return isAdmin ? { label: "Set up", to: "/settings/context#binding" } : { label: "View", to: "/settings/context" };
  }
  if (binding.state === "invalid") {
    return isAdmin ? { label: "Repair", to: "/settings/context#binding" } : { label: "View", to: "/settings/context" };
  }
  if (teamNonActionableGitlabWebContext) {
    return isAdmin ? { label: "Manage", to: "/settings/context" } : { label: "View", to: "/context" };
  }
  if (availability === "unavailable") {
    return isAdmin ? { label: "Recover", to: "/settings/context#binding" } : { label: "View", to: "/context" };
  }
  return isAdmin ? { label: "Manage", to: "/settings/context" } : { label: "View", to: "/context" };
}

function reviewDiagnosticDetail(review: SetupAutomaticReview, isAdmin: boolean): string | undefined {
  const healthDetail =
    review.adoption === "disabled"
      ? review.health === "pending_verification"
        ? "Reviewer verification pending"
        : review.health === "degraded"
          ? "Reviewer degraded"
          : review.health === "unavailable"
            ? "Reviewer unavailable"
            : null
      : null;
  const issues = blockerDetail(review.blockers, isAdmin);
  return [healthDetail, issues].filter((item): item is string => Boolean(item)).join(" · ") || undefined;
}

function reviewStatus(review: SetupAutomaticReview, isAdmin: boolean): SetupRowModel["status"] {
  if (review.adoption === "unavailable") {
    return { label: "Available after Context Tree", kind: "optional" };
  }
  if (review.adoption === "disabled") {
    const reviewer = review.reviewerAgent ? `Reviewer · ${review.reviewerAgent.displayName}` : null;
    const diagnostic = reviewDiagnosticDetail(review, isAdmin);
    const detail = [reviewer, diagnostic, "Optional"].filter((item): item is string => Boolean(item)).join(" · ");
    return { label: "Off", detail, kind: "optional" };
  }

  const reviewer = review.reviewerAgent ? `Reviewer · ${review.reviewerAgent.displayName}` : null;
  const issues = blockerDetail(review.blockers, isAdmin);
  const detail = [reviewer, issues].filter((item): item is string => Boolean(item)).join(" · ") || undefined;
  if (review.health === "ready") return { label: "On", detail, kind: "ready" };
  const hasAdminOwnedBlocker = hasAdminBlocker(review.blockers);
  const adminAttention = isAdmin && hasAdminOwnedBlocker;
  const inactiveKind: SetupStatusKind = adminAttention ? "attention" : hasAdminOwnedBlocker ? "blocked" : "neutral";
  if (review.health === "pending_verification") {
    return { label: "Verification pending", detail, kind: adminAttention ? "attention" : "pending" };
  }
  if (review.health === "degraded") {
    return { label: "Degraded", detail, kind: inactiveKind };
  }
  if (review.health === "unavailable") {
    return {
      label: hasAdminBlocker(review.blockers) && isAdmin ? "Needs attention" : "Service unavailable",
      detail,
      kind: inactiveKind,
    };
  }
  return { label: "Status unknown", detail, kind: "unknown" };
}

function combineContextTreeAndReviewStatus(
  contextStatus: SetupRowModel["status"],
  automaticReviewStatus: SetupRowModel["status"],
  automaticReviewDiagnostic: string | undefined,
): SetupRowModel["status"] {
  if (
    !["ready", "pending"].includes(contextStatus.kind) ||
    automaticReviewStatus.label === "Available after Context Tree"
  ) {
    return contextStatus;
  }

  const repository = contextStatus.detail?.split(" · ")[0];
  const reviewSummary =
    automaticReviewStatus.label === "On"
      ? "Review on"
      : automaticReviewStatus.label === "Off"
        ? "Review off"
        : `Review ${automaticReviewStatus.label.toLowerCase()}`;

  if (!["On", "Off"].includes(automaticReviewStatus.label)) {
    return {
      label: reviewSummary,
      detail: [automaticReviewDiagnostic, repository, `Context Tree ${contextStatus.label.toLowerCase()}`]
        .filter((item): item is string => Boolean(item))
        .join(" · "),
      kind: automaticReviewStatus.kind,
    };
  }

  return {
    ...contextStatus,
    detail: automaticReviewDiagnostic
      ? [reviewSummary, automaticReviewDiagnostic, repository]
          .filter((item): item is string => Boolean(item))
          .join(" · ")
      : [repository, reviewSummary].filter((item): item is string => Boolean(item)).join(" · "),
  };
}

/**
 * Converts server-backed facts into the stable Setup rows. Keeping this
 * pure makes the role and optional-state rules independently testable.
 */
export function buildSetupRows(facts: SetupFacts): SetupRowModel[] {
  const isAdmin = facts.role === "admin";
  const reliesOnTeamAgent = facts.hasUsableAgent && !facts.hasPersonalAgent;
  const resumeSetup = facts.onboardingSuppressedAt !== null && facts.onboardingCompletedAt === null;

  const computerStatus =
    facts.computers.state === "loading"
      ? loadingStatus()
      : facts.computers.state === "error"
        ? unknownStatus()
        : facts.computers.value.connected > 0
          ? {
              label: `${facts.computers.value.connected} connected`,
              detail:
                facts.computers.value.connected === 1 && facts.computers.value.connectedHostname
                  ? facts.computers.value.connectedHostname
                  : countLabel(facts.computers.value.connected, "computer"),
              kind: "ready" as const,
            }
          : {
              label: "Not connected",
              detail:
                facts.computers.value.saved > 0
                  ? `${countLabel(facts.computers.value.saved, "saved computer")} offline${
                      reliesOnTeamAgent ? " · Optional" : ""
                    }`
                  : reliesOnTeamAgent
                    ? "Optional while a team agent is available"
                    : "No computer connected",
              kind: reliesOnTeamAgent ? ("optional" as const) : ("attention" as const),
            };

  const repositoryStatus =
    facts.repositories.state === "loading"
      ? loadingStatus()
      : facts.repositories.state === "error"
        ? unknownStatus()
        : facts.repositories.value > 0
          ? {
              label: `${facts.repositories.value} connected`,
              detail: countLabel(facts.repositories.value, "active repository", "active repositories"),
              kind: "ready" as const,
            }
          : { label: "None connected", detail: "Optional", kind: "optional" as const };

  const capabilities = facts.capabilities.state === "ready" ? facts.capabilities.value : null;
  const contextTree = contextTreeFact(facts.capabilities, facts.contextTreeSnapshot);
  const repositoryAutomationStatus =
    facts.capabilities.state === "loading"
      ? loadingStatus()
      : facts.capabilities.state === "error"
        ? unknownStatus()
        : providerSummary(facts.capabilities.value.repositoryAutomation.providers, isAdmin);
  const automaticReviewStatus =
    facts.capabilities.state === "loading"
      ? loadingStatus()
      : facts.capabilities.state === "error"
        ? unknownStatus()
        : reviewStatus(facts.capabilities.value.contextTree.automaticReview, isAdmin);

  return [
    {
      key: "work-access",
      title: "Work access",
      description: "Whether this team has an agent you can use.",
      icon: MessageCircle,
      status: facts.hasUsableAgent
        ? {
            label: "Can work now",
            detail: facts.hasPersonalAgent ? "Your agent is available" : "A team agent is available",
            kind: "ready",
          }
        : {
            label: "Agent needed",
            detail: "Set up an agent before starting work",
            kind: "attention",
          },
      action: facts.hasUsableAgent
        ? { label: "Start a chat", to: facts.workspaceWillEnterOnboarding ? "/onboarding" : "/" }
        : { label: "Set up", to: "/onboarding" },
    },
    {
      key: "computer",
      title: "Your computer",
      description: "A computer connected by you to run agents.",
      icon: Laptop,
      status: computerStatus,
      action: {
        label: facts.computers.state === "ready" && facts.computers.value.connected === 0 ? "Connect" : "Manage",
        to: "/settings/computers",
      },
    },
    {
      key: "agent",
      title: "Your agent",
      description: "An agent managed by you for personal workflows.",
      icon: Bot,
      status: facts.hasPersonalAgent
        ? { label: "Available", detail: "Managed by you", kind: "ready" }
        : resumeSetup
          ? { label: "Setup paused", detail: "Resume to create your agent", kind: "attention" }
          : {
              label: "Not set up",
              detail: facts.hasUsableAgent ? "Optional while a team agent is available" : "No agent managed by you",
              kind: facts.hasUsableAgent ? "optional" : "attention",
            },
      action: resumeSetup
        ? { label: "Resume setup", to: "/onboarding", intent: "resume-onboarding" }
        : facts.hasPersonalAgent
          ? { label: "View", to: "/team" }
          : { label: "Set up", to: "/onboarding" },
    },
    {
      key: "repositories",
      title: "Code repositories",
      description: "Team repositories agents can read and change.",
      icon: FolderGit2,
      status: repositoryStatus,
      action: {
        label: isAdmin
          ? facts.repositories.state === "ready" && facts.repositories.value === 0
            ? "Set up"
            : "Manage"
          : "View",
        to: "/settings/repositories#code-repositories",
      },
    },
    {
      key: "repository-automation",
      title: "GitHub & GitLab",
      description: "Repository events, identity, and automatic GitHub handling.",
      icon: Webhook,
      status: repositoryAutomationStatus,
      action: capabilities ? providerAction(capabilities.repositoryAutomation.providers, isAdmin) : undefined,
    },
    {
      key: "context-tree",
      title: "Context Tree",
      description: "Shared decisions and constraints available to agents.",
      icon: GitFork,
      status: combineContextTreeAndReviewStatus(
        contextTreeStatus(contextTree, capabilities?.contextTree.blockers ?? [], isAdmin),
        automaticReviewStatus,
        capabilities ? reviewDiagnosticDetail(capabilities.contextTree.automaticReview, isAdmin) : undefined,
      ),
      action: contextTreeAction(contextTree, isAdmin),
    },
  ];
}

export function SettingsSetupPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    role,
    organizationId,
    teamDisplayName,
    currentOrgHasUsableAgent,
    currentOrgHasPersonalAgent,
    meLoaded,
    onboardingStep,
    onboardingDismissedAt,
    onboardingCompletedAt,
    restoreOnboarding,
  } = useAuth();

  const computersQuery = useQuery({
    queryKey: ["clients", "me"],
    queryFn: listClients,
  });
  const repositoriesQuery = useQuery({
    queryKey: ["setup", "team-resources", organizationId],
    queryFn: () =>
      organizationId ? listTeamResourcesForOrg(organizationId) : Promise.reject(new Error("no organization")),
    enabled: !!organizationId,
  });
  const capabilitiesQuery = useQuery({
    queryKey: setupCapabilitiesQueryKey(organizationId),
    queryFn: () =>
      organizationId ? getTeamSetupCapabilitiesAt(organizationId) : Promise.reject(new Error("no organization")),
    enabled: !!organizationId,
  });
  const contextBound = capabilitiesQuery.data?.contextTree.binding.state === "bound";
  const contextSnapshotQuery = useQuery({
    queryKey: ["context-tree-snapshot", organizationId, "7d", false],
    queryFn: () =>
      organizationId ? getContextTreeSnapshot(organizationId, "7d") : Promise.reject(new Error("no organization")),
    enabled: !!organizationId && contextBound,
  });

  const computers = queryFact(computersQuery);
  const repositories = queryFact(repositoriesQuery);
  const capabilities = queryFact(capabilitiesQuery);
  const contextTreeSnapshot: SetupFacts["contextTreeSnapshot"] = !contextBound
    ? { state: "ready", value: null }
    : contextSnapshotQuery.isPending
      ? { state: "loading" }
      : contextSnapshotQuery.isError || !contextSnapshotQuery.data
        ? { state: "error" }
        : {
            state: "ready",
            value: {
              snapshotStatus: contextSnapshotQuery.data.snapshotStatus,
              provider: contextSnapshotQuery.data.provider,
              contentAvailability: contextSnapshotQuery.data.contentAvailability,
            },
          };

  const facts: SetupFacts = {
    role,
    teamName: teamDisplayName,
    hasUsableAgent: currentOrgHasUsableAgent,
    hasPersonalAgent: currentOrgHasPersonalAgent,
    onboardingSuppressedAt: onboardingDismissedAt,
    onboardingCompletedAt,
    workspaceWillEnterOnboarding: shouldEnterOnboarding({
      meLoaded,
      onboardingStep,
      onboardingSuppressedAt: onboardingDismissedAt,
      currentOrgHasPersonalAgent,
      onboardingCompletedAt,
    }),
    computers:
      computers.state === "ready"
        ? {
            state: "ready",
            value: {
              connected: computers.value.filter((client) => client.status === "connected").length,
              saved: computers.value.filter((client) => client.status !== "retired").length,
              connectedHostname: computers.value.find((client) => client.status === "connected")?.hostname ?? null,
            },
          }
        : computers,
    repositories:
      repositories.state === "ready"
        ? {
            state: "ready",
            value: repositories.value.filter((resource) => resource.type === "repo" && resource.status === "active")
              .length,
          }
        : repositories,
    capabilities,
    contextTreeSnapshot,
  };

  const resumeOnboarding = async () => {
    await restoreOnboarding();
    void reportOnboardingEvent("resumed", { source: "settings" });
    navigate("/onboarding");
  };

  useEffect(() => {
    if (location.hash === "#team-agent") {
      navigate("/settings/integrations/github#task-routing", { replace: true });
      return;
    }
    if (location.hash === "#context-tree") {
      navigate("/settings/context#binding", { replace: true });
      return;
    }
    if (location.hash === "#automatic-review") {
      navigate("/settings/context#automatic-review", { replace: true });
    }
  }, [location.hash, navigate]);

  return <SetupOverview facts={facts} rows={buildSetupRows(facts)} onResumeOnboarding={resumeOnboarding} />;
}

export function SetupOverview({
  facts,
  rows,
  onResumeOnboarding,
}: {
  facts: Pick<SetupFacts, "role" | "teamName">;
  rows: SetupRowModel[];
  onResumeOnboarding?: () => Promise<void>;
}) {
  const viewport = useWorkspaceViewport();
  const narrow = viewport === "narrow";
  const roleLabel = facts.role === "admin" ? "Admin" : "Member";

  return (
    <div style={{ padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }} data-setup-overview={roleLabel.toLowerCase()}>
      <header style={{ marginBottom: "var(--sp-3)" }}>
        <p className="text-body" data-setup-lead style={{ margin: 0, color: "var(--fg-2)" }}>
          See what's ready and what you can set up.
        </p>
        <p className="text-label" data-setup-context style={{ margin: "var(--sp-0_5) 0 0", color: "var(--fg-4)" }}>
          {facts.teamName ?? "This team"} · {roleLabel}
        </p>
      </header>

      <div style={{ borderTop: "var(--hairline) solid var(--border)" }}>
        {rows.map((row) => (
          <SetupRow key={row.key} row={row} narrow={narrow} onResumeOnboarding={onResumeOnboarding} />
        ))}
      </div>
    </div>
  );
}

const SETUP_STATUS_PRESENTATION: Record<SetupStatusKind, { icon: LucideIcon; color: string; animate?: boolean }> = {
  ready: { icon: CircleCheck, color: "var(--success)" },
  optional: { icon: CircleMinus, color: "var(--fg-4)" },
  loading: { icon: LoaderCircle, color: "var(--state-idle)", animate: true },
  pending: { icon: Clock3, color: "var(--state-idle)" },
  attention: { icon: CircleAlert, color: "var(--state-needs-you)" },
  neutral: { icon: CircleAlert, color: "var(--fg-3)" },
  blocked: { icon: CircleAlert, color: "var(--state-blocked)" },
  unknown: { icon: CircleHelp, color: "var(--fg-3)" },
};

function SetupStatusMark({ kind }: { kind: SetupStatusKind }) {
  const presentation = SETUP_STATUS_PRESENTATION[kind];
  const StatusIcon = presentation.icon;
  return (
    <StatusIcon
      aria-hidden
      className={cn("h-4 w-4 shrink-0", presentation.animate && "motion-safe:animate-spin")}
      style={{ color: presentation.color }}
    />
  );
}

function SetupRow({
  row,
  narrow,
  onResumeOnboarding,
}: {
  row: SetupRowModel;
  narrow: boolean;
  onResumeOnboarding?: () => Promise<void>;
}) {
  const Icon = row.icon;
  return (
    <section
      id={row.key}
      tabIndex={-1}
      aria-labelledby={`setup-${row.key}`}
      data-setup-row={row.key}
      style={{
        display: "grid",
        gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "minmax(0, 1fr) var(--sp-60) var(--sp-35)",
        alignItems: narrow ? "start" : "center",
        gap: narrow ? "var(--sp-3)" : "var(--sp-5)",
        padding: "var(--sp-4) 0",
        borderBottom: "var(--hairline) solid var(--border)",
      }}
    >
      <div className="flex min-w-0 items-start" style={{ gap: "var(--sp-3)" }}>
        <span
          className="flex shrink-0 items-center justify-center"
          style={{
            width: "var(--sp-8)",
            height: "var(--sp-8)",
            borderRadius: "var(--radius-input)",
            background: "var(--bg-sunken)",
            color: "var(--fg-3)",
          }}
          aria-hidden
        >
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span id={`setup-${row.key}`} className="text-body block font-medium" style={{ color: "var(--fg)" }}>
            {row.title}
          </span>
          <span className="text-caption block" style={{ marginTop: "var(--sp-0_5)", color: "var(--fg-3)" }}>
            {row.description}
          </span>
        </span>
      </div>

      <div data-setup-status-kind={row.status.kind} style={narrow ? { paddingLeft: "var(--sp-11)" } : undefined}>
        <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
          <SetupStatusMark kind={row.status.kind} />
          <span className="text-label font-medium" style={{ color: "var(--fg-2)" }}>
            {row.status.label}
          </span>
        </div>
        {row.status.detail ? (
          <p
            className="text-caption truncate"
            title={row.status.detail}
            style={{ margin: "var(--sp-0_5) 0 0 var(--sp-6)", color: "var(--fg-4)" }}
          >
            {row.status.detail}
          </p>
        ) : null}
      </div>

      <div
        className={cn("flex", !narrow && "justify-end")}
        style={narrow ? { paddingLeft: "var(--sp-11)" } : undefined}
      >
        {row.action ? (
          <Link
            to={row.action.to}
            onClick={
              row.action.intent === "resume-onboarding" && onResumeOnboarding
                ? async (event) => {
                    event.preventDefault();
                    await onResumeOnboarding();
                  }
                : undefined
            }
            className={cn(
              "text-label inline-flex items-center font-medium text-fg-2 transition-colors",
              "rounded-[var(--radius-input)] hover:bg-bg-hover hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
            )}
            style={{
              minHeight: "var(--sp-8)",
              padding: "0 var(--sp-2)",
              textDecoration: "none",
            }}
          >
            {row.action.label}
          </Link>
        ) : null}
      </div>
    </section>
  );
}
