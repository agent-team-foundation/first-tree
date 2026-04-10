import {
  agentTypeSchema,
  createAgentSchema,
  createAgentTokenSchema,
  paginationQuerySchema,
  updateAgentSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, gt, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agents } from "../../db/schema/agents.js";
import { messages } from "../../db/schema/messages.js";
import * as agentService from "../../services/agent.js";
import { findOrCreateDirectChat } from "../../services/chat.js";
import { forceDisconnect } from "../../services/connection-manager.js";
import { sendMessage } from "../../services/message.js";
import { notifyRecipients } from "../../services/notifier.js";
import * as presenceService from "../../services/presence.js";
import { serializeDate } from "../../utils.js";

export async function adminAgentRoutes(app: FastifyInstance): Promise<void> {
  const listAgentsFilterSchema = z.object({ type: agentTypeSchema.optional() });

  app.get("/", async (request) => {
    const query = paginationQuerySchema.parse(request.query);
    const { type } = listAgentsFilterSchema.parse(request.query);
    const org = (request.query as Record<string, string>).org ?? "default";
    const result = await agentService.listAgents(app.db, org, query.limit, query.cursor, type);
    return {
      items: result.items.map((a) => ({
        ...a,
        presenceStatus: a.presenceStatus ?? "offline",
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        // M1: runtime fields
        clientId: a.clientId ?? null,
        runtimeType: a.runtimeType ?? null,
        runtimeState: a.runtimeState ?? null,
        runtimeDescription: a.runtimeDescription ?? null,
        activeSessions: a.activeSessions ?? null,
        errorMessage: a.errorMessage ?? null,
      })),
      nextCursor: result.nextCursor,
    };
  });

  app.post("/", async (request, reply) => {
    const body = createAgentSchema.parse(request.body);
    const agent = await agentService.createAgent(app.db, { ...body, source: body.source ?? "admin-api" });
    return reply.status(201).send({
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    });
  });

  app.patch<{ Params: { uuid: string } }>("/:uuid", async (request) => {
    const body = updateAgentSchema.parse(request.body);
    const agent = await agentService.updateAgent(app.db, request.params.uuid, body);
    return {
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  });

  app.get<{ Params: { uuid: string } }>("/:uuid", async (request) => {
    const agent = await agentService.getAgent(app.db, request.params.uuid);
    return {
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  });

  // Token management
  app.post<{ Params: { uuid: string } }>("/:uuid/tokens", async (request, reply) => {
    const body = createAgentTokenSchema.parse(request.body);
    const result = await agentService.createToken(app.db, request.params.uuid, body);
    return reply.status(201).send({
      ...result,
      expiresAt: serializeDate(result.expiresAt),
      revokedAt: serializeDate(result.revokedAt),
      createdAt: result.createdAt.toISOString(),
      lastUsedAt: serializeDate(result.lastUsedAt),
    });
  });

  app.get<{ Params: { uuid: string } }>("/:uuid/tokens", async (request) => {
    const tokens = await agentService.listTokens(app.db, request.params.uuid);
    return tokens.map((t) => ({
      ...t,
      expiresAt: serializeDate(t.expiresAt),
      revokedAt: serializeDate(t.revokedAt),
      createdAt: t.createdAt.toISOString(),
      lastUsedAt: serializeDate(t.lastUsedAt),
    }));
  });

  app.delete<{ Params: { uuid: string; tokenId: string } }>("/:uuid/tokens/:tokenId", async (request, reply) => {
    await agentService.revokeToken(app.db, request.params.uuid, request.params.tokenId);
    return reply.status(204).send();
  });

  // Force-disconnect an agent's WebSocket connection
  app.post<{ Params: { uuid: string } }>("/:uuid/disconnect", async (request, reply) => {
    const { uuid } = request.params;
    // Verify agent exists
    await agentService.getAgent(app.db, uuid);
    // Close WebSocket and set presence offline
    const wasConnected = forceDisconnect(uuid);
    await presenceService.setOffline(app.db, uuid);
    return reply.status(200).send({ disconnected: wasConnected });
  });

  app.post<{ Params: { uuid: string } }>("/:uuid/suspend", async (request) => {
    const agent = await agentService.suspendAgent(app.db, request.params.uuid);
    return {
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  });

  app.post<{ Params: { uuid: string } }>("/:uuid/reactivate", async (request) => {
    const agent = await agentService.reactivateAgent(app.db, request.params.uuid);
    return {
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  });

  // DELETE agent — only allowed for suspended agents
  app.delete<{ Params: { uuid: string } }>("/:uuid", async (request, reply) => {
    await agentService.deleteAgent(app.db, request.params.uuid);
    return reply.status(204).send();
  });

  app.post<{ Params: { uuid: string } }>("/:uuid/test", async (request, reply) => {
    const { uuid } = request.params;

    const [, presence] = await Promise.all([
      agentService.getAgent(app.db, uuid),
      presenceService.getPresence(app.db, uuid),
    ]);

    if (!presence || presence.status !== "online") {
      return reply.status(200).send({
        status: "offline",
        message: "Agent is not connected. Start the client first.",
      });
    }

    // Find sender: look for human owner (whose delegateMention points to this agent), then fall back to any other active agent
    const [owner] = await app.db
      .select({ uuid: agents.uuid })
      .from(agents)
      .where(and(eq(agents.delegateMention, uuid), eq(agents.status, "active")))
      .limit(1);

    let senderId = owner?.uuid ?? null;
    if (!senderId) {
      const [other] = await app.db
        .select({ uuid: agents.uuid })
        .from(agents)
        .where(and(ne(agents.uuid, uuid), eq(agents.status, "active")))
        .limit(1);
      senderId = other?.uuid ?? null;
    }

    if (!senderId) {
      return reply.status(200).send({
        status: "error",
        message: "No suitable sender found. Need at least one other active agent.",
      });
    }

    const chat = await findOrCreateDirectChat(app.db, senderId, uuid);

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
        .where(and(eq(messages.chatId, chat.id), eq(messages.senderId, uuid), gt(messages.createdAt, threshold)))
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
