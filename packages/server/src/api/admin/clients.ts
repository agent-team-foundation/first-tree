import type { FastifyInstance } from "fastify";
import { AppError } from "../../errors.js";
import * as activityService from "../../services/activity.js";
import * as clientService from "../../services/client.js";
import { forceDisconnectClient } from "../../services/connection-manager.js";
import { serializeDate } from "../../utils.js";

export async function adminClientRoutes(app: FastifyInstance): Promise<void> {
  // GET /admin/clients — all connected clients
  app.get("/", async () => {
    const clients = await clientService.listClients(app.db);
    return clients.map((c) => ({
      id: c.id,
      status: c.status,
      sdkVersion: c.sdkVersion,
      hostname: c.hostname,
      os: c.os,
      agentCount: c.agentCount,
      connectedAt: serializeDate(c.connectedAt),
      lastSeenAt: c.lastSeenAt.toISOString(),
    }));
  });

  // GET /admin/clients/:clientId — single client with agent list
  app.get<{ Params: { clientId: string } }>("/:clientId", async (request) => {
    const client = await clientService.getClient(app.db, request.params.clientId);
    if (!client) {
      throw new AppError(404, "Client not found");
    }
    return {
      id: client.id,
      status: client.status,
      sdkVersion: client.sdkVersion,
      hostname: client.hostname,
      os: client.os,
      connectedAt: serializeDate(client.connectedAt),
      lastSeenAt: client.lastSeenAt.toISOString(),
    };
  });

  // POST /admin/clients/:clientId/disconnect — force disconnect a client
  app.post<{ Params: { clientId: string } }>("/:clientId/disconnect", async (request) => {
    const { clientId } = request.params;
    const client = await clientService.getClient(app.db, clientId);
    if (!client) {
      throw new AppError(404, "Client not found");
    }

    const agentIds = forceDisconnectClient(clientId);
    await clientService.disconnectClient(app.db, clientId);

    return { disconnected: true, agentIds };
  });
}

export async function adminActivityRoutes(app: FastifyInstance): Promise<void> {
  // GET /admin/agents/activity — activity overview
  app.get("/", async () => {
    const overview = await activityService.getActivityOverview(app.db);
    const runningAgents = await activityService.listAgentsWithRuntime(app.db);

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
      })),
    };
  });

  // POST /admin/agents/:agentId/reset-activity — reset error state to idle
  app.post<{ Params: { agentId: string } }>("/:agentId/reset-activity", async (request) => {
    await activityService.resetActivity(app.db, request.params.agentId);
    return { reset: true };
  });
}
