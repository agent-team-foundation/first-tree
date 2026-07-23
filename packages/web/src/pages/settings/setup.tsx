import {
  type ContextTreeProvider,
  resolveContextTreeProvider,
  type SetupActionKind,
  type SetupAutomaticReview,
  type SetupBlocker,
  type SetupBlockerCode,
  type SetupCapabilityHealth,
  type SetupContextTreeBinding,
  type SetupRepositoryAutomationProvider,
  type TeamSetupCapabilities,
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
import { Link, useNavigate } from "react-router";
import { listClients } from "../../api/activity.js";
import { getContextTreeSnapshot } from "../../api/context-tree.js";
import { getGithubAppInstallation } from "../../api/github-app.js";
import { gitlabConnectionsQueryKey, listGitlabConnectionsAt } from "../../api/gitlab-connections.js";
import { reportOnboardingEvent } from "../../api/onboarding-events.js";
import { getContextTreeSetting } from "../../api/org-settings.js";
import { listTeamResourcesForOrg } from "../../api/resources.js";
import { getTeamSetupCapabilitiesAt, setupCapabilitiesQueryKey } from "../../api/setup-capabilities.js";
import { useAuth } from "../../auth/auth-context.js";
import { useWorkspaceViewport } from "../../hooks/use-viewport.js";
import { cn } from "../../lib/utils.js";
import { shouldEnterOnboarding } from "../onboarding/steps.js";

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
};

export type SetupStatusKind = "ready" | "optional" | "loading" | "pending" | "attention" | "blocked" | "unknown";

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
  contextTreeSetting: Fact<{
    provider?: ContextTreeProvider;
    repo?: string;
    branch?: string;
  }>;
  contextTreeSnapshot: Fact<"active" | "stale" | "unavailable" | null>;
  github: Fact<{ accountLogin: string; accountType: string } | null>;
  gitlab: Fact<{ displayName: string; instanceOrigin: string } | null>;
};

export type SetupRowModel = {
  key: "work-access" | "computer" | "agent" | "repositories" | "context-tree" | "providers";
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
  setting: SetupFacts["contextTreeSetting"],
  snapshot: Fact<"active" | "stale" | "unavailable" | null>,
): Fact<ContextTreeFact> {
  let binding: SetupContextTreeBinding;
  if (capabilities.state === "ready") {
    binding = capabilities.value.contextTree.binding;
  } else {
    if (setting.state === "loading") return { state: "loading" };
    if (setting.state === "error") return { state: "error" };
    if (!setting.value.repo) {
      binding = { state: "unbound" };
    } else {
      const provider =
        setting.value.provider ??
        resolveContextTreeProvider({
          repo: setting.value.repo,
          declaredProvider: setting.value.provider,
        }).provider;
      binding = provider
        ? {
            state: "bound",
            provider,
            repo: setting.value.repo,
            branch: setting.value.branch ?? "main",
          }
        : { state: "invalid" };
    }
  }

  if (binding.state !== "bound") {
    return { state: "ready", value: { binding, availability: null } };
  }
  if (snapshot.state === "loading") {
    return { state: "ready", value: { binding, availability: "checking" } };
  }
  if (snapshot.state === "error") {
    return { state: "ready", value: { binding, availability: "unknown" } };
  }
  return {
    state: "ready",
    value: { binding, availability: snapshot.value ?? "unknown" },
  };
}

