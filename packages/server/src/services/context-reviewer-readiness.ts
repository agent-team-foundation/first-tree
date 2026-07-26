import {
  AGENT_STATUSES,
  AGENT_TYPES,
  AGENT_VISIBILITY,
  type ContextReviewerCandidate,
  clientCapabilitiesSchema,
  isRuntimeProviderEnabled,
  runtimeProviderSchema,
  type SetupBlocker,
} from "@first-tree/shared";
import { and, asc, eq, ne } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { agentNotLandingCampaignTrialCondition } from "./access-control.js";

export type ContextReviewerAgentReadiness = {
  reviewerAgent: { uuid: string; displayName: string } | null;
  structuralBlockers: SetupBlocker[];
  healthBlockers: SetupBlocker[];
};

function blocker(code: SetupBlocker["code"], actionKind: SetupBlocker["actionKind"]): SetupBlocker {
  return { code, resolutionOwner: "admin", actionKind };
}

async function readDynamicRuntimeHealth(
  db: Database,
  input: {
    agentUuid: string;
    runtimeProvider: string;
    client: typeof clients.$inferSelect;
    now: Date;
    staleSeconds: number;
  },
): Promise<SetupBlocker[]> {
  const [presence] = await db.select().from(agentPresence).where(eq(agentPresence.agentId, input.agentUuid)).limit(1);
  const staleMs = input.staleSeconds * 1_000;
  const routeUnavailable =
    input.client.pausedReason !== null ||
    input.client.status !== "connected" ||
    !input.client.instanceId ||
    input.now.getTime() - input.client.lastSeenAt.getTime() > staleMs ||
    !presence ||
    presence.status !== "online" ||
    presence.clientId !== input.client.id ||
    presence.instanceId !== input.client.instanceId ||
    input.now.getTime() - presence.lastSeenAt.getTime() > staleMs ||
    (presence.runtimeState !== "idle" && presence.runtimeState !== "working");
  if (routeUnavailable || !input.client.instanceId) {
    return [blocker("context_review_agent_runtime_unavailable", "open_agent_owner_flow")];
  }

  const [instance] = await db
    .select({ lastHeartbeat: serverInstances.lastHeartbeat })
    .from(serverInstances)
    .where(eq(serverInstances.instanceId, input.client.instanceId))
    .limit(1);
  if (!instance || input.now.getTime() - instance.lastHeartbeat.getTime() > staleMs) {
    return [blocker("context_review_agent_runtime_unavailable", "open_agent_owner_flow")];
  }

  const capabilities = clientCapabilitiesSchema.safeParse(input.client.metadata?.capabilities);
  const capability = capabilities.success ? capabilities.data[input.runtimeProvider] : undefined;
  if (
    presence.runtimeType !== input.runtimeProvider ||
    !capability ||
    capability.state !== "ok" ||
    capability.available !== true
  ) {
    return [blocker("context_review_agent_runtime_unavailable", "open_agent_owner_flow")];
  }
  return [];
}

/**
 * Split stable assignment eligibility from transient runtime health.
 *
 * Structural blockers prevent assignment/enablement. Dynamic health blockers
 * never rewrite or disable the setting; capability projection reports them and
 * webhook dispatch uses them as a fail-closed per-run gate.
 */
