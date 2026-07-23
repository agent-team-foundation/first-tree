import { GITLAB_CONNECTION_READINESS, type GitlabConnectionReadiness } from "@first-tree/shared";
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
  bound: boolean;
  repo: string | null;
  branch: string | null;
  availability: "active" | "stale" | "unavailable" | "checking";
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
  contextTree: Fact<ContextTreeFact>;
  github: Fact<{ accountLogin: string; accountType: string; suspended: boolean } | null>;
  gitlab: Fact<{
    displayName: string;
    instanceOrigin: string;
    endpointSeen: boolean;
    health: {
      readiness: GitlabConnectionReadiness;
    };
  } | null>;
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
  setting: Fact<{ repo?: string | null; branch?: string | null }>,
  snapshot: {
    data?: { snapshotStatus: Exclude<ContextTreeFact["availability"], "checking"> };
    isPending: boolean;
  },
): Fact<ContextTreeFact> {
  if (setting.state !== "ready") return setting;

  const base = {
    bound: !!setting.value.repo,
    repo: setting.value.repo ?? null,
    branch: setting.value.branch ?? null,
  };
  if (!base.bound) {
    return { state: "ready", value: { ...base, availability: "unavailable" } };
  }
  if (snapshot.data) {
    return {
      state: "ready",
      value: { ...base, availability: snapshot.data.snapshotStatus },
    };
  }
  if (snapshot.isPending) {
    return { state: "ready", value: { ...base, availability: "checking" } };
  }
  return { state: "error" };
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

function gitlabOriginLabel(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function gitlabConnectionIssue(
  gitlab: NonNullable<Extract<SetupFacts["gitlab"], { state: "ready" }>["value"]>,
): "processing" | "waiting_system_hook" | "waiting_merge_request" | null {
  const readiness = gitlab.health.readiness;
  if (readiness === GITLAB_CONNECTION_READINESS.needsAttention) return "processing";
  if (readiness === GITLAB_CONNECTION_READINESS.waiting) return "waiting_system_hook";
  if (readiness === GITLAB_CONNECTION_READINESS.transportReceived) return "waiting_merge_request";
  return null;
}

function gitlabIssueLabel(issue: NonNullable<ReturnType<typeof gitlabConnectionIssue>>): string {
  if (issue === "processing") return "Processing issue";
  if (issue === "waiting_system_hook") return "Waiting for System Hook";
  return "Waiting for merge request event";
}

/**
 * Converts server-backed facts into the six stable Setup rows. Keeping this
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

  const contextStatus =
    facts.contextTree.state === "loading"
      ? loadingStatus()
      : facts.contextTree.state === "error"
        ? unknownStatus()
        : !facts.contextTree.value.bound
          ? { label: "Not set up", detail: "Optional", kind: "optional" as const }
          : {
              label:
                facts.contextTree.value.availability === "active"
                  ? "Available"
                  : facts.contextTree.value.availability === "stale"
                    ? "Available · update delayed"
                    : facts.contextTree.value.availability === "checking"
                      ? "Checking availability"
                      : "Bound · unavailable",
              detail: [
                repositoryLabel(facts.contextTree.value.repo),
                facts.contextTree.value.branch ? `${facts.contextTree.value.branch} branch` : null,
              ]
                .filter(Boolean)
                .join(" · "),
              kind:
                facts.contextTree.value.availability === "active"
                  ? ("ready" as const)
                  : facts.contextTree.value.availability === "checking"
                    ? ("loading" as const)
                    : ("blocked" as const),
            };

  const github = facts.github.state === "ready" ? facts.github.value : null;
  const gitlab = facts.gitlab.state === "ready" ? facts.gitlab.value : null;
  const gitlabIssue = gitlab ? gitlabConnectionIssue(gitlab) : null;
  const providerIssueKind: SetupStatusKind =
    github?.suspended || gitlabIssue === "processing" ? "blocked" : gitlabIssue ? "pending" : "ready";
  const providerStatus: SetupRowModel["status"] =
    github && gitlab
      ? {
          label: "GitHub + GitLab",
          detail:
            github.suspended || gitlabIssue
              ? `${github.suspended ? "GitHub suspended" : "GitHub connected"} · ${
                  gitlabIssue ? `GitLab ${gitlabIssueLabel(gitlabIssue).toLowerCase()}` : "GitLab connected"
                }`
              : `${github.accountLogin} · ${gitlab.displayName}`,
          kind: providerIssueKind,
        }
      : github
        ? {
            label: `GitHub · ${github.accountLogin}`,
            detail: github.suspended ? "Connection suspended" : github.accountType,
            kind: github.suspended ? "blocked" : "ready",
          }
        : gitlab
          ? {
              label: `GitLab · ${gitlab.displayName}`,
              detail: gitlabIssue ? gitlabIssueLabel(gitlabIssue) : gitlabOriginLabel(gitlab.instanceOrigin),
              kind: providerIssueKind,
            }
          : facts.github.state === "loading" || facts.gitlab.state === "loading"
            ? loadingStatus()
            : facts.github.state === "error" || facts.gitlab.state === "error"
              ? unknownStatus()
              : { label: "Not connected", detail: "Optional", kind: "optional" };
  const hasProvider = !!github || !!gitlab;
  const providersKnownAbsent =
    facts.github.state === "ready" &&
    facts.github.value === null &&
    facts.gitlab.state === "ready" &&
    facts.gitlab.value === null;
  const providerTarget = github
    ? "/settings/integrations/github"
    : gitlab
      ? "/settings/integrations/gitlab"
      : "/settings/integrations";

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
        : { label: "Agent needed", detail: "Set up an agent before starting work", kind: "attention" },
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
      status: contextStatus,
      action: {
        label:
          isAdmin && facts.contextTree.state === "ready" && !facts.contextTree.value.bound
            ? "Set up"
            : isAdmin
              ? "Manage"
              : "View",
        to:
          isAdmin && facts.contextTree.state === "ready" && facts.contextTree.value.bound
            ? "/settings/repositories#context-tree"
            : "/context",
      },
    },
    {
      key: "providers",
      title: "GitHub / GitLab",
      description: "A code provider connection for events, identity, and webhooks.",
      icon: Webhook,
      status: providerStatus,
      action: isAdmin
        ? hasProvider
          ? { label: "Manage", to: providerTarget }
          : providersKnownAbsent
            ? { label: "Connect", to: providerTarget }
            : undefined
        : hasProvider
          ? { label: "View", to: providerTarget }
          : undefined,
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
  const contextBound = !!contextSettingQuery.data?.repo;
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
  const contextSetting = queryFact(contextSettingQuery);
  const github = queryFact(githubQuery);
  const gitlab = queryFact(gitlabQuery);

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
    contextTree: contextTreeFact(contextSetting, contextSnapshotQuery),
    github:
      github.state === "ready"
        ? {
            state: "ready",
            value: github.value
              ? {
                  accountLogin: github.value.accountLogin,
                  accountType: github.value.accountType,
                  suspended: github.value.suspended,
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
                  endpointSeen: gitlab.value[0].endpointSeen,
                  health: {
                    readiness: gitlab.value[0].health.readiness,
                  },
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
