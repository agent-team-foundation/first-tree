import {
  agentPinnedMessageSchema,
  agentTypeSchema,
  createAgentSchema,
  paginationQuerySchema,
  updateAgentSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, gt, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agents } from "../../db/schema/agents.js";
import { messages } from "../../db/schema/messages.js";
import { ForbiddenError } from "../../errors.js";
import { requireMember } from "../../middleware/require-identity.js";
import { assertAgentVisible, assertCanManage, memberScope } from "../../services/access-control.js";
import * as agentService from "../../services/agent.js";
import { createChat, findOrCreateDirectChat } from "../../services/chat.js";
import * as clientService from "../../services/client.js";
import {
  forceDisconnect,
  getAgentClientId,
  hasActiveConnection,
  sendToClient,
} from "../../services/connection-manager.js";
import { sendMessage } from "../../services/message.js";
import { notifyRecipients } from "../../services/notifier.js";
import * as presenceService from "../../services/presence.js";

export async function adminAgentRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Push an `agent:pinned` frame to the connected client so it can auto-register
   * the agent locally without the operator running `first-tree-hub agent add`.
   *
   * Best-effort: if the client is not currently connected to this server
   * instance, the notification is silently dropped here — the client picks the
   * pinning up on its next `client:register` handshake via the backfill path
   * in `api/agent/ws-client.ts`.
   */
  function notifyClientAgentPinned(agent: {
    uuid: string;
    name: string | null;
    displayName: string | null;
    type: string;
    clientId: string | null;
  }): void {
    if (!agent.clientId) return;
    const parsed = agentPinnedMessageSchema.safeParse({
      type: "agent:pinned",
      agentId: agent.uuid,
      name: agent.name,
      displayName: agent.displayName,
      agentType: agent.type,
    });
    if (!parsed.success) {
      // Schema drift between server and shared types is a contract bug — log
      // it so the gap doesn't stay invisible. Best-effort: we still don't
      // throw, since failing the admin write on a notification mismatch would
      // break the operator workflow.
      app.log.warn(
        { err: parsed.error.flatten(), agentId: agent.uuid, clientId: agent.clientId },
        "agent:pinned frame failed schema validation — not sending",
      );
      return;
    }
    sendToClient(agent.clientId, parsed.data);
  }

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
        clientId: a.clientId ?? null,
        runtimeType: a.runtimeType ?? null,
        runtimeState: a.runtimeState ?? null,
        activeSessions: a.activeSessions ?? null,
      })),
      nextCursor: result.nextCursor,
    };
  });

  /**
   * Admin-only: every agent in the caller's org, skipping the visibility
   * filter applied on the regular `/agents` list. Private agents owned by
   * other members show up here so an admin can reassign or troubleshoot.
   * Role gating is enforced here — the parent route group does NOT add
   * adminOnly because the member-facing `GET /` is shared.
   */
  app.get("/all", async (request) => {
    const scope = memberScope(request);
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
    // Auto-register on the pinned client: push an `agent:pinned` frame so the
    // running client writes its local agent config without a manual
    // `first-tree-hub agent add` step.
    notifyClientAgentPinned(agent);
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
    // Only admins may reassign the manager. clientId is NULL → ID one-shot;
    // see updateAgent service for the immutability rule.
    const member = requireMember(request);
    if (body.managerId !== undefined && member.role !== "admin") {
      throw new ForbiddenError("Only admins can reassign an agent's manager");
    }
    // Only fetch the pre-state when the caller is trying to set `clientId` —
    // for every other PATCH (rename, delegateMention, visibility, …) we'd be
    // paying for a read whose answer we don't use.
    const wantsToBindClient = body.clientId !== undefined;
    const before = wantsToBindClient ? await agentService.getAgent(app.db, request.params.uuid) : null;
    const agent = await agentService.updateAgent(app.db, request.params.uuid, body);
    if (before && before.clientId === null && agent.clientId !== null) {
      notifyClientAgentPinned(agent);
    }
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

  // Force-disconnect an agent's WebSocket connection
  app.post<{ Params: { uuid: string } }>("/:uuid/disconnect", async (request, reply) => {
    const { uuid } = request.params;
    const scope = memberScope(request);
    await assertCanManage(app.db, scope, uuid);
    const wasConnected = forceDisconnect(uuid);
    await presenceService.setOffline(app.db, uuid);
    return reply.status(200).send({ disconnected: wasConnected });
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
        message: "Agent is not connected. Start the client with: first-tree-hub client connect <server-url>",
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
