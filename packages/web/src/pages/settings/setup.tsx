import { useQuery } from "@tanstack/react-query";
import { Bot, CircleCheck, FolderGit2, GitFork, Laptop, type LucideIcon, Webhook } from "lucide-react";
import { Link } from "react-router";
import { listClients } from "../../api/activity.js";
import { getContextTreeSnapshot } from "../../api/context-tree.js";
import { getGithubAppInstallation } from "../../api/github-app.js";
import { gitlabConnectionsQueryKey, listGitlabConnectionsAt } from "../../api/gitlab-connections.js";
import { getContextTreeSetting } from "../../api/org-settings.js";
import { listTeamResourcesForOrg } from "../../api/resources.js";
import { useAuth } from "../../auth/auth-context.js";
import { useWorkspaceViewport } from "../../hooks/use-viewport.js";
import { cn } from "../../lib/utils.js";

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

export type SetupFacts = {
  role: string | null;
  teamName: string | null;
  hasUsableAgent: boolean;
  hasPersonalAgent: boolean;
  computers: Fact<{ connected: number; saved: number; connectedHostname: string | null }>;
  repositories: Fact<number>;
  contextTree: Fact<ContextTreeFact>;
  github: Fact<{ accountLogin: string; accountType: string; suspended: boolean } | null>;
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
    positive?: boolean;
  };
  action?: {
    label: string;
    to: string;
  };
};

function queryFact<T>(query: { data: T | undefined; isPending: boolean; isError: boolean }): Fact<T> {
  if (query.isPending) return { state: "loading" };
  if (query.isError || query.data === undefined) return { state: "error" };
  return { state: "ready", value: query.data };
}

function pendingStatus(): SetupRowModel["status"] {
  return { label: "Checking…" };
}

function unavailableStatus(): SetupRowModel["status"] {
  return { label: "Unavailable", detail: "This status could not be loaded." };
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

/**
 * Converts server-backed facts into the six stable Setup rows. Keeping this
 * pure makes the role and optional-state rules independently testable.
 */
export function buildSetupRows(facts: SetupFacts): SetupRowModel[] {
  const isAdmin = facts.role === "admin";
  const reliesOnTeamAgent = facts.hasUsableAgent && !facts.hasPersonalAgent;

  const computerStatus =
    facts.computers.state === "loading"
      ? pendingStatus()
      : facts.computers.state === "error"
        ? unavailableStatus()
        : facts.computers.value.connected > 0
          ? {
              label: `${facts.computers.value.connected} connected`,
              detail:
                facts.computers.value.connected === 1 && facts.computers.value.connectedHostname
                  ? facts.computers.value.connectedHostname
                  : countLabel(facts.computers.value.connected, "computer"),
              positive: true,
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
            };

  const repositoryStatus =
    facts.repositories.state === "loading"
      ? pendingStatus()
      : facts.repositories.state === "error"
        ? unavailableStatus()
        : facts.repositories.value > 0
          ? {
              label: `${facts.repositories.value} connected`,
              detail: countLabel(facts.repositories.value, "active repository", "active repositories"),
              positive: true,
            }
          : { label: "None connected", detail: "Optional" };

  const contextStatus =
    facts.contextTree.state === "loading"
      ? pendingStatus()
      : facts.contextTree.state === "error"
        ? unavailableStatus()
        : !facts.contextTree.value.bound
          ? { label: "Not set up", detail: "Optional" }
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
              positive: facts.contextTree.value.availability === "active",
            };

  const github = facts.github.state === "ready" ? facts.github.value : null;
  const gitlab = facts.gitlab.state === "ready" ? facts.gitlab.value : null;
  const providerStatus: SetupRowModel["status"] =
    github && gitlab
      ? {
          label: "GitHub + GitLab",
          detail: `${github.accountLogin} · ${gitlab.displayName}`,
          positive: !github.suspended,
        }
      : github
        ? {
            label: `GitHub · ${github.accountLogin}`,
            detail: github.suspended ? "Connection suspended" : github.accountType,
            positive: !github.suspended,
          }
        : gitlab
          ? {
              label: `GitLab · ${gitlab.displayName}`,
              detail: gitlabOriginLabel(gitlab.instanceOrigin),
              positive: true,
            }
          : facts.github.state === "loading" || facts.gitlab.state === "loading"
            ? pendingStatus()
            : facts.github.state === "error" || facts.gitlab.state === "error"
              ? unavailableStatus()
              : { label: "Not connected", detail: "Optional" };
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
      icon: CircleCheck,
      status: facts.hasUsableAgent
        ? {
            label: "Can work now",
            detail: facts.hasPersonalAgent ? "Your agent is available" : "A team agent is available",
            positive: true,
          }
        : { label: "Agent needed", detail: "Set up an agent before starting work" },
      action: facts.hasUsableAgent ? { label: "Start a chat", to: "/" } : { label: "Set up", to: "/onboarding" },
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
        ? { label: "Available", detail: "Managed by you", positive: true }
        : {
            label: "Not set up",
            detail: facts.hasUsableAgent ? "Optional while a team agent is available" : "No agent managed by you",
          },
      action: facts.hasPersonalAgent ? { label: "View", to: "/team" } : { label: "Set up", to: "/onboarding" },
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
  const { role, organizationId, teamDisplayName, currentOrgHasUsableAgent, currentOrgHasPersonalAgent } = useAuth();

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
    contextTree:
      contextSetting.state === "ready"
        ? {
            state: "ready",
            value: {
              bound: !!contextSetting.value.repo,
              repo: contextSetting.value.repo ?? null,
              branch: contextSetting.value.branch ?? null,
              availability: !contextSetting.value.repo
                ? "unavailable"
                : contextSnapshotQuery.isPending
                  ? "checking"
                  : contextSnapshotQuery.isError || !contextSnapshotQuery.data
                    ? "unavailable"
                    : contextSnapshotQuery.data.snapshotStatus === "active" &&
                        contextSnapshotQuery.data.contextStatus.severity === "ok"
                      ? "active"
                      : contextSnapshotQuery.data.snapshotStatus === "stale"
                        ? "stale"
                        : "unavailable",
            },
          }
        : contextSetting,
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
                }
              : null,
          }
        : gitlab,
  };

  return <SetupOverview facts={facts} rows={buildSetupRows(facts)} />;
}

