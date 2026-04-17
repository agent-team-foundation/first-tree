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
import { requireMember } from "../../middleware/require-identity.js";
import { assertAgentVisible, assertCanManage, memberScope } from "../../services/access-control.js";
import * as agentService from "../../services/agent.js";
import { createChat, findOrCreateDirectChat } from "../../services/chat.js";
import * as clientService from "../../services/client.js";
import {
  forceDisconnect,
  getAgentClientId,
  hasActiveConnection,
  hasClientConnection,
  sendToClient,
} from "../../services/connection-manager.js";
import { sendMessage } from "../../services/message.js";
import { notifyRecipients } from "../../services/notifier.js";
import * as presenceService from "../../services/presence.js";
import { serializeDate } from "../../utils.js";

export async function adminAgentRoutes(app: FastifyInstance): Promise<void> {
  const listAgentsFilterSchema = z.object({ type: agentTypeSchema.optional() });

  app.get("/", async (request) => {
    const query = paginationQuerySchema.parse(request.query);
    const { type } = listAgentsFilterSchema.parse(request.query);
    const scope = memberScope(request);
    const result = await agentService.listAgentsForMember(app.db, scope, query.limit, query.cursor, type);
    return {
      items: result.items.map((a) => ({
        ...a,
        managerId: a.managerId ?? null,
        presenceStatus: a.presenceStatus ?? "offline",
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        // M1: runtime fields
        clientId: a.clientId ?? null,
        runtimeType: a.runtimeType ?? null,
        runtimeState: a.runtimeState ?? null,
        activeSessions: a.activeSessions ?? null,
      })),
      nextCursor: result.nextCursor,
    };
  });

  app.post("/", async (request, reply) => {
    const scope = memberScope(request);
    const body = createAgentSchema.parse(request.body);
    // member role: managerId forced to self; admin role: can specify any managerId
    const managerId = scope.role === "admin" ? (body.managerId ?? scope.memberId) : scope.memberId;
    const agent = await agentService.createAgent(app.db, {
      ...body,
      source: body.source ?? "admin-api",
      managerId,
    });
    return reply.status(201).send({
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    });
  });

  app.patch<{ Params: { uuid: string } }>("/:uuid", async (request) => {
    const scope = memberScope(request);
    await assertCanManage(app.db, scope, request.params.uuid);
    const body = updateAgentSchema.parse(request.body);
    const agent = await agentService.updateAgent(app.db, request.params.uuid, body);
    return {
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  });

  app.get<{ Params: { uuid: string } }>("/:uuid", async (request) => {
    const scope = memberScope(request);
    await assertAgentVisible(app.db, scope, request.params.uuid);
    const agent = await agentService.getAgent(app.db, request.params.uuid);
    return {
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  });

  // Token management
  app.post<{ Params: { uuid: string } }>("/:uuid/tokens", async (request, reply) => {
    const scope = memberScope(request);
    await assertCanManage(app.db, scope, request.params.uuid);
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
    const scope = memberScope(request);
    await assertCanManage(app.db, scope, request.params.uuid);
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
    const scope = memberScope(request);
    await assertCanManage(app.db, scope, request.params.uuid);
    await agentService.revokeToken(app.db, request.params.uuid, request.params.tokenId);
    return reply.status(204).send();
  });

  // Force-disconnect an agent's WebSocket connection
  app.post<{ Params: { uuid: string } }>("/:uuid/disconnect", async (request, reply) => {
    const { uuid } = request.params;
    const scope = memberScope(request);
    await assertCanManage(app.db, scope, uuid);
    const wasConnected = forceDisconnect(uuid);
    await presenceService.setOffline(app.db, uuid);
    return reply.status(200).send({ disconnected: wasConnected });
  });

  // Provision an agent to a connected client — generates token and pushes via WS
  app.post<{ Params: { uuid: string } }>("/:uuid/provision", async (request, reply) => {
    const { uuid } = request.params;
    const scope = memberScope(request);
    await assertCanManage(app.db, scope, uuid);
    const body = z.object({ clientId: z.string().min(1) }).parse(request.body);

    const agent = await agentService.getAgent(app.db, uuid);
    if (!hasClientConnection(body.clientId)) {
      return reply.status(409).send({ error: "Client is not connected" });
    }

    const tokenResult = await agentService.createToken(app.db, uuid, { name: "provision" });
    const delivered = sendToClient(body.clientId, {
      type: "agent:provision",
      agentName: agent.name,
      agentType: agent.type,
      token: tokenResult.token,
    });

    if (!delivered) {
      return reply.status(409).send({ error: "Failed to deliver provision to client" });
    }

    return reply.status(200).send({ provisioned: true, clientId: body.clientId });
  });

  app.post<{ Params: { uuid: string } }>("/:uuid/suspend", async (request) => {
    const scope = memberScope(request);
    await assertCanManage(app.db, scope, request.params.uuid);
    const agent = await agentService.suspendAgent(app.db, request.params.uuid);
    return {
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  });

  app.post<{ Params: { uuid: string } }>("/:uuid/reactivate", async (request) => {
    const scope = memberScope(request);
    await assertCanManage(app.db, scope, request.params.uuid);
    const agent = await agentService.reactivateAgent(app.db, request.params.uuid);
    return {
      ...agent,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  });

  app.delete<{ Params: { uuid: string } }>("/:uuid", async (request, reply) => {
    const scope = memberScope(request);
    await assertCanManage(app.db, scope, request.params.uuid);
    await agentService.deleteAgent(app.db, request.params.uuid);
    return reply.status(204).send();
  });

  app.post<{ Params: { uuid: string } }>("/:uuid/test", async (request, reply) => {
    const { uuid } = request.params;
    const scope = memberScope(request);
    await assertCanManage(app.db, scope, uuid);

    // ── Phase 1: Connection diagnostics ──
    const presence = await presenceService.getPresence(app.db, uuid);

    const wsConnected = hasActiveConnection(uuid);
    const clientId = getAgentClientId(uuid) ?? presence?.clientId ?? null;

    const STALE_THRESHOLD_MS = 60_000;
    let health: "connected" | "stale" | "disconnected" = "disconnected";
    if (wsConnected) {
      const lastSeen = presence?.lastSeenAt?.getTime() ?? 0;
      health = Date.now() - lastSeen > STALE_THRESHOLD_MS ? "stale" : "connected";
    } else if (presence?.status === "online") {
      health = "stale";
    }

    let clientInfo: {
      id: string;
      hostname: string | null;
      os: string | null;
      sdkVersion: string | null;
      connectedAt: string | null;
    } | null = null;
    if (clientId) {
      const client = await clientService.getClient(app.db, clientId);
      if (client) {
        clientInfo = {
          id: client.id,
          hostname: client.hostname,
          os: client.os,
          sdkVersion: client.sdkVersion,
          connectedAt: client.connectedAt?.toISOString() ?? null,
        };
      }
    }

    const connection = {
      health,
      runtimeState: presence?.runtimeState ?? null,
      lastSeenAt: presence?.lastSeenAt?.toISOString() ?? null,
      client: clientInfo,
    };

    if (health === "disconnected") {
      return reply.status(200).send({
        status: "offline",
        message: "Agent is not connected. Start the client with: first-tree-hub connect <server-url>",
        connection,
      });
    }

    if (health === "stale") {
      return reply.status(200).send({
        status: "stale",
        message: "Agent connection is stale — heartbeat lost. The client process may have crashed.",
        connection,
      });
    }

    // ── Phase 2: Message delivery test ──
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
        connection,
      });
    }

    const chat = await findOrCreateDirectChat(app.db, senderId, uuid);

    const testContent = `[System Test] Verify your connection. Respond with your identity and role. Time: ${new Date().toISOString()}`;
    const result = await sendMessage(app.db, chat.id, senderId, {
      format: "text",
      content: testContent,
    });
    notifyRecipients(app.notifier, result.recipients, result.message.id);

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
          connection,
        });
      }
    }

    return reply.status(200).send({
      status: "timeout",
      chatId: chat.id,
      message: "Agent is connected but did not respond within 30 seconds.",
      connection,
    });
  });

  /** POST /admin/agents/:uuid/chats — create a new workspace chat with the target agent */
  app.post<{ Params: { uuid: string } }>("/:uuid/chats", async (request, reply) => {
    const { uuid: targetAgentId } = request.params;
    const scope = memberScope(request);
    await assertAgentVisible(app.db, scope, targetAgentId);

    const member = requireMember(request);
    const result = await createChat(app.db, member.agentId, {
      type: "direct",
      participantIds: [targetAgentId],
    });

    return reply.status(201).send({
      id: result.id,
      type: result.type,
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
      participants: result.participants.map((p) => ({
        agentId: p.agentId,
        role: p.role,
        mode: p.mode,
        joinedAt: p.joinedAt.toISOString(),
      })),
    });
  });
}
