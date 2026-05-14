import {
  agentPinnedMessageSchema,
  rebindAgentSchema,
  updateAgentSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, gt, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../db/schema/agents.js";
import { messages } from "../db/schema/messages.js";
import { BadRequestError, ForbiddenError } from "../errors.js";
import { assertAllAgentsVisibleInOrg, requireAgentAccess } from "../scope/require-resource.js";
import * as agentService from "../services/agent.js";
import { agentAvatarImageUrl, SUPPORTED_AVATAR_IMAGE_MIMES } from "../services/agent.js";
import { createChat, findOrCreateDirectChat } from "../services/chat.js";
import * as clientService from "../services/client.js";
import {
  forceDisconnect,
  getAgentClientId,
  hasActiveConnection,
  sendToClient,
} from "../services/connection-manager.js";
import { sendMessage } from "../services/message.js";
import { notifyRecipients } from "../services/notifier.js";
import * as presenceService from "../services/presence.js";

type AgentRow = {
  uuid: string;
  createdAt: Date;
  updatedAt: Date;
  avatarImageData?: Buffer | null;
  avatarImageMime?: string | null;
  avatarImageUpdatedAt?: Date | null;
  [key: string]: unknown;
};

/**
 * Project a DB agent row into its wire shape. Strips the inline image
 * `avatarImageData` (large bytea, only meant for the image-serve route)
 * and synthesises the public `avatarImageUrl` from the upload timestamp.
 * `createdAt`/`updatedAt` are coerced to ISO strings so the response is
 * pure JSON.
 */
function serializeAgent(agent: AgentRow): Record<string, unknown> {
  const { avatarImageData: _data, avatarImageMime: _mime, avatarImageUpdatedAt, createdAt, updatedAt, ...rest } = agent;
  return {
    ...rest,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    avatarImageUrl: agentAvatarImageUrl(agent.uuid, avatarImageUpdatedAt ?? null),
  };
}

/**
 * Class C — resource-scoped per-agent routes. Mounted at
 * `/api/v1/agents/:uuid/...`. The agent's UUID locates its org
 * intrinsically; `requireAgentAccess` resolves the caller's membership in
 * that org and enforces visibility / manage rules.
 */
export async function agentRoutes(app: FastifyInstance): Promise<void> {
  function notifyClientAgentPinned(agent: {
    uuid: string;
    name: string | null;
    displayName: string | null;
    type: string;
    clientId: string | null;
    runtimeProvider: string;
  }): void {
    if (!agent.clientId) return;
    const parsed = agentPinnedMessageSchema.safeParse({
      type: "agent:pinned",
      agentId: agent.uuid,
      name: agent.name,
      displayName: agent.displayName,
      agentType: agent.type,
      runtimeProvider: agent.runtimeProvider,
    });
    if (!parsed.success) {
      app.log.warn(
        { err: parsed.error.flatten(), agentId: agent.uuid, clientId: agent.clientId },
        "agent:pinned frame failed schema validation — not sending",
      );
      return;
    }
    sendToClient(agent.clientId, parsed.data);
  }

  app.get<{ Params: { uuid: string } }>("/:uuid", async (request) => {
    const { agent } = await requireAgentAccess(request, app.db, "visible");
    return serializeAgent(agent);
  });

  app.patch<{ Params: { uuid: string } }>("/:uuid", { config: { otelRecordBody: true } }, async (request) => {
    const { scope } = await requireAgentAccess(request, app.db, "manage");
    const body = updateAgentSchema.parse(request.body);
    if (body.managerId !== undefined && scope.role !== "admin") {
      throw new ForbiddenError("Only admins can reassign an agent's manager");
    }
    const wantsToBindClient = body.clientId !== undefined;
    const before = wantsToBindClient ? await agentService.getAgent(app.db, request.params.uuid) : null;
    const agent = await agentService.updateAgent(app.db, request.params.uuid, body);
    if (before && before.clientId === null && agent.clientId !== null) {
      notifyClientAgentPinned(agent);
    }
    return serializeAgent(agent);
  });

  app.patch<{ Params: { uuid: string } }>("/:uuid/rebind", { config: { otelRecordBody: true } }, async (request) => {
    await requireAgentAccess(request, app.db, "manage");
    const body = rebindAgentSchema.parse(request.body);
    const agent = await agentService.rebindAgent(app.db, request.params.uuid, body);
    notifyClientAgentPinned(agent);
    return serializeAgent(agent);
  });

  app.post<{ Params: { uuid: string } }>("/:uuid/disconnect", async (request, reply) => {
    await requireAgentAccess(request, app.db, "manage");
    const wasConnected = forceDisconnect(request.params.uuid);
    await presenceService.setOffline(app.db, request.params.uuid);
    return reply.status(200).send({ disconnected: wasConnected });
  });

  app.post<{ Params: { uuid: string } }>("/:uuid/suspend", async (request) => {
    await requireAgentAccess(request, app.db, "manage");
    const agent = await agentService.suspendAgent(app.db, request.params.uuid);
    return serializeAgent(agent);
  });

  app.post<{ Params: { uuid: string } }>("/:uuid/reactivate", async (request) => {
    await requireAgentAccess(request, app.db, "manage");
    const agent = await agentService.reactivateAgent(app.db, request.params.uuid);
    return serializeAgent(agent);
  });

  app.delete<{ Params: { uuid: string } }>("/:uuid", async (request, reply) => {
    await requireAgentAccess(request, app.db, "manage");
    await agentService.deleteAgent(app.db, request.params.uuid);
    return reply.status(204).send();
  });

  // ─── Avatar image (M2) ──────────────────────────────────────────────
  //
  // PUT accepts the raw image bytes as `application/octet-stream` /
  // `image/*` so we don't have to pull in `@fastify/multipart` for a
  // single-field upload. The web client always pre-resizes to ~50KB WEBP;
  // server enforces ≤ MAX_AVATAR_IMAGE_BYTES regardless.
  //
  // GET is intentionally public: `<img src>` cannot send the Authorization
  // header. The agent UUID is unguessable v7, and the surrounding ACL on
  // /api/v1/agents already keeps the UUID itself off public surfaces.
  app.addContentTypeParser(/^image\//, { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.put<{ Params: { uuid: string } }>(
    "/:uuid/avatar",
    { bodyLimit: agentService.MAX_AVATAR_IMAGE_BYTES + 1024 },
    async (request, reply) => {
      await requireAgentAccess(request, app.db, "manage");
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !contentType.startsWith("image/")) {
        throw new BadRequestError(
          `Avatar upload requires an image/* Content-Type. Supported: ${SUPPORTED_AVATAR_IMAGE_MIMES.join(", ")}.`,
        );
      }
      const mime = contentType.split(";")[0]?.trim() ?? "";
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        throw new BadRequestError("Avatar upload body must be raw image bytes.");
      }
      const updatedAt = await agentService.setAgentAvatarImage(app.db, request.params.uuid, body, mime);
      return reply.status(200).send({
        avatarImageUrl: agentAvatarImageUrl(request.params.uuid, updatedAt),
      });
    },
  );

  app.delete<{ Params: { uuid: string } }>("/:uuid/avatar", async (request, reply) => {
    await requireAgentAccess(request, app.db, "manage");
    await agentService.clearAgentAvatarImage(app.db, request.params.uuid);
    return reply.status(204).send();
  });

  // Public GET lives in `publicAgentAvatarRoutes` below (mounted outside the
  // auth scope) — `<img src>` cannot send Authorization headers.

  app.post<{ Params: { uuid: string } }>("/:uuid/test", async (request, reply) => {
    const { uuid } = request.params;
    const { agent: targetAgent } = await requireAgentAccess(request, app.db, "manage");

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
        message: "Agent is not connected. Connect the client with: first-tree-hub connect <token>",
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

    // Sender must live in the target's org. Without this scope, the owner
    // lookup (delegate_mention → uuid) or the fallback ("any other active
    // agent") can pick up an agent from an unrelated org — `findOrCreateDirectChat`
    // would then refuse the pair, and historically (before that guard) it
    // produced cross-org chats unreachable by their nominal owner.
    const [owner] = await app.db
      .select({ uuid: agents.uuid })
      .from(agents)
      .where(
        and(
          eq(agents.delegateMention, uuid),
          eq(agents.status, "active"),
          eq(agents.organizationId, targetAgent.organizationId),
        ),
      )
      .limit(1);

    let senderId = owner?.uuid ?? null;
    if (!senderId) {
      const [other] = await app.db
        .select({ uuid: agents.uuid })
        .from(agents)
        .where(
          and(
            ne(agents.uuid, uuid),
            eq(agents.status, "active"),
            eq(agents.organizationId, targetAgent.organizationId),
          ),
        )
        .limit(1);
      senderId = other?.uuid ?? null;
    }

    if (!senderId) {
      return reply.status(200).send({
        status: "error",
        message: "No suitable sender found. Need at least one other active agent in the same organization.",
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

  /**
   * POST /api/v1/agents/:uuid/chats — create a new workspace chat with the
   * target agent. Caller's HUMAN agent in the target's org speaks first.
   */
  app.post<{ Params: { uuid: string } }>("/:uuid/chats", async (request, reply) => {
    const { agent: targetAgent, scope } = await requireAgentAccess(request, app.db, "visible");
    await assertAllAgentsVisibleInOrg(app.db, scope, [targetAgent.uuid]);
    const result = await createChat(app.db, scope.humanAgentId, {
      type: "direct",
      participantIds: [targetAgent.uuid],
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

/**
 * Public read-only route for agent avatar images. Mounted outside the
 * member-JWT auth scope so `<img src>` works without bespoke fetch-and-blob
 * plumbing. Reading an avatar leaks no more than the agent's UUID — which
 * is already required to address the route — and the UUID itself is only
 * exposed through authenticated agent-list calls.
 */
export async function publicAgentAvatarRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { uuid: string }; Querystring: { v?: string } }>("/:uuid/avatar", async (request, reply) => {
    const image = await agentService.getAgentAvatarImage(app.db, request.params.uuid);
    if (!image) {
      return reply.status(404).send({ error: "Avatar not set" });
    }
    // Strong cache: each upload bumps the `?v=<epoch>` suffix on the URL,
    // so immutable + 30d is safe and avoids round-trips from chat surfaces
    // that render the image hundreds of times per session.
    reply.header("Content-Type", image.mime);
    reply.header("Cache-Control", "public, max-age=2592000, immutable");
    reply.header("ETag", `"${image.updatedAt.getTime()}"`);
    return reply.send(image.data);
  });
}
