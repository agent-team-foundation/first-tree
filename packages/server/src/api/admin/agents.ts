import { createAgentTokenSchema, paginationQuerySchema } from "@agent-hub/shared";
import type { FastifyInstance } from "fastify";
import * as agentService from "../../services/agent.js";
import { forceDisconnect } from "../../services/connection-manager.js";
import * as presenceService from "../../services/presence.js";

function serializeDate(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export async function adminAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    const query = paginationQuerySchema.parse(request.query);
    const result = await agentService.listAgents(app.db, query.limit, query.cursor);
    return {
      items: result.items.map((a) => ({
        ...a,
        presenceStatus: a.presenceStatus ?? "offline",
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  });

  // POST / (create) removed — agents are created by Context Tree sync
  // PATCH /:agentId (update) removed — status is managed by sync, admin controls via token revocation

  app.get<{ Params: { agentId: string } }>("/:agentId", async (request) => {
    const agent = await agentService.getAgent(app.db, request.params.agentId);
    return {
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  });

  // Token management
  app.post<{ Params: { agentId: string } }>("/:agentId/tokens", async (request, reply) => {
    const body = createAgentTokenSchema.parse(request.body);
    const result = await agentService.createToken(app.db, request.params.agentId, body);
    return reply.status(201).send({
      ...result,
      expiresAt: serializeDate(result.expiresAt),
      revokedAt: serializeDate(result.revokedAt),
      createdAt: result.createdAt.toISOString(),
      lastUsedAt: serializeDate(result.lastUsedAt),
    });
  });

  app.get<{ Params: { agentId: string } }>("/:agentId/tokens", async (request) => {
    const tokens = await agentService.listTokens(app.db, request.params.agentId);
    return tokens.map((t) => ({
      ...t,
      expiresAt: serializeDate(t.expiresAt),
      revokedAt: serializeDate(t.revokedAt),
      createdAt: t.createdAt.toISOString(),
      lastUsedAt: serializeDate(t.lastUsedAt),
    }));
  });

  app.delete<{ Params: { agentId: string; tokenId: string } }>("/:agentId/tokens/:tokenId", async (request, reply) => {
    await agentService.revokeToken(app.db, request.params.agentId, request.params.tokenId);
    return reply.status(204).send();
  });

  // Force-disconnect an agent's WebSocket connection
  app.post<{ Params: { agentId: string } }>("/:agentId/disconnect", async (request, reply) => {
    const { agentId } = request.params;
    // Verify agent exists
    await agentService.getAgent(app.db, agentId);
    // Close WebSocket and set presence offline
    const wasConnected = forceDisconnect(agentId);
    await presenceService.setOffline(app.db, agentId);
    return reply.status(200).send({ disconnected: wasConnected });
  });

  // DELETE agent — only allowed for suspended agents (removed from tree)
  app.delete<{ Params: { agentId: string } }>("/:agentId", async (request, reply) => {
    await agentService.deleteAgent(app.db, request.params.agentId);
    return reply.status(204).send();
  });
}