export async function readContextReviewerAgentReadiness(
  db: Database,
  input: {
    organizationId: string;
    reviewerAgentUuid: string;
    now: Date;
    staleSeconds: number;
  },
): Promise<ContextReviewerAgentReadiness> {
  const [agent] = await db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      status: agents.status,
      displayName: agents.displayName,
      visibility: agents.visibility,
      managerOrganizationId: members.organizationId,
      managerStatus: members.status,
      managerUserId: members.userId,
      clientId: agents.clientId,
      runtimeProvider: agents.runtimeProvider,
    })
    .from(agents)
    .leftJoin(members, eq(members.id, agents.managerId))
    .where(and(eq(agents.uuid, input.reviewerAgentUuid), agentNotLandingCampaignTrialCondition()))
    .limit(1);

  if (!agent || agent.organizationId !== input.organizationId || agent.type === AGENT_TYPES.HUMAN) {
    return {
      reviewerAgent: null,
      structuralBlockers: [blocker("context_review_agent_missing", "replace_review_agent")],
      healthBlockers: [],
    };
  }

  const reviewerAgent = { uuid: agent.uuid, displayName: agent.displayName };
  if (agent.status !== AGENT_STATUSES.ACTIVE) {
    return {
      reviewerAgent,
      structuralBlockers: [blocker("context_review_agent_inactive", "replace_review_agent")],
      healthBlockers: [],
    };
  }
  if (
    agent.managerOrganizationId !== input.organizationId ||
    agent.managerStatus !== "active" ||
    !agent.managerUserId
  ) {
    return {
      reviewerAgent,
      structuralBlockers: [blocker("context_review_agent_manager_inactive", "open_agent_owner_flow")],
      healthBlockers: [],
    };
  }
  if (agent.visibility !== AGENT_VISIBILITY.ORGANIZATION) {
    return {
      // Capability projection is member-readable. Never disclose the identity
      // of an invalid historical private selection as a Team-wide fact.
      reviewerAgent: null,
      structuralBlockers: [blocker("context_review_agent_private", "replace_review_agent")],
      healthBlockers: [],
    };
  }
  if (
    !agent.clientId ||
    !runtimeProviderSchema.safeParse(agent.runtimeProvider).success ||
    !isRuntimeProviderEnabled(agent.runtimeProvider)
  ) {
    return {
      reviewerAgent,
      structuralBlockers: [blocker("context_review_agent_no_runtime", "open_agent_owner_flow")],
      healthBlockers: [],
    };
  }

  const [client] = await db.select().from(clients).where(eq(clients.id, agent.clientId)).limit(1);
  if (
    !client ||
    client.organizationId !== input.organizationId ||
    client.userId !== agent.managerUserId ||
    client.retiredAt !== null
  ) {
    return {
      reviewerAgent,
      structuralBlockers: [blocker("context_review_agent_no_runtime", "open_agent_owner_flow")],
      healthBlockers: [],
    };
  }

  return {
    reviewerAgent,
    structuralBlockers: [],
    healthBlockers: await readDynamicRuntimeHealth(db, {
      agentUuid: agent.uuid,
      runtimeProvider: agent.runtimeProvider,
      client,
      now: input.now,
      staleSeconds: input.staleSeconds,
    }),
  };
}

/** Admin-only list of structurally eligible, organization-visible Reviewers. */
export async function listContextReviewerCandidates(
  db: Database,
  input: {
    organizationId: string;
    now: Date;
    staleSeconds: number;
  },
): Promise<{ items: ContextReviewerCandidate[]; blockers: SetupBlocker[] }> {
  const rows = await db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      displayName: agents.displayName,
      visibility: agents.visibility,
    })
    .from(agents)
    .innerJoin(
      members,
      and(
        eq(members.id, agents.managerId),
        eq(members.organizationId, input.organizationId),
        eq(members.status, "active"),
      ),
    )
    .where(
      and(
        eq(agents.organizationId, input.organizationId),
        eq(agents.visibility, AGENT_VISIBILITY.ORGANIZATION),
        eq(agents.status, AGENT_STATUSES.ACTIVE),
        ne(agents.type, AGENT_TYPES.HUMAN),
        agentNotLandingCampaignTrialCondition(),
      ),
    )
    .orderBy(asc(agents.createdAt), asc(agents.uuid));

  const candidates = await Promise.all(
    rows.map(async (row) => ({
      row,
      readiness: await readContextReviewerAgentReadiness(db, {
        organizationId: input.organizationId,
        reviewerAgentUuid: row.uuid,
        now: input.now,
        staleSeconds: input.staleSeconds,
      }),
    })),
  );
  const items = candidates.flatMap(({ row, readiness }): ContextReviewerCandidate[] =>
    readiness.structuralBlockers.length > 0
      ? []
      : [
          {
            uuid: row.uuid,
            name: row.name,
            displayName: row.displayName,
            visibility: AGENT_VISIBILITY.ORGANIZATION,
            runtime: {
              health: readiness.healthBlockers.length === 0 ? "ready" : "degraded",
              blockers: readiness.healthBlockers,
            },
          },
        ],
  );
  return {
    items,
    blockers: items.length === 0 ? [blocker("context_review_no_eligible_agent", "open_agent_owner_flow")] : [],
  };
}
