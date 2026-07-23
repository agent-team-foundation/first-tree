import {
  canonicalGitRepoIdentity,
  GITLAB_CONNECTION_READINESS,
  resolveContextTreeProvider,
  type SetupAutomaticReview,
  type SetupBlocker,
  type SetupContextTreeBinding,
  type SetupRepositoryAutomationProvider,
  type TeamSetupCapabilities,
  teamSetupCapabilitiesSchema,
} from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { readContextReviewerAgentReadiness } from "./context-reviewer-readiness.js";
import {
  createAppJwt,
  GithubAppApiError,
  type GithubAppCredentials,
  getRepository,
  mintInstallationToken,
} from "./github-app.js";
import { findInstallationByOrg, type InstallationRow } from "./github-app-installations.js";
import { projectGitlabConnectionReadiness } from "./gitlab-connections.js";
import { getOrgContextReviewRuntime } from "./org-settings.js";

export type GithubReviewProbeResult = "ready" | "permission_required" | "repo_not_covered" | "failed";
export type GithubReviewCredentials = GithubAppCredentials & { slug?: string; webhookSecret?: string };
const GITHUB_REVIEW_PROBE_TIMEOUT_MS = 5_000;
const GITHUB_REPOSITORY_AUTOMATION_EVENTS: ReadonlySet<string> = new Set([
  "commit_comment",
  "discussion",
  "discussion_comment",
  "issue_comment",
  "issues",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
]);
const GITHUB_AUTOMATIC_REVIEW_EVENTS = ["pull_request", "issue_comment", "pull_request_review_comment"] as const;

export type SetupCapabilitiesOptions = {
  now?: () => Date;
  githubAppCredentials?: GithubReviewCredentials;
  githubFetch?: typeof fetch;
  probeGithubReview?: (installation: InstallationRow, repo: string) => Promise<GithubReviewProbeResult>;
  staleSeconds?: number;
};

function blocker(
  code: SetupBlocker["code"],
  resolutionOwner: SetupBlocker["resolutionOwner"],
  actionKind: SetupBlocker["actionKind"],
): SetupBlocker {
  return { code, resolutionOwner, actionKind };
}

function githubRepositoryAutomationEventsReady(events: string[]): boolean {
  return events.some((event) => GITHUB_REPOSITORY_AUTOMATION_EVENTS.has(event));
}

export function githubAutomaticReviewEventsReady(events: string[]): boolean {
  return GITHUB_AUTOMATIC_REVIEW_EVENTS.every((event) => events.includes(event));
}

async function defaultGithubReviewProbe(
  installation: InstallationRow,
  repo: string,
  credentials: GithubReviewCredentials | undefined,
  baseFetch: typeof fetch = fetch,
): Promise<GithubReviewProbeResult> {
  const signal = AbortSignal.timeout(GITHUB_REVIEW_PROBE_TIMEOUT_MS);
  const fetcher: typeof fetch = (input, init) =>
    baseFetch(input, {
      ...init,
      signal,
    });
  if (!credentials?.slug) return "failed";
  const identity = canonicalGitRepoIdentity(repo);
  const parts = identity?.host === "github.com" ? identity.path.split("/") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return "failed";
  if (parts[0].toLowerCase() !== installation.accountLogin.toLowerCase()) return "repo_not_covered";

  let appJwt: string;
  try {
    appJwt = await createAppJwt(credentials);
  } catch {
    return "failed";
  }

  try {
    const minted = await mintInstallationToken(appJwt, installation.installationId, {
      fetcher,
      repositories: [parts[1]],
      permissions: { metadata: "read", pull_requests: "write" },
    });
    return minted.permissions.pull_requests === "write" ? "ready" : "permission_required";
  } catch (error) {
    if (
      !(error instanceof GithubAppApiError) ||
      (error.status !== 403 && error.status !== 404 && error.status !== 422)
    ) {
      return "failed";
    }
  }

  // Scoped-mint 403/404/422 responses are ambiguous. Only a selected-repo
  // token followed by an exact-repo 404 proves the actionable coverage gap.
  // Every request shares one abort signal, bounding the whole diagnostic.
  try {
    const diagnostic = await mintInstallationToken(appJwt, installation.installationId, { fetcher });
    if (diagnostic.permissions.pull_requests !== "write") return "permission_required";
    if (diagnostic.repositorySelection !== "selected") return "failed";
    try {
      await getRepository(diagnostic.token, parts[0], parts[1], { fetcher });
    } catch (error) {
      if (error instanceof GithubAppApiError && error.status === 404) return "repo_not_covered";
    }
    return "failed";
  } catch {
    return "failed";
  }
}

