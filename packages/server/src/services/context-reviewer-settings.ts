import {
  AGENT_STATUSES,
  AGENT_TYPES,
  AGENT_VISIBILITY,
  isRuntimeProviderEnabled,
  ORG_SETTINGS_NAMESPACES,
  type OrgContextTreeFeaturesOutput,
  type OrgContextTreeFeaturesStorage,
  orgContextTreeFeaturesInputSchema,
  runtimeProviderSchema,
  type SetupBlocker,
} from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { organizations } from "../db/schema/organizations.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { agentNotLandingCampaignTrialCondition } from "./access-control.js";
import { findInstallationByOrg } from "./github-app-installations.js";
import { getOrgContextReviewRuntime, getOrgSetting, isOrgContextReviewRuntimeCurrent } from "./org-settings.js";
import {
  type GithubReviewCredentials,
  type GithubReviewProbeResult,
  getTeamSetupCapabilities,
} from "./setup-capabilities.js";

export type ContextReviewerMutationOptions = {
  updatedBy: string;
  staleSeconds: number;
  expectedAgentUuid?: string;
  githubAppCredentials?: GithubReviewCredentials;
  githubFetch?: typeof fetch;
  probeGithubReview?: (
    installation: typeof githubAppInstallations.$inferSelect,
    repo: string,
  ) => Promise<GithubReviewProbeResult>;
  now?: () => Date;
};

export class ContextReviewerReadinessError extends ConflictError {
  constructor(
    readonly blocker: SetupBlocker,
    message = "Context Reviewer is not ready",
  ) {
    super(message, { code: blocker.code });
    this.name = "ContextReviewerReadinessError";
  }
}

function blocker(
  code: SetupBlocker["code"],
  actionKind: SetupBlocker["actionKind"],
  resolutionOwner: SetupBlocker["resolutionOwner"] = "admin",
): SetupBlocker {
  return { code, resolutionOwner, actionKind };
}

function fail(blockerValue: SetupBlocker, message?: string): never {
  throw new ContextReviewerReadinessError(blockerValue, message);
}

async function lockOrganization(db: Database, organizationId: string): Promise<void> {
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update")
    .limit(1);
  if (!row) throw new NotFoundError(`Organization "${organizationId}" not found`);
}

async function readStorage(db: Database, organizationId: string): Promise<OrgContextTreeFeaturesStorage> {
  const [row] = await db
    .select({ value: organizationSettings.value })
    .from(organizationSettings)
    .where(
      and(
        eq(organizationSettings.organizationId, organizationId),
        eq(organizationSettings.namespace, "context_tree_features"),
      ),
    )
    .limit(1);
  return ORG_SETTINGS_NAMESPACES.context_tree_features.storage.parse(row?.value ?? {});
}

function sameStorage(left: OrgContextTreeFeaturesStorage, right: OrgContextTreeFeaturesStorage): boolean {
  return (
    left.contextReviewer.enabled === right.contextReviewer.enabled &&
    left.contextReviewer.agentUuid === right.contextReviewer.agentUuid
  );
}

async function writeStorage(
  db: Database,
  organizationId: string,
  current: OrgContextTreeFeaturesStorage,
  next: OrgContextTreeFeaturesStorage,
  updatedBy: string,
): Promise<void> {
  const validated = ORG_SETTINGS_NAMESPACES.context_tree_features.storage.parse(next);
  if (sameStorage(current, validated)) return;
  await db
    .insert(organizationSettings)
    .values({
      organizationId,
      namespace: "context_tree_features",
      value: validated,
      version: 1,
      updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [organizationSettings.organizationId, organizationSettings.namespace],
      set: {
        value: validated,
        version: sql`${organizationSettings.version} + 1`,
        updatedBy,
        updatedAt: new Date(),
      },
    });
}

