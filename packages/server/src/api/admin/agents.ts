import { createAgentTokenSchema, paginationQuerySchema } from "@first-tree-hub/shared";
import type { FastifyInstance } from "fastify";
import * as agentService from "../../services/agent.js";
import { findOrCreateDirectChat } from "../../services/chat.js";
import { forceDisconnect } from "../../services/connection-manager.js";
import { listMessages, sendMessage } from "../../services/message.js";
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

  // Test connection — send a test message and wait for a response
  app.post<{ Params: { agentId: string } }>("/:agentId/test", async (request, reply) => {
    const { agentId } = request.params;
    const agent = await agentService.getAgent(app.db, agentId);

    // Check presence first
    const presence = await presenceService.getPresence(app.db, agentId);
    if (!presence || presence.status !== "online") {
      return reply.status(200).send({
        status: "offline",
        message: "Agent is not connected. Start the client first.",
      });
    }

    // Find a sender: use delegateMention owner for personal_assistant, otherwise pick any other agent
    let senderId: string | null = agent.delegateMention;
    if (!senderId) {
      // Find any other active agent to act as sender
      const allAgents = await agentService.listAgents(app.db, 10);
      const other = allAgents.items.find((a) => a.id !== agentId && a.status === "active");
      senderId = other?.id ?? null;
    }

    if (!senderId) {
      return reply.status(400).send({
        status: "error",
        message: "No suitable sender found. Need at least one other active agent.",
      });
    }

    // Create or find a direct chat
    const chat = await findOrCreateDirectChat(app.db, senderId, agentId);

    // Send test message
    const testContent = `[System Test] This is an automated test message to verify your connection. Please respond with a brief confirmation that includes your identity and role. Time: ${new Date().toISOString()}`;
    const result = await sendMessage(app.db, chat.id, senderId, {
      format: "text",
      content: testContent,
    });

    // Notify via WebSocket
    notifyRecipients(app.notifier, result.recipients, result.message.id);

    // Poll for response (up to 30 seconds)
    const pollStart = Date.now();
    const POLL_TIMEOUT = 30_000;
    const POLL_INTERVAL = 1_000;

    while (Date.now() - pollStart < POLL_TIMEOUT) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));

      const recent = await listMessages(app.db, chat.id, 5);
      const response = recent.items.find((m) => m.senderId === agentId && m.createdAt > result.message.createdAt);

      if (response) {
        return reply.status(200).send({
          status: "success",
          chatId: chat.id,
          testMessageId: result.message.id,
          responseMessageId: response.id,
          responseContent:
            typeof response.content === "string"
              ? response.content.slice(0, 500)
              : JSON.stringify(response.content).slice(0, 500),
          responseTime: response.createdAt.getTime() - result.message.createdAt.getTime(),
        });
      }
    }

    return reply.status(200).send({
      status: "timeout",
      chatId: chat.id,
      testMessageId: result.message.id,
      message: "Agent is connected but did not respond within 30 seconds. The agent may still be processing.",
    });
  });
}