function projectRepositoryAutomation(
  installation: InstallationRow | null,
  gitlabConnection: typeof gitlabConnections.$inferSelect | null,
  githubWebhookConfigured: boolean,
  observedAt: string,
): SetupRepositoryAutomationProvider[] {
  const github: SetupRepositoryAutomationProvider = !installation
    ? {
        provider: "github",
        adoption: "available",
        health: "not_observed",
        blockers: [],
        observedAt,
      }
    : !githubWebhookConfigured
      ? {
          provider: "github",
          adoption: "enabled",
          health: "unavailable",
          blockers: [blocker("github_app_not_configured", "operator", null)],
          observedAt,
        }
      : installation.suspendedAt
        ? {
            provider: "github",
            adoption: "enabled",
            health: "unavailable",
            blockers: [blocker("github_app_suspended", "admin", "manage_github_installation")],
            observedAt,
          }
        : !githubRepositoryAutomationEventsReady(installation.events)
          ? {
              provider: "github",
              adoption: "enabled",
              health: "unavailable",
              blockers: [blocker("github_webhook_events_missing", "operator", null)],
              observedAt,
            }
          : {
              provider: "github",
              adoption: "enabled",
              health: "ready",
              blockers: [],
              observedAt,
            };

  let gitlab: SetupRepositoryAutomationProvider;
  const gitlabReadiness = gitlabConnection ? projectGitlabConnectionReadiness(gitlabConnection) : null;
  if (!gitlabConnection) {
    gitlab = {
      provider: "gitlab",
      adoption: "available",
      health: "not_observed",
      blockers: [],
      observedAt,
    };
  } else if (gitlabReadiness === GITLAB_CONNECTION_READINESS.needsAttention) {
    gitlab = {
      provider: "gitlab",
      adoption: "enabled",
      health: "degraded",
      blockers: [blocker("gitlab_processing_failed", "admin", "configure_gitlab_webhook")],
      observedAt,
    };
  } else if (gitlabReadiness === GITLAB_CONNECTION_READINESS.waiting) {
    gitlab = {
      provider: "gitlab",
      adoption: "configuring",
      health: "pending_verification",
      blockers: [blocker("gitlab_webhook_not_seen", "admin", "configure_gitlab_webhook")],
      observedAt,
    };
  } else if (gitlabReadiness === GITLAB_CONNECTION_READINESS.transportReceived) {
    gitlab = {
      provider: "gitlab",
      adoption: "configuring",
      health: "pending_verification",
      blockers: [blocker("gitlab_merge_request_event_not_seen", "admin", "configure_gitlab_webhook")],
      observedAt,
    };
  } else {
    gitlab = {
      provider: "gitlab",
      adoption: "enabled",
      health: "ready",
      blockers: [],
      observedAt,
    };
  }

  return [github, gitlab];
}

/**
 * Project stable Team-scoped setup facts for the permanent Setup surface.
 *
 * The projection is deliberately read-only and caller-independent: Admin and
 * Member receive the same facts. The Web layer decides whether a blocker is
 * actionable for the current role; this service never persists a synthetic
 * "setup complete" bit or turns untouched optional providers into debt.
 */