async function readAssignableAgentForUpdate(
  db: Database,
  input: { organizationId: string; agentUuid: string },
): Promise<{ uuid: string }> {
  const [snapshot] = await db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      managerId: agents.managerId,
      clientId: agents.clientId,
    })
    .from(agents)
    .where(and(eq(agents.uuid, input.agentUuid), agentNotLandingCampaignTrialCondition()))
    .limit(1);

  if (!snapshot || snapshot.organizationId !== input.organizationId || snapshot.type === AGENT_TYPES.HUMAN) {
    fail(blocker("context_review_agent_missing", "replace_review_agent"));
  }

  const [manager] = await db
    .select({
      organizationId: members.organizationId,
      status: members.status,
      userId: members.userId,
    })
    .from(members)
    .where(eq(members.id, snapshot.managerId))
    .for("update")
    .limit(1);

  const [client] = snapshot.clientId
    ? await db.select().from(clients).where(eq(clients.id, snapshot.clientId)).for("update").limit(1)
    : [];

  const [agent] = await db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      status: agents.status,
      visibility: agents.visibility,
      managerId: agents.managerId,
      clientId: agents.clientId,
      runtimeProvider: agents.runtimeProvider,
    })
    .from(agents)
    .where(and(eq(agents.uuid, input.agentUuid), agentNotLandingCampaignTrialCondition()))
    .for("update")
    .limit(1);
  if (!agent || agent.organizationId !== input.organizationId || agent.type === AGENT_TYPES.HUMAN) {
    fail(blocker("context_review_agent_missing", "replace_review_agent"));
  }
  if (agent.managerId !== snapshot.managerId || agent.clientId !== snapshot.clientId) {
    fail(
      blocker("context_review_state_changed", "manage_review_agent"),
      "Reviewer ownership or Computer binding changed; retry with current Team state",
    );
  }
  if (agent.status !== AGENT_STATUSES.ACTIVE) {
    fail(blocker("context_review_agent_inactive", "replace_review_agent"));
  }
  if (manager?.organizationId !== input.organizationId || manager.status !== "active") {
    fail(blocker("context_review_agent_manager_inactive", "open_agent_owner_flow"));
  }
  if (agent.visibility !== AGENT_VISIBILITY.ORGANIZATION) {
    fail(blocker("context_review_agent_private", "replace_review_agent"));
  }
  if (
    !agent.clientId ||
    !runtimeProviderSchema.safeParse(agent.runtimeProvider).success ||
    !isRuntimeProviderEnabled(agent.runtimeProvider)
  ) {
    fail(blocker("context_review_agent_no_runtime", "open_agent_owner_flow"));
  }
  if (
    !client ||
    client.organizationId !== input.organizationId ||
    client.userId !== manager.userId ||
    client.retiredAt !== null
  ) {
    fail(blocker("context_review_agent_no_runtime", "open_agent_owner_flow"));
  }
  return { uuid: agent.uuid };
}

async function readGithubInstallationIdForUpdate(db: Database, organizationId: string): Promise<number | null> {
  const [installation] = await db
    .select({ installationId: githubAppInstallations.installationId })
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.hubOrganizationId, organizationId))
    .for("update")
    .limit(1);
  return installation?.installationId ?? null;
}

async function lockGitlabConnectionForUpdate(
  db: Database,
  input: { organizationId: string; expectedConnectionId: string | null },
): Promise<void> {
  const [connection] = await db
    .select({ id: gitlabConnections.id })
    .from(gitlabConnections)
    .where(eq(gitlabConnections.organizationId, input.organizationId))
    .for("update")
    .limit(1);
  if (!connection || connection.id !== input.expectedConnectionId) {
    fail(
      blocker("context_review_state_changed", "connect_gitlab"),
      "GitLab connection changed during enablement; retry with current Team state",
    );
  }
}

export async function putContextReviewerAssignment(
  db: Database,
  organizationId: string,
  agentUuid: string | null,
  options: Pick<ContextReviewerMutationOptions, "updatedBy">,
): Promise<OrgContextTreeFeaturesOutput> {
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockOrganization(txDb, organizationId);
    const current = await readStorage(txDb, organizationId);

    if (agentUuid === null) {
      await writeStorage(
        txDb,
        organizationId,
        current,
        {
          contextReviewer: {
            enabled: false,
            agentUuid: null,
          },
        },
        options.updatedBy,
      );
      return;
    }

    const agent = await readAssignableAgentForUpdate(txDb, {
      organizationId,
      agentUuid,
    });
    const sameAgent = current.contextReviewer.agentUuid === agent.uuid;
    if (sameAgent) return;

    await writeStorage(
      txDb,
      organizationId,
      current,
      {
        contextReviewer: {
          enabled: false,
          agentUuid: agent.uuid,
        },
      },
      options.updatedBy,
    );
  });

  return getOrgSetting(db, organizationId, "context_tree_features");
}

function firstReadinessBlocker(
  capabilities: Awaited<ReturnType<typeof getTeamSetupCapabilities>>,
): SetupBlocker | null {
  if (capabilities.contextTree.binding.state !== "bound") {
    return (
      capabilities.contextTree.blockers[0] ??
      blocker("context_review_provider_prerequisite_missing", "open_tree_setup_chat")
    );
  }
  return (
    capabilities.contextTree.automaticReview.blockers.find(
      (candidate) => candidate.code !== "context_review_agent_runtime_unavailable",
    ) ?? null
  );
}

