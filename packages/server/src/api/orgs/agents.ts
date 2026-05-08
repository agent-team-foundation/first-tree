import {
  agentPinnedMessageSchema,
  agentTypeSchema,
  createAgentSchema,
  paginationQuerySchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ForbiddenError } from "../../errors.js";
import { requireOrgMembership } from "../../scope/require-org.js";
import * as agentService from "../../services/agent.js";
import { sendToClient } from "../../services/connection-manager.js";

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
      agentType: agent.type,
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

  const listAgentsFilterSchema = z.object({
    type: agentTypeSchema.optional(),
  });

  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const query = paginationQuerySchema.parse(request.query);
    const { type } = listAgentsFilterSchema.parse(request.query);
    const result = await agentService.listAgentsForMember(app.db, scope, query.limit, query.cursor, type);
    return {
      items: result.items.map((a) => ({
        ...a,
        managerId: a.managerId ?? null,
        presenceStatus: a.presenceStatus ?? "offline",
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        clientId: a.clientId ?? null,
        runtimeType: a.runtimeType ?? null,
        runtimeState: a.runtimeState ?? null,
        activeSessions: a.activeSessions ?? null,
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
      items: result.items.map((a) => ({
        ...a,
        managerId: a.managerId ?? null,
        presenceStatus: a.presenceStatus ?? "offline",
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        clientId: a.clientId ?? null,
        runtimeType: a.runtimeType ?? null,
        runtimeState: a.runtimeState ?? null,
        activeSessions: a.activeSessions ?? null,
      })),
      nextCursor: result.nextCursor,
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
    const body = createAgentSchema.parse(request.body);
    // member role: managerId forced to caller's member; admin role may
    // specify any managerId in the same org.
    const managerId = scope.role === "admin" ? (body.managerId ?? scope.memberId) : scope.memberId;
    const agent = await agentService.createAgent(app.db, {
      ...body,
      organizationId: scope.organizationId,
      source: body.source ?? "admin-api",
      managerId,
    });
    notifyClientAgentPinned(agent);
    return reply.status(201).send({
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    });
  });
}
