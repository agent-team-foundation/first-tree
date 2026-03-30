import { createAgentTokenSchema, paginationQuerySchema } from "@first-tree-hub/shared";
import { and, eq, gt, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../../db/schema/agents.js";
import { messages } from "../../db/schema/messages.js";
import * as agentService from "../../services/agent.js";
import { findOrCreateDirectChat } from "../../services/chat.js";
import { forceDisconnect } from "../../services/connection-manager.js";
import { sendMessage } from "../../services/message.js";
import { notifyRecipients } from "../../services/notifier.js";
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

  app.post<{ Params: { agentId: string } }>("/:agentId/test", async (request, reply) => {
    const { agentId } = request.params;

    const [, presence] = await Promise.all([
      agentService.getAgent(app.db, agentId),
      presenceService.getPresence(app.db, agentId),
    ]);

    if (!presence || presence.status !== "online") {
      return reply.status(200).send({
        status: "offline",
        message: "Agent is not connected. Start the client first.",
      });
    }

    // Find sender: look for human owner (whose delegateMention points to this agent), then fall back to any other active agent
    const [owner] = await app.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.delegateMention, agentId), eq(agents.status, "active")))
      .limit(1);

    let senderId = owner?.id ?? null;
    if (!senderId) {
      const [other] = await app.db
        .select({ id: agents.id })
        .from(agents)
        .where(and(ne(agents.id, agentId), eq(agents.status, "active")))
        .limit(1);
      senderId = other?.id ?? null;
    }

    if (!senderId) {
      return reply.status(200).send({
        status: "error",
        message: "No suitable sender found. Need at least one other active agent.",
      });
    }

    const chat = await findOrCreateDirectChat(app.db, senderId, agentId);

    const testContent = `[System Test] Verify your connection. Respond with your identity and role. Time: ${new Date().toISOString()}`;
    const result = await sendMessage(app.db, chat.id, senderId, {
      format: "text",
      content: testContent,
    });
    notifyRecipients(app.notifier, result.recipients, result.message.id);

    // Poll for response (admin diagnostic, acceptable to hold connection)
    const POLL_TIMEOUT = 30_000;
    const POLL_INTERVAL = 1_000;
    const threshold = result.message.createdAt;
    const pollStart = Date.now();

    while (Date.now() - pollStart < POLL_TIMEOUT) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));

      const [response] = await app.db
        .select()
        .from(messages)
        .where(and(eq(messages.chatId, chat.id), eq(messages.senderId, agentId), gt(messages.createdAt, threshold)))
        .limit(1);

      if (response) {
        const content =
          typeof response.content === "string"
            ? response.content.slice(0, 500)
            : JSON.stringify(response.content).slice(0, 500);
        return reply.status(200).send({
          status: "success",
          chatId: chat.id,
          responseContent: content,
          responseTime: response.createdAt.getTime() - threshold.getTime(),
        });
      }
    }

    return reply.status(200).send({
      status: "timeout",
      chatId: chat.id,
      message: "Agent is connected but did not respond within 30 seconds.",
    });
  });
}