export function SetupOverview({
  facts,
  rows,
}: {
  facts: Pick<SetupFacts, "role" | "teamName">;
  rows: SetupRowModel[];
}) {
  const viewport = useWorkspaceViewport();
  const narrow = viewport === "narrow";
  const roleLabel = facts.role === "admin" ? "Admin" : "Member";

  return (
    <div style={{ padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }} data-setup-overview={roleLabel.toLowerCase()}>
      <p className="text-body" data-setup-context style={{ margin: "0 0 var(--sp-3)", color: "var(--fg-3)" }}>
        {facts.teamName ?? "This team"} · {roleLabel}
      </p>

      <div style={{ borderTop: "var(--hairline) solid var(--border)" }}>
        {rows.map((row) => (
          <SetupRow key={row.key} row={row} narrow={narrow} />
        ))}
      </div>
    </div>
  );
}

function SetupRow({ row, narrow }: { row: SetupRowModel; narrow: boolean }) {
  const Icon = row.icon;
  return (
    <section
      aria-labelledby={`setup-${row.key}`}
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

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={narrow ? { paddingLeft: "var(--sp-11)" } : undefined}
      >
        <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
          <span
            aria-hidden
            style={{
              width: "var(--sp-2)",
              height: "var(--sp-2)",
              flexShrink: 0,
              borderRadius: "var(--radius-full)",
              background: row.status.positive ? "var(--color-success)" : "var(--border-strong)",
            }}
          />
          <span className="text-label font-medium" style={{ color: "var(--fg-2)" }}>
            {row.status.label}
          </span>
        </div>
        {row.status.detail ? (
          <p
            className="text-caption truncate"
            title={row.status.detail}
            style={{ margin: "var(--sp-0_5) 0 0 var(--sp-4)", color: "var(--fg-4)" }}
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
