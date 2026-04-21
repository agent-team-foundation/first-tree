import type { FastifyInstance } from "fastify";
import { memberScope } from "../../services/access-control.js";
import * as activityService from "../../services/activity.js";
import * as clientService from "../../services/client.js";
import { forceDisconnectClient } from "../../services/connection-manager.js";
import { serializeDate } from "../../utils.js";

export async function adminClientRoutes(app: FastifyInstance): Promise<void> {
  // GET /clients — clients visible to the caller.
  //
  //   - member: only their own (`clients.user_id == scope.userId`). The
  //     `assertClientOwner` check on per-id routes continues to enforce
  //     the write path.
  //   - admin: every client belonging to a member of the caller's org
  //     plus any legacy unclaimed (user_id NULL) rows. The `/clients` UI
  //     surfaces the owner so admins can tell whose machine is whose.
  app.get("/", async (request) => {
    const scope = memberScope(request);
    const clients = await clientService.listClients(app.db, {
      userId: scope.userId,
      organizationId: scope.organizationId,
      role: scope.role,
    });
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

  // GET /clients/:clientId — single client, owner-scoped.
  app.get<{ Params: { clientId: string } }>("/:clientId", async (request) => {
    const scope = memberScope(request);
    await clientService.assertClientOwner(app.db, request.params.clientId, scope);
    const client = await clientService.getClient(app.db, request.params.clientId);
    // assertClientOwner already 404'd on missing/not-yours; the row is present.
    if (!client) throw new Error("unreachable: client missing after owner check");
    return {
      id: client.id,
      userId: client.userId,
      status: client.status,
      sdkVersion: client.sdkVersion,
      hostname: client.hostname,
      os: client.os,
      connectedAt: serializeDate(client.connectedAt),
      lastSeenAt: client.lastSeenAt.toISOString(),
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

export async function adminActivityRoutes(app: FastifyInstance): Promise<void> {
  // GET /admin/agents/activity — activity overview (visibility-scoped)
  app.get("/", async (request) => {
    const scope = memberScope(request);
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