async function assertReady(
  db: Database,
  organizationId: string,
  options: ContextReviewerMutationOptions,
): Promise<void> {
  const capabilities = await getTeamSetupCapabilities(db, organizationId, {
    now: options.now,
    staleSeconds: options.staleSeconds,
    githubAppCredentials: options.githubAppCredentials,
    githubFetch: options.githubFetch,
    probeGithubReview: options.probeGithubReview,
  });
  const selected = capabilities.contextTree.automaticReview.reviewerAgent;
  if (!selected) {
    const runtime = await getOrgContextReviewRuntime(db, organizationId);
    if (!runtime.contextReviewer.agentUuid) {
      fail(blocker("context_review_assignment_required", "select_review_agent"));
    }
  }
  const readinessBlocker = firstReadinessBlocker(capabilities);
  if (readinessBlocker) fail(readinessBlocker);
}

export async function putContextReviewerEnablement(
  db: Database,
  organizationId: string,
  enabled: boolean,
  options: ContextReviewerMutationOptions,
): Promise<OrgContextTreeFeaturesOutput> {
  if (!enabled) {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      await lockOrganization(txDb, organizationId);
      const current = await readStorage(txDb, organizationId);
      await writeStorage(
        txDb,
        organizationId,
        current,
        {
          contextReviewer: {
            ...current.contextReviewer,
            enabled: false,
          },
        },
        options.updatedBy,
      );
    });
    return getOrgSetting(db, organizationId, "context_tree_features");
  }

  const expectedRuntime = await getOrgContextReviewRuntime(db, organizationId);
  if (!expectedRuntime.contextReviewer.agentUuid) {
    fail(blocker("context_review_assignment_required", "select_review_agent"));
  }
  if (
    options.expectedAgentUuid !== undefined &&
    expectedRuntime.contextReviewer.agentUuid !== options.expectedAgentUuid
  ) {
    fail(
      blocker("context_review_state_changed", "manage_review_agent"),
      "Context Reviewer assignment changed before enablement; retry with current Team state",
    );
  }
  const expectedAgentUuid = expectedRuntime.contextReviewer.agentUuid;
  const expectedInstallation = await findInstallationByOrg(db, organizationId);
  await assertReady(db, organizationId, options);

  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockOrganization(txDb, organizationId);
    if (!(await isOrgContextReviewRuntimeCurrent(txDb, organizationId, expectedRuntime))) {
      fail(
        blocker("context_review_state_changed", "manage_review_agent"),
        "Context Reviewer state changed during enablement; retry with current Team state",
      );
    }
    if (expectedRuntime.provider === "gitlab") {
      await lockGitlabConnectionForUpdate(txDb, {
        organizationId,
        expectedConnectionId: expectedRuntime.gitlabConnection?.id ?? null,
      });
    }
    await readAssignableAgentForUpdate(txDb, {
      organizationId,
      agentUuid: expectedAgentUuid,
    });
    const currentInstallationId =
      expectedRuntime.provider === "github" ? await readGithubInstallationIdForUpdate(txDb, organizationId) : null;
    if (expectedRuntime.provider === "github" && currentInstallationId !== expectedInstallation?.installationId) {
      fail(
        blocker("context_review_state_changed", "manage_github_installation"),
        "GitHub installation changed during enablement; retry with current Team state",
      );
    }

    // The exact-repository GitHub probe completed before this short
    // transaction. Reuse only its successful result after checking that the
    // selected assignment, binding, and installation identity are unchanged;
    // every local Agent/runtime/provider fact is queried again here.
    await assertReady(txDb, organizationId, {
      ...options,
      probeGithubReview: expectedRuntime.provider === "github" ? async () => "ready" : options.probeGithubReview,
    });

    const current = await readStorage(txDb, organizationId);
    await writeStorage(
      txDb,
      organizationId,
      current,
      {
        contextReviewer: {
          ...current.contextReviewer,
          enabled: true,
        },
      },
      options.updatedBy,
    );
  });

  return getOrgSetting(db, organizationId, "context_tree_features");
}

/**
 * Transitional bridge for the existing Repositories toggle. It deliberately
 * composes the two narrow mutations so a failed enable leaves the selected
 * Agent persisted and disabled, while Context Tree binding remains untouched.
 */
export async function putLegacyContextReviewerSetting(
  db: Database,
  organizationId: string,
  rawInput: unknown,
  options: ContextReviewerMutationOptions,
): Promise<OrgContextTreeFeaturesOutput> {
  const input = orgContextTreeFeaturesInputSchema.parse(rawInput).contextReviewer;
  if (input.agentUuid) {
    await putContextReviewerAssignment(db, organizationId, input.agentUuid, options);
  }
  return putContextReviewerEnablement(db, organizationId, input.enabled, {
    ...options,
    expectedAgentUuid: input.enabled && input.agentUuid ? input.agentUuid : undefined,
  });
}
