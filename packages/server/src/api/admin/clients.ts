import { updateClientCapabilitiesSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ForbiddenError } from "../../errors.js";
import { memberScope, requireMemberInOrg, resolveAdminScope } from "../../services/access-control.js";
import * as activityService from "../../services/activity.js";
import * as clientService from "../../services/client.js";
import { forceDisconnectClient } from "../../services/connection-manager.js";
import { serializeDate } from "../../utils.js";

const listClientsQuerySchema = z.object({ organizationId: z.string().min(1).optional() });

export async function adminClientRoutes(app: FastifyInstance): Promise<void> {
  // GET /clients — by default returns clients owned by the caller (a client
  // is owned by a user, cross-org by design). With `?organizationId=…` an
  // admin in that org gets the cross-user roster: every client owned by an
  // active member (decouple-client-from-identity §4.5.1 (γ)).
  app.get("/", async (request) => {
    const scope = memberScope(request);
    const { organizationId } = listClientsQuerySchema.parse(request.query);
    const clients = organizationId
      ? await (async () => {
          const probe = await requireMemberInOrg(app.db, request, organizationId);
          if (probe.role !== "admin") throw new ForbiddenError("Admin role required");
          return clientService.listClientsForOrgAdmin(app.db, organizationId);
        })()
      : await clientService.listClients(app.db, { userId: scope.userId });
    return clients.map((c) => ({
      id: c.id,
      userId: c.userId,
      status: c.status,
      sdkVersion: c.sdkVersion,
      hostname: c.hostname,
      os: c.os,
      agentCount: c.agentCount,
      connectedAt: serializeDate(c.connectedAt),
      lastSeenAt: c.lastSeenAt.toISOString(),
    }));
  });

  // GET /clients/me/agents — every agent pinned to a client owned by the
  // calling user. Used by client startup to reconcile authoritative
  // `agents.runtime_provider` before spawning handlers (B3 layer 1).
  app.get("/me/agents", async (request) => {
    const scope = memberScope(request);
    const agents = await clientService.listMyPinnedAgents(app.db, { userId: scope.userId });
    return agents;
  });

  // PATCH /clients/:clientId/capabilities — owner-scoped capability snapshot
  // upload. Stored under `clients.metadata.capabilities` (Option C).
  app.patch<{ Params: { clientId: string } }>("/:clientId/capabilities", async (request, reply) => {
    const scope = memberScope(request);
    await clientService.assertClientOwner(app.db, request.params.clientId, scope);
    const body = updateClientCapabilitiesSchema.parse(request.body);
    await clientService.updateClientCapabilities(app.db, request.params.clientId, body.capabilities);
    return reply.status(204).send();
  });

  // GET /clients/:clientId — single client, owner-scoped. Includes the
  // `capabilities` snapshot from `metadata.capabilities` (Option C, P2).
  app.get<{ Params: { clientId: string } }>("/:clientId", async (request) => {
    const scope = memberScope(request);
    await clientService.assertClientOwner(app.db, request.params.clientId, scope);
    const client = await clientService.getClient(app.db, request.params.clientId);
    // assertClientOwner already 404'd on missing/not-yours; the row is present.
    if (!client) throw new Error("unreachable: client missing after owner check");
    const metadata = (client.metadata ?? {}) as Record<string, unknown>;
    const capabilities =
      metadata.capabilities && typeof metadata.capabilities === "object" ? metadata.capabilities : {};
    return {
      id: client.id,
      userId: client.userId,
      status: client.status,
      sdkVersion: client.sdkVersion,
      hostname: client.hostname,
      os: client.os,
      connectedAt: serializeDate(client.connectedAt),
      lastSeenAt: client.lastSeenAt.toISOString(),
      capabilities,
    };
  });

  // POST /clients/:clientId/disconnect — force disconnect, owner-scoped.
  app.post<{ Params: { clientId: string } }>("/:clientId/disconnect", async (request) => {
    const scope = memberScope(request);
    const { clientId } = request.params;
    await clientService.assertClientOwner(app.db, clientId, scope);

    const agentIds = forceDisconnectClient(clientId);
    await clientService.disconnectClient(app.db, clientId);

    return { disconnected: true, agentIds };
  });

  // DELETE /clients/:clientId — retire, owner-scoped. Refuses while
  // agents are still pinned (proposal M12); the service layer surfaces a 409
  // with the pinned agent list so the UI can display it.
  app.delete<{ Params: { clientId: string } }>("/:clientId", async (request, reply) => {
    const scope = memberScope(request);
    const { clientId } = request.params;
    await clientService.assertClientOwner(app.db, clientId, scope);

    // retireClient verifies no non-deleted agents are pinned before deleting
    // the clients row; a refused retire throws 409 BEFORE we disconnect, so a
    // blocked retire never drops the running client. The service wraps the
    // check + delete in a txn with FOR UPDATE so a racing createAgent cannot
    // surface a raw PG 23503.
    await clientService.retireClient(app.db, clientId);
    forceDisconnectClient(clientId);
    await clientService.disconnectClient(app.db, clientId);

    return reply.status(204).send();
  });
}

const activityQuerySchema = z.object({ organizationId: z.string().min(1).optional() });

export async function adminActivityRoutes(app: FastifyInstance): Promise<void> {
  // GET /admin/agents/activity — activity overview (visibility-scoped)
  //
  // Honors `?organizationId=` so the multi-org caller's selected-org context
  // (injected by the web's api-client `decoratePath`) actually drives which
  // tenant's runtime activity is returned. Without this, every consumer of
  // the `["activity"]` query (Workspace roster + middle area, Agents tab
  // RUNTIME column, Computers BOUND AGENTS, command palette) silently shows
  // JWT-default-org data while the dropdown shows a different org —
  // follow-up to PR #220 which patched the analogous gap on the create
  // path.
  app.get("/", async (request) => {
    const baseScope = memberScope(request);
    const { organizationId } = activityQuerySchema.parse(request.query);
    const scope = await resolveAdminScope(app.db, request, baseScope, organizationId);
    const overview = await activityService.getActivityOverview(app.db);
    const runningAgents = await activityService.listAgentsWithRuntime(app.db, scope);

    return {
      ...overview,
      agents: runningAgents.map((a) => ({
        agentId: a.agentId,
        clientId: a.clientId,
        runtimeType: a.runtimeType,
        runtimeState: a.runtimeState,
        activeSessions: a.activeSessions,
        totalSessions: a.totalSessions,
        runtimeUpdatedAt: a.runtimeUpdatedAt?.toISOString() ?? null,
        type: "type" in a ? a.type : null,
      })),
    };
  });

  // POST /admin/agents/:agentId/reset-activity — reset error state to idle
  app.post<{ Params: { agentId: string } }>("/:agentId/reset-activity", async (request) => {
    await activityService.resetActivity(app.db, request.params.agentId);
    return { reset: true };
  });
}