export async function getTeamSetupCapabilities(
  db: Database,
  organizationId: string,
  options: SetupCapabilitiesOptions = {},
): Promise<TeamSetupCapabilities> {
  const now = options.now?.() ?? new Date();
  const observedAt = now.toISOString();
  const [runtime, installation, gitlabRows] = await Promise.all([
    getOrgContextReviewRuntime(db, organizationId),
    findInstallationByOrg(db, organizationId),
    db.select().from(gitlabConnections).where(eq(gitlabConnections.organizationId, organizationId)).limit(1),
  ]);
  const gitlabConnection = gitlabRows[0] ?? null;
  const gitlabReadiness = gitlabConnection ? projectGitlabConnectionReadiness(gitlabConnection) : null;

  const contextTreeBlockers: SetupBlocker[] = [];
  let binding: SetupContextTreeBinding;
  if (runtime.bindingState === "unbound") {
    binding = { state: "unbound" };
  } else if (runtime.bindingState === "invalid") {
    binding = { state: "invalid" };
    contextTreeBlockers.push(blocker("context_tree_binding_invalid", "admin", "repair_tree_binding"));
  } else {
    const resolution = resolveContextTreeProvider({
      repo: runtime.repo,
      declaredProvider: runtime.provider,
      gitlabInstanceOrigin: runtime.gitlabConnection?.instanceOrigin,
    });
    if (!runtime.repo || !runtime.branch || !resolution.provider || !resolution.declaredProviderMatches) {
      binding = { state: "invalid" };
      contextTreeBlockers.push(blocker("context_tree_provider_unresolved", "admin", "repair_tree_binding"));
    } else {
      binding = {
        state: "bound",
        provider: resolution.provider,
        repo: runtime.repo,
        branch: runtime.branch,
      };
    }
  }

  let reviewerAgent: SetupAutomaticReview["reviewerAgent"] = null;
  let reviewerStructurallyEligible = false;
  const reviewBlockers: SetupBlocker[] = [];
  let reviewHealth: SetupAutomaticReview["health"] = "not_observed";
  const reviewAdoption: SetupAutomaticReview["adoption"] =
    binding.state !== "bound" ? "unavailable" : runtime.contextReviewer.enabled ? "enabled" : "disabled";

  if (runtime.contextReviewer.agentUuid) {
    const agentReadiness = await readContextReviewerAgentReadiness(db, {
      organizationId,
      reviewerAgentUuid: runtime.contextReviewer.agentUuid,
      now,
      staleSeconds: options.staleSeconds ?? 60,
    });
    reviewerAgent = agentReadiness.reviewerAgent;
    reviewerStructurallyEligible = agentReadiness.structuralBlockers.length === 0;
    reviewBlockers.push(...agentReadiness.structuralBlockers, ...agentReadiness.healthBlockers);
    reviewHealth =
      agentReadiness.structuralBlockers.length > 0
        ? "unavailable"
        : agentReadiness.healthBlockers.length > 0
          ? "degraded"
          : "ready";
  }

  if (binding.state !== "bound") {
    if (reviewHealth === "ready") reviewHealth = "not_observed";
  } else if (runtime.contextReviewer.agentUuid) {
    if (binding.provider === "github") {
      if (!options.githubAppCredentials?.webhookSecret) {
        reviewBlockers.push(blocker("github_app_not_configured", "operator", null));
        reviewHealth = "unavailable";
      } else if (!installation) {
        reviewBlockers.push(blocker("context_review_provider_prerequisite_missing", "admin", "connect_github"));
        reviewHealth = "unavailable";
      } else if (installation.suspendedAt) {
        reviewBlockers.push(blocker("github_app_suspended", "admin", "manage_github_installation"));
        reviewHealth = "unavailable";
      } else if (installation.permissions.pull_requests !== "write") {
        reviewBlockers.push(blocker("github_pull_requests_permission_required", "admin", "manage_github_installation"));
        reviewHealth = "unavailable";
      } else if (!githubAutomaticReviewEventsReady(installation.events)) {
        reviewBlockers.push(blocker("github_webhook_events_missing", "operator", null));
        reviewHealth = "unavailable";
      } else if (reviewerStructurallyEligible) {
        const probe =
          options.probeGithubReview ??
          ((candidate: InstallationRow, repo: string) =>
            defaultGithubReviewProbe(candidate, repo, options.githubAppCredentials, options.githubFetch));
        let result: GithubReviewProbeResult;
        try {
          result = await probe(installation, binding.repo);
        } catch {
          result = "failed";
        }
        if (result === "permission_required") {
          reviewBlockers.push(
            blocker("github_pull_requests_permission_required", "admin", "manage_github_installation"),
          );
          reviewHealth = "unavailable";
        } else if (result === "repo_not_covered") {
          reviewBlockers.push(blocker("github_tree_repo_not_covered", "admin", "manage_github_installation"));
          reviewHealth = "unavailable";
        } else if (result === "failed") {
          reviewBlockers.push(blocker("provider_probe_failed", "operator", null));
          if (reviewHealth === "ready") reviewHealth = "pending_verification";
        }
      }
    } else if (
      !gitlabConnection ||
      !runtime.providerMatchesRepository ||
      runtime.gitlabConnection?.id !== gitlabConnection.id
    ) {
      reviewBlockers.push(
        blocker(
          gitlabConnection ? "context_tree_connection_mismatch" : "context_review_provider_prerequisite_missing",
          "admin",
          gitlabConnection ? "repair_tree_binding" : "connect_gitlab",
        ),
      );
      reviewHealth = "unavailable";
    } else if (gitlabReadiness === GITLAB_CONNECTION_READINESS.needsAttention) {
      reviewBlockers.push(blocker("gitlab_processing_failed", "admin", "configure_gitlab_webhook"));
      if (reviewHealth === "ready") reviewHealth = "degraded";
    } else if (gitlabReadiness === GITLAB_CONNECTION_READINESS.waiting) {
      reviewBlockers.push(blocker("gitlab_webhook_not_seen", "admin", "configure_gitlab_webhook"));
      if (reviewHealth === "ready") reviewHealth = "pending_verification";
    } else if (gitlabReadiness === GITLAB_CONNECTION_READINESS.transportReceived) {
      reviewBlockers.push(blocker("gitlab_merge_request_event_not_seen", "admin", "configure_gitlab_webhook"));
      if (reviewHealth === "ready") reviewHealth = "pending_verification";
    }
  }

  return teamSetupCapabilitiesSchema.parse({
    organizationId,
    repositoryAutomation: {
      providers: projectRepositoryAutomation(
        installation,
        gitlabConnection,
        Boolean(options.githubAppCredentials?.webhookSecret),
        observedAt,
      ),
    },
    contextTree: {
      binding,
      blockers: contextTreeBlockers,
      automaticReview: {
        adoption: reviewAdoption,
        health: reviewHealth,
        reviewerAgent,
        blockers: reviewBlockers,
        observedAt,
      },
    },
  });
}
