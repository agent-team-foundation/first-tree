import { createHash } from "node:crypto";
import {
  AGENT_VISIBILITY,
  canonicalGitRepoIdentity,
  isRuntimeProviderEnabled,
  runtimeProviderSchema,
} from "@first-tree/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { agentNotLandingCampaignTrialCondition } from "./access-control.js";
import { readContextReviewerAgentReadiness } from "./context-reviewer-readiness.js";
import { getOrgContextReviewRuntime } from "./org-settings.js";
import { githubAutomaticReviewEventsReady } from "./setup-capabilities.js";

export type ContextReviewerAgent = {
  uuid: string;
  managerHumanAgentId: string;
  managerGithubLogin: string | null;
};

export type ContextReviewerDispatchAuthority =
  | {
      provider: "github";
      installationId: number;
      repository: string;
    }
  | {
      provider: "gitlab";
      connectionId: string;
      instanceOrigin: string;
      tokenHash: string;
    };

export function contextReviewerChatReservationKey(organizationId: string, entityKey: string): string {
  const digest = createHash("sha256").update(`${organizationId}\0${entityKey}`).digest("hex");
  return `context-review:${digest}`;
}

export async function loadValidContextReviewerAgent(
  db: Database,
  input: { organizationId: string; reviewerAgentUuid: string },
): Promise<ContextReviewerAgent | null> {
  const [agent] = await db
    .select({
      uuid: agents.uuid,
      visibility: agents.visibility,
      managerId: agents.managerId,
      runtimeProvider: agents.runtimeProvider,
      clientId: clients.id,
      clientOrganizationId: clients.organizationId,
      clientUserId: clients.userId,
      clientRetiredAt: clients.retiredAt,
      managerUserId: members.userId,
      managerHumanAgentId: members.agentId,
      managerGithubLogin: sql<string | null>`${authIdentities.metadata}->>'login'`,
    })
    .from(agents)
    .innerJoin(members, eq(members.id, agents.managerId))
    .leftJoin(clients, eq(clients.id, agents.clientId))
    .leftJoin(authIdentities, and(eq(authIdentities.userId, members.userId), eq(authIdentities.provider, "github")))
    .where(
      and(
        eq(agents.uuid, input.reviewerAgentUuid),
        eq(agents.organizationId, input.organizationId),
        eq(agents.type, "agent"),
        eq(agents.status, "active"),
        agentNotLandingCampaignTrialCondition(),
        eq(members.organizationId, input.organizationId),
        eq(members.status, "active"),
      ),
    )
    .limit(1);
  if (!agent) return null;
  if (agent.visibility !== AGENT_VISIBILITY.ORGANIZATION) return null;
  if (
    !runtimeProviderSchema.safeParse(agent.runtimeProvider).success ||
    !isRuntimeProviderEnabled(agent.runtimeProvider) ||
    !agent.clientId ||
    agent.clientOrganizationId !== input.organizationId ||
    agent.clientUserId !== agent.managerUserId ||
    agent.clientRetiredAt !== null
  ) {
    return null;
  }
  return agent;
}

/**
 * Make the last authority decision in the transaction that persists a trusted
 * Context Review run. The earlier handler reads are cheap routing checks only;
 * this fence prevents a concurrent disable, reassignment, privacy/lifecycle
 * change, runtime loss, Tree rebind, or provider revocation from authorizing a
 * stale run.
 */
