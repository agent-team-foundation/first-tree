import { createAgentSchema, createAgentTokenSchema, paginationQuerySchema, updateAgentSchema } from "@agent-hub/shared";
import type { FastifyInstance } from "fastify";
import * as agentService from "../../services/agent.js";

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
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  });

  app.post("/", async (request, reply) => {
    const body = createAgentSchema.parse(request.body);
    const agent = await agentService.createAgent(app.db, body);
    return reply.status(201).send({
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    });
  });

  app.get<{ Params: { agentId: string } }>("/:agentId", async (request) => {
    const agent = await agentService.getAgent(app.db, request.params.agentId);
    return {
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  });

  app.patch<{ Params: { agentId: string } }>("/:agentId", async (request) => {
    const body = updateAgentSchema.parse(request.body);
    const agent = await agentService.updateAgent(app.db, request.params.agentId, body);
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

  // DELETE agent (suspend + revoke all tokens)
  app.delete<{ Params: { agentId: string } }>("/:agentId", async (request, reply) => {
    await agentService.deleteAgent(app.db, request.params.agentId);
    return reply.status(204).send();
  });
}