function pendingStatus(): SetupRowModel["status"] {
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

function gitlabOriginLabel(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

const PROVIDER_LABELS = {
  github: "GitHub",
  gitlab: "GitLab",
} as const;

const BLOCKER_COPY = {
  provider_probe_failed: "First Tree could not verify provider readiness.",
  github_app_not_configured: "GitHub automation is not configured for this First Tree deployment.",
  github_app_suspended: "The GitHub App installation is suspended.",
  github_webhook_events_missing: "Required GitHub App webhook events are missing.",
  github_pull_requests_permission_required: "GitHub pull-request write access is required.",
  github_tree_repo_not_covered: "The GitHub App cannot access this Context Tree repository.",
  gitlab_webhook_not_seen: "Waiting for the first valid GitLab webhook.",
  gitlab_processing_failed: "Recent GitLab webhook processing failed.",
  context_tree_binding_invalid: "The Context Tree binding is invalid.",
  context_tree_provider_unresolved: "The Context Tree provider could not be resolved.",
  context_tree_connection_mismatch: "The Context Tree repository does not match the current GitLab connection.",
  context_review_provider_prerequisite_missing: "The repository provider must be connected before review can run.",
  context_review_agent_missing: "The configured reviewer is missing.",
  context_review_agent_inactive: "The configured reviewer is inactive.",
} satisfies Record<SetupBlockerCode, string>;

const ACTION_DESTINATIONS = {
  connect_github: "/settings/integrations/github",
  manage_github_installation: "/settings/integrations/github",
  connect_gitlab: "/settings/integrations/gitlab",
  configure_gitlab_webhook: "/settings/integrations/gitlab",
  repair_tree_binding: "/settings/repositories#context-tree",
  open_tree_setup_chat: "/context",
  select_review_agent: "/settings/repositories#context-tree",
  replace_review_agent: "/settings/repositories#context-tree",
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
} satisfies Record<SetupActionKind, string>;

function blockerDetail(blockers: SetupBlocker[], isAdmin: boolean): string | undefined {
  const details = blockers.map((item) => {
    if (!isAdmin && item.resolutionOwner === "admin") {
      return `Ask an admin to resolve this: ${BLOCKER_COPY[item.code]}`;
    }
    if (item.resolutionOwner === "operator") {
      return `${BLOCKER_COPY[item.code]} No action is needed from you.`;
    }
    return BLOCKER_COPY[item.code];
  });
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

function issueKind(blockers: SetupBlocker[], isAdmin: boolean): SetupStatusKind {
  return isAdmin && hasAdminBlocker(blockers) ? "attention" : "blocked";
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

function providerSummary(
  providers: SetupRepositoryAutomationProvider[],
  github: SetupFacts["github"],
  gitlab: SetupFacts["gitlab"],
  isAdmin: boolean,
): SetupRowModel["status"] {
  const configured = providers.filter((provider) => provider.adoption !== "available");
  if (configured.length === 0) {
    return { label: "Not connected", detail: "Optional", kind: "optional" };
  }

  const ready = configured.filter((provider) => provider.health === "ready");
  const providerDetail = configured
    .map((provider) => `${PROVIDER_LABELS[provider.provider]} ${providerHealthLabel(provider)}`)
    .join(" · ");
  const blockers = configured.flatMap((provider) => provider.blockers);
  const issues = blockerDetail(blockers, isAdmin);
  const detail = [providerDetail, issues].filter((item): item is string => Boolean(item)).join(" · ");

  if (ready.length === configured.length) {
    if (ready.length === 1 && ready[0]?.provider === "github" && github.state === "ready" && github.value) {
      return {
        label: `GitHub · ${github.value.accountLogin}`,
        detail: github.value.accountType,
        kind: "ready",
      };
    }
    if (ready.length === 1 && ready[0]?.provider === "gitlab" && gitlab.state === "ready" && gitlab.value) {
      return {
        label: `GitLab · ${gitlab.value.displayName}`,
        detail: gitlabOriginLabel(gitlab.value.instanceOrigin),
        kind: "ready",
      };
    }
    const identityDetail =
      ready.length === 2 && github.state === "ready" && github.value && gitlab.state === "ready" && gitlab.value
        ? `${github.value.accountLogin} · ${gitlab.value.displayName}`
        : detail;
    return {
      label: ready.length === 2 ? "GitHub + GitLab" : `${PROVIDER_LABELS[ready[0]?.provider ?? "github"]} ready`,
      detail: identityDetail,
      kind: "ready",
    };
  }

  const hasDegraded = configured.some(
    (provider) => provider.health === "degraded" || provider.health === "unavailable",
  );
  if (hasDegraded) {
    const hasUnavailable = configured.some((provider) => provider.health === "unavailable");
    return {
      label:
        ready.length > 0
          ? "Partial coverage"
          : hasUnavailable
            ? hasAdminBlocker(blockers) && isAdmin
              ? "Needs attention"
              : "Service unavailable"
            : "Degraded",
      detail,
      kind: issueKind(blockers, isAdmin),
    };
  }

  if (configured.some((provider) => provider.health === "pending_verification")) {
    return {
      label: ready.length > 0 ? "Partial coverage" : "Waiting for verification",
      detail,
      kind: "pending",
    };
  }

  return unknownStatus();
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
    label: configured.length === 0 ? "Connect" : "Manage",
    to: first ? `/settings/integrations/${first.provider}` : "/settings/integrations/github",
  };
}

function contextTreeStatus(
  contextTree: Fact<ContextTreeFact>,
  blockers: SetupBlocker[],
  reviewFact: Fact<SetupAutomaticReview>,
  isAdmin: boolean,
): SetupRowModel["status"] {
  if (contextTree.state === "loading") return pendingStatus();
  if (contextTree.state === "error") return unknownStatus();

  const { binding, availability } = contextTree.value;
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
  const review = reviewFact.state === "ready" ? reviewFact.value : null;
  const reviewState = review ? reviewStatus(review, isAdmin) : null;
  const reviewDetail =
    review?.adoption === "disabled"
      ? "Automatic review off · Optional"
      : review?.adoption === "enabled" && reviewState
        ? [`Automatic review ${reviewState.label.toLowerCase()}`, reviewState.detail]
            .filter((item): item is string => Boolean(item))
            .join(" · ")
        : null;
  const prioritizeReview =
    review?.adoption === "enabled" && reviewState !== null && !["ready", "optional"].includes(reviewState.kind);
  const detail = (
    prioritizeReview ? [reviewDetail, issueDetail, bindingDetail] : [bindingDetail, issueDetail, reviewDetail]
  )
    .filter((item): item is string => Boolean(item))
    .join(" · ");

  if (availability === "active") {
    if (reviewFact.state === "loading") {
      return { label: "Available · checking review", detail, kind: "loading" };
    }
    if (reviewFact.state === "error") {
      return {
        label: "Available · review status unavailable",
        detail: [unknownStatus().detail, detail].filter(Boolean).join(" · "),
        kind: "unknown",
      };
    }
    if (!review || review.adoption === "unavailable" || review.adoption === "disabled") {
      return { label: "Available", detail, kind: "ready" };
    }
    if (reviewState?.kind === "ready") {
      return { label: "Available", detail, kind: "ready" };
    }
    if (reviewState?.kind === "pending") {
      return { label: "Available · review pending", detail, kind: "pending" };
    }
    if (reviewState?.kind === "attention" || reviewState?.kind === "blocked") {
      return {
        label: review.health === "degraded" ? "Available · review degraded" : "Available · review unavailable",
        detail,
        kind: reviewState.kind,
      };
    }
    return { label: "Available · review status unavailable", detail, kind: "unknown" };
  }
  if (availability === "stale") return { label: "Available · update delayed", detail, kind: "blocked" };
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
  const unknown = unknownStatus();
  return { ...unknown, detail: [bindingDetail, unknown.detail].filter(Boolean).join(" · ") };
}

function contextTreeAction(
  contextTree: Fact<ContextTreeFact>,
  blockers: SetupBlocker[],
  review: SetupAutomaticReview | null,
  isAdmin: boolean,
): SetupRowModel["action"] | undefined {
  if (contextTree.state !== "ready") return undefined;
  const { binding, availability } = contextTree.value;
  if (binding.state === "unbound") {
    return isAdmin ? { label: "Set up", to: "/context" } : undefined;
  }
  if (binding.state === "invalid") {
    return isAdmin
      ? (actionFromBlockers(blockers, true) ?? { label: "Repair", to: "/settings/repositories#context-tree" })
      : { label: "View", to: "/context" };
  }
  if (availability === "unavailable") {
    return isAdmin ? { label: "Recover", to: "/context" } : { label: "View", to: "/context" };
  }
  if (availability === "active" && review?.adoption === "enabled") {
    const reviewBlockerAction = actionFromBlockers(review.blockers, isAdmin);
    if (reviewBlockerAction) return reviewBlockerAction;
    if (review.blockers.length > 0) {
      return isAdmin ? undefined : { label: "View", to: "/context" };
    }
  }
  return isAdmin ? { label: "Manage", to: "/settings/repositories#context-tree" } : { label: "View", to: "/context" };
}

function reviewStatus(review: SetupAutomaticReview, isAdmin: boolean): SetupRowModel["status"] {
  if (review.adoption === "unavailable") {
    return { label: "Available after Context Tree", kind: "optional" };
  }
  if (review.adoption === "disabled") {
    return { label: "Off", detail: "Optional", kind: "optional" };
  }

  const reviewer = review.reviewerAgent ? `Reviewer · ${review.reviewerAgent.displayName}` : null;
  const issues = blockerDetail(review.blockers, isAdmin);
  const detail = [issues, reviewer].filter((item): item is string => Boolean(item)).join(" · ") || undefined;
  if (review.health === "ready") return { label: "On", detail, kind: "ready" };
  if (review.health === "pending_verification") return { label: "Verification pending", detail, kind: "pending" };
  if (review.health === "degraded") {
    return { label: "Degraded", detail, kind: issueKind(review.blockers, isAdmin) };
  }
  if (review.health === "unavailable") {
    return {
      label: hasAdminBlocker(review.blockers) && isAdmin ? "Needs attention" : "Service unavailable",
      detail,
      kind: issueKind(review.blockers, isAdmin),
    };
  }
  const unknown = unknownStatus();
  return { ...unknown, detail: detail ?? unknown.detail };
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
      ? pendingStatus()
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
      ? pendingStatus()
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
  const contextTree = contextTreeFact(facts.capabilities, facts.contextTreeSetting, facts.contextTreeSnapshot);
  const automaticReview: Fact<SetupAutomaticReview> =
    facts.capabilities.state === "ready"
      ? { state: "ready", value: facts.capabilities.value.contextTree.automaticReview }
      : facts.capabilities.state === "loading"
        ? { state: "loading" }
        : { state: "error" };
  const providerStatus =
    facts.capabilities.state === "loading"
      ? pendingStatus()
      : facts.capabilities.state === "error"
        ? unknownStatus()
        : providerSummary(facts.capabilities.value.repositoryAutomation.providers, facts.github, facts.gitlab, isAdmin);

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
      key: "context-tree",
      title: "Context Tree",
      description: "Shared decisions and constraints available to agents.",
      icon: GitFork,
      status: contextTreeStatus(contextTree, capabilities?.contextTree.blockers ?? [], automaticReview, isAdmin),
      action: contextTreeAction(
        contextTree,
        capabilities?.contextTree.blockers ?? [],
        capabilities?.contextTree.automaticReview ?? null,
        isAdmin,
      ),
    },
    {
      key: "providers",
      title: "GitHub / GitLab",
      description: "A code provider connection for events, identity, and webhooks.",
      icon: Webhook,
      status: providerStatus,
      action: capabilities ? providerAction(capabilities.repositoryAutomation.providers, isAdmin) : undefined,
    },
  ];
}

export function SettingsSetupPage() {
  const navigate = useNavigate();
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
  const contextSettingQuery = useQuery({
    queryKey: ["org-setting", organizationId, "context_tree", "safe"],
    queryFn: () =>
      organizationId ? getContextTreeSetting(organizationId) : Promise.reject(new Error("no organization")),
    enabled: !!organizationId,
  });
  const capabilitiesQuery = useQuery({
    queryKey: setupCapabilitiesQueryKey(organizationId),
    queryFn: () =>
      organizationId ? getTeamSetupCapabilitiesAt(organizationId) : Promise.reject(new Error("no organization")),
    enabled: !!organizationId,
  });
  const contextBound = Boolean(contextSettingQuery.data?.repo);
  const contextSnapshotQuery = useQuery({
    queryKey: ["context-tree-snapshot", organizationId, "7d", false],
    queryFn: () =>
      organizationId ? getContextTreeSnapshot(organizationId, "7d") : Promise.reject(new Error("no organization")),
    enabled: !!organizationId && contextBound,
  });
  const githubQuery = useQuery({
    queryKey: ["github-app-installation", organizationId],
    queryFn: () =>
      organizationId ? getGithubAppInstallation(organizationId) : Promise.reject(new Error("no organization")),
    enabled: !!organizationId,
  });
  const gitlabQuery = useQuery({
    queryKey: gitlabConnectionsQueryKey(organizationId),
    queryFn: () =>
      organizationId ? listGitlabConnectionsAt(organizationId) : Promise.reject(new Error("no organization")),
    enabled: !!organizationId,
  });

  const computers = queryFact(computersQuery);
  const repositories = queryFact(repositoriesQuery);
  const contextTreeSetting = queryFact(contextSettingQuery);
  const capabilities = queryFact(capabilitiesQuery);
  const github = queryFact(githubQuery);
  const gitlab = queryFact(gitlabQuery);
  const contextTreeSnapshot: SetupFacts["contextTreeSnapshot"] = contextSettingQuery.isPending
    ? { state: "loading" }
    : contextSettingQuery.isError
      ? { state: "error" }
      : !contextBound
        ? { state: "ready", value: null }
        : contextSnapshotQuery.isPending
          ? { state: "loading" }
          : contextSnapshotQuery.isError || !contextSnapshotQuery.data
            ? { state: "error" }
            : { state: "ready", value: contextSnapshotQuery.data.snapshotStatus };

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
    contextTreeSetting,
    contextTreeSnapshot,
    github:
      github.state === "ready"
        ? {
            state: "ready",
            value: github.value
              ? {
                  accountLogin: github.value.accountLogin,
                  accountType: github.value.accountType,
                }
              : null,
          }
        : github,
    gitlab:
      gitlab.state === "ready"
        ? {
            state: "ready",
            value: gitlab.value[0]
              ? {
                  displayName: gitlab.value[0].displayName,
                  instanceOrigin: gitlab.value[0].instanceOrigin,
                }
              : null,
          }
        : gitlab,
  };

  const resumeOnboarding = async () => {
    await restoreOnboarding();
    void reportOnboardingEvent("resumed", { source: "settings" });
    navigate("/onboarding");
  };

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