export async function withContextReviewerDispatchAuthority<T>(
  db: Database,
  input: {
    organizationId: string;
    reviewerAgentUuid: string;
    entityKey: string;
    expectedManagerHumanAgentId?: string;
    staleSeconds: number;
    now?: Date;
    authority: ContextReviewerDispatchAuthority;
  },
  callback: (tx: Database, reviewer: ContextReviewerAgent) => Promise<T>,
): Promise<{ authorized: true; value: T } | { authorized: false }> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;

    const reservationKey = contextReviewerChatReservationKey(input.organizationId, input.entityKey);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('context_reviewer_dispatch'), hashtext(${reservationKey}))`,
    );

    const [snapshot] = await tx
      .select({
        uuid: agents.uuid,
        managerId: agents.managerId,
        clientId: agents.clientId,
      })
      .from(agents)
      .where(and(eq(agents.uuid, input.reviewerAgentUuid), agentNotLandingCampaignTrialCondition()))
      .limit(1);
    if (!snapshot) return { authorized: false };

    await tx.select({ id: members.id }).from(members).where(eq(members.id, snapshot.managerId)).for("update").limit(1);
    const [client] = snapshot.clientId
      ? await tx.select().from(clients).where(eq(clients.id, snapshot.clientId)).for("update").limit(1)
      : [];

    const [agent] = await tx
      .select({
        uuid: agents.uuid,
        managerId: agents.managerId,
        clientId: agents.clientId,
      })
      .from(agents)
      .where(and(eq(agents.uuid, input.reviewerAgentUuid), agentNotLandingCampaignTrialCondition()))
      .for("update")
      .limit(1);
    if (!agent || agent.managerId !== snapshot.managerId || agent.clientId !== snapshot.clientId) {
      return { authorized: false };
    }

    await tx
      .select({ agentId: agentPresence.agentId })
      .from(agentPresence)
      .where(eq(agentPresence.agentId, agent.uuid))
      .for("update")
      .limit(1);
    if (client?.instanceId) {
      await tx
        .select({ instanceId: serverInstances.instanceId })
        .from(serverInstances)
        .where(eq(serverInstances.instanceId, client.instanceId))
        .for("update")
        .limit(1);
    }

    if (input.authority.provider === "github") {
      const [installation] = await tx
        .select()
        .from(githubAppInstallations)
        .where(eq(githubAppInstallations.hubOrganizationId, input.organizationId))
        .for("update")
        .limit(1);
      const repositoryOwner = input.authority.repository.split("/")[0]?.toLowerCase();
      if (
        !installation ||
        installation.installationId !== input.authority.installationId ||
        installation.suspendedAt !== null ||
        installation.permissions.pull_requests !== "write" ||
        !githubAutomaticReviewEventsReady(installation.events) ||
        !repositoryOwner ||
        installation.accountLogin.toLowerCase() !== repositoryOwner
      ) {
        return { authorized: false };
      }
    } else {
      const [connection] = await tx
        .select()
        .from(gitlabConnections)
        .where(eq(gitlabConnections.id, input.authority.connectionId))
        .for("update")
        .limit(1);
      if (
        !connection ||
        connection.organizationId !== input.organizationId ||
        connection.instanceOrigin !== input.authority.instanceOrigin ||
        connection.tokenHash !== input.authority.tokenHash
      ) {
        return { authorized: false };
      }
    }

    const lockedSettings = await tx
      .select({ namespace: organizationSettings.namespace })
      .from(organizationSettings)
      .where(
        and(
          eq(organizationSettings.organizationId, input.organizationId),
          inArray(organizationSettings.namespace, ["context_tree", "context_tree_features"]),
        ),
      )
      .for("update");
    if (
      !lockedSettings.some((row) => row.namespace === "context_tree") ||
      !lockedSettings.some((row) => row.namespace === "context_tree_features")
    ) {
      return { authorized: false };
    }

    const runtime = await getOrgContextReviewRuntime(tx, input.organizationId);
    if (
      runtime.bindingState !== "bound" ||
      !runtime.providerMatchesRepository ||
      runtime.provider !== input.authority.provider ||
      !runtime.contextReviewer.enabled ||
      runtime.contextReviewer.agentUuid !== input.reviewerAgentUuid
    ) {
      return { authorized: false };
    }
    if (input.authority.provider === "github") {
      const identity = canonicalGitRepoIdentity(runtime.repo);
      if (identity?.host !== "github.com" || identity.path !== input.authority.repository.trim().toLowerCase()) {
        return { authorized: false };
      }
    } else if (
      runtime.gitlabConnection?.id !== input.authority.connectionId ||
      runtime.gitlabConnection.instanceOrigin !== input.authority.instanceOrigin
    ) {
      return { authorized: false };
    }

    const readiness = await readContextReviewerAgentReadiness(tx, {
      organizationId: input.organizationId,
      reviewerAgentUuid: input.reviewerAgentUuid,
      now: input.now ?? new Date(),
      staleSeconds: input.staleSeconds,
    });
    if (readiness.structuralBlockers.length > 0 || readiness.healthBlockers.length > 0) {
      return { authorized: false };
    }
    const reviewer = await loadValidContextReviewerAgent(tx, {
      organizationId: input.organizationId,
      reviewerAgentUuid: input.reviewerAgentUuid,
    });
    if (
      !reviewer ||
      (input.expectedManagerHumanAgentId !== undefined &&
        reviewer.managerHumanAgentId !== input.expectedManagerHumanAgentId)
    ) {
      return { authorized: false };
    }

    return { authorized: true, value: await callback(tx, reviewer) };
  });
}

export async function findExistingContextReviewerChat(
  db: Database,
  input: { organizationId: string; entityKey: string },
): Promise<string | null> {
  const reservationKey = contextReviewerChatReservationKey(input.organizationId, input.entityKey);
  const [row] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.organizationId, input.organizationId), eq(chats.onboardingKickoffKey, reservationKey)))
    .limit(1);
  return row?.id ?? null;
}
