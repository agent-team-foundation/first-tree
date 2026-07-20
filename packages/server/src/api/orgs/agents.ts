import {
  AGENT_TYPES,
  agentPinnedMessageSchema,
  createAgentSchema,
  listAgentsQuerySchema,
  newChatDefaultCandidatesRequestSchema,
  paginationQuerySchema,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError, ForbiddenError } from "../../errors.js";
import { requireOrgMembership } from "../../scope/require-org.js";
import * as agentService from "../../services/agent.js";
import { resolveAvatarImageUrl } from "../../services/agent.js";
import { requireProvisioningActor } from "../../services/agent-provisioning.js";
import { sendToClient } from "../../services/connection-manager.js";
import { assertMetadataDoesNotClaimLandingCampaignTrial } from "../../services/landing-campaigns/guards.js";

function serializeNewChatDefaultCandidate(agent: agentService.NewChatDefaultCandidateAgent) {
  return { ...agent, createdAt: agent.createdAt.toISOString() };
}

/**
 * Class B — org-scoped agent collection routes.
 * Mounted at `/api/v1/orgs/:orgId/agents`. Per-agent operations (`:uuid`)
 * are Class C and live in `api/agents.ts`.
 */
export async function orgAgentRoutes(app: FastifyInstance): Promise<void> {
  function notifyClientAgentPinned(agent: {
    uuid: string;
    name: string | null;
    displayName: string | null;
    type: string;
    clientId: string | null;
    runtimeProvider: string;
  }): void {
    if (!agent.clientId) return;
    const parsed = agentPinnedMessageSchema.safeParse({
      type: "agent:pinned",
      agentId: agent.uuid,
      name: agent.name,
      displayName: agent.displayName,
      // Wire-compat: translate `type=agent` back to the pre-merge
      // `personal_assistant` so clients on ≤ 0.5.1 (strict zod) still
      // decode the frame. See agentService.legacyWireAgentType.
      agentType: agentService.legacyWireAgentType(agent.type),
      runtimeProvider: agent.runtimeProvider,
    });
    if (!parsed.success) {
      app.log.warn(
        { err: parsed.error.flatten(), agentId: agent.uuid, clientId: agent.clientId },
        "agent:pinned frame failed schema validation — not sending",
      );
      return;
    }
    sendToClient(agent.clientId, parsed.data);
  }

  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const { limit, cursor, type, query, addressableOnly } = listAgentsQuerySchema.parse(request.query);
    const result = await agentService.listAgentsForMember(app.db, scope, limit, cursor, type, query, addressableOnly);
    return {
      items: result.items.map(({ avatarImageUpdatedAt, userAvatarUrl, ...a }) => ({
        ...a,
        metadata: agentService.stripReservedAgentMetadata(a.metadata),
        managerId: a.managerId ?? null,
        presenceStatus: a.presenceStatus ?? "offline",
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        clientId: a.clientId ?? null,
        runtimeType: a.runtimeType ?? null,
        runtimeState: a.runtimeState ?? null,
        activeSessions: a.activeSessions ?? null,
        lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
        avatarImageUrl: resolveAvatarImageUrl({
          uuid: a.uuid,
          type: a.type,
          avatarImageUpdatedAt,
          userAvatarUrl,
        }),
      })),
      nextCursor: result.nextCursor,
    };
  });

  /**
   * Admin-only: every agent in the org, ignoring the visibility filter
   * applied on the regular list. Surfaces private agents owned by other
   * members so an admin can reassign / troubleshoot.
   */
  app.get<{ Params: { orgId: string } }>("/all", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    if (scope.role !== "admin") {
      throw new ForbiddenError("Admin role required");
    }
    const query = paginationQuerySchema.parse(request.query);
    const result = await agentService.listAgentsForAdmin(app.db, scope, query.limit, query.cursor);
    return {
      items: result.items.map(({ avatarImageUpdatedAt, userAvatarUrl, ...a }) => ({
        ...a,
        metadata: agentService.stripReservedAgentMetadata(a.metadata),
        managerId: a.managerId ?? null,
        presenceStatus: a.presenceStatus ?? "offline",
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        clientId: a.clientId ?? null,
        runtimeType: a.runtimeType ?? null,
        runtimeState: a.runtimeState ?? null,
        activeSessions: a.activeSessions ?? null,
        lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
        avatarImageUrl: resolveAvatarImageUrl({
          uuid: a.uuid,
          type: a.type,
          avatarImageUpdatedAt,
          userAvatarUrl,
        }),
      })),
      nextCursor: result.nextCursor,
    };
  });

  app.post<{ Params: { orgId: string } }>("/new-chat-default-candidates", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const body = newChatDefaultCandidatesRequestSchema.parse(request.body ?? {});
    const result = await agentService.getNewChatDefaultCandidate(app.db, scope, body.cachedAgentId);
    return {
      agent: result.agent ? serializeNewChatDefaultCandidate(result.agent) : null,
    };
  });

  /**
   * Pre-create availability probe for the web creation form. Pure UX
   * convenience; the regular POST still validates authoritatively.
   */
  app.get<{ Params: { orgId: string; name: string } }>("/names/:name/availability", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    return agentService.checkAgentNameAvailability(app.db, scope.organizationId, request.params.name);
  });

  app.post<{ Params: { orgId: string } }>("/", { config: { otelRecordBody: true } }, async (request, reply) => {
    const scope = await requireOrgMembership(request, app.db);
    const provisioningActor = await requireProvisioningActor(app.db, request, scope.organizationId, scope.userId);
    const body = createAgentSchema.parse(request.body);
    if (body.type === AGENT_TYPES.HUMAN) {
      throw new BadRequestError("Human agents are created through the member lifecycle");
    }
    assertMetadataDoesNotClaimLandingCampaignTrial(body.metadata);
    // member role: managerId forced to caller's member; admin role may
    // specify any managerId in the same org.
    const managerId = provisioningActor
      ? provisioningActor.managingMemberId
      : scope.role === "admin"
        ? (body.managerId ?? scope.memberId)
        : scope.memberId;
    // First-agent → delegate adoption fires ONLY for a self-create. Delegate is
    // a personal choice (the PATCH path rejects an admin setting another
    // member's delegate), so an admin creating an agent FOR another member must
    // not implicitly set that member's delegate. Only the caller acting on
    // their own member can adopt.
    const agent = await agentService.createAgent(
      app.db,
      {
        ...body,
        organizationId: scope.organizationId,
        source: body.source ?? "admin-api",
        managerId,
      },
      {
        adoptAsDelegateIfFirst: managerId === scope.memberId,
        provisioningAudit: provisioningActor ?? undefined,
      },
    );
    notifyClientAgentPinned(agent);
    return reply.status(201).send({
      ...agent,
      metadata: agentService.stripReservedAgentMetadata(agent.metadata),
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    });
  });
}
