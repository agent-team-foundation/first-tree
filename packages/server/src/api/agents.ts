import { Readable } from "node:stream";
import {
  ATTACHMENT_ERROR_CODES,
  agentPinnedMessageSchema,
  switchAgentRuntimeSchema,
  updateAgentSchema,
  updateAgentSkillsSchema,
} from "@first-tree/shared";
import { getServerCliBinding } from "@first-tree/shared/channel";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { BadRequestError, ForbiddenError, LengthRequiredError } from "../errors.js";
import { assertAllAgentsVisibleInOrg, requireAgentAccess } from "../scope/require-resource.js";
import * as agentService from "../services/agent.js";
import {
  agentAvatarImageUrl,
  fetchUserAvatarForHumanAgent,
  resolveAvatarImageUrl,
  SUPPORTED_AVATAR_IMAGE_MIMES,
} from "../services/agent.js";
import * as agentRuntimeSessionService from "../services/agent-runtime-session.js";
import * as agentRuntimeSwitchService from "../services/agent-runtime-switch.js";
import { createChat } from "../services/chat.js";
import * as clientService from "../services/client.js";
import {
  forceDisconnect,
  getAgentClientId,
  hasActiveConnection,
  sendToAgent,
  sendToClient,
} from "../services/connection-manager.js";
import {
  assertMetadataDoesNotClaimLandingCampaignTrial,
  assertMutableAgentIsNotLandingCampaignTrial,
  assertNoLandingCampaignTrialAgents,
} from "../services/landing-campaigns/guards.js";
import { WIRE_RECIPIENT_MODE } from "../services/message-dispatcher.js";
import * as presenceService from "../services/presence.js";

type AgentRow = {
  uuid: string;
  type: string;
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
 * and synthesises the public `avatarImageUrl` via {@link resolveAvatarImageUrl}
 * so human agents fall back to the backing user's external avatar URL
 * (e.g. GitHub) when no upload exists. `createdAt`/`updatedAt` are
 * coerced to ISO strings so the response is pure JSON.
 */
function serializeAgent(agent: AgentRow, userAvatarUrl: string | null): Record<string, unknown> {
  const { avatarImageData: _data, avatarImageMime: _mime, avatarImageUpdatedAt, createdAt, updatedAt, ...rest } = agent;
  return {
    ...rest,
    metadata: agentService.stripReservedAgentMetadata(rest.metadata),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    avatarImageUrl: resolveAvatarImageUrl({
      uuid: agent.uuid,
      type: agent.type,
      avatarImageUpdatedAt,
      userAvatarUrl,
    }),
  };
}

/**
 * Class C — resource-scoped per-agent routes. Mounted at
 * `/api/v1/agents/:uuid/...`. The agent's UUID locates its org
 * intrinsically; `requireAgentAccess` resolves the caller's membership in
 * that org and enforces visibility / manage rules.
 */
export async function agentRoutes(app: FastifyInstance): Promise<void> {
  function readRuntimeSwitchFaultHeader(
    request: FastifyRequest,
  ): agentRuntimeSwitchService.RuntimeSwitchFault | undefined {
    const header = request.headers["x-first-tree-runtime-switch-fault"];
    const value = Array.isArray(header) ? header[0] : header;
    if (value === undefined) return undefined;
    if (!app.config.runtime.runtimeSwitchFaultInjection) {
      throw new ForbiddenError("Runtime switch fault injection is disabled");
    }
    if (
      !agentRuntimeSwitchService.RUNTIME_SWITCH_FAULTS.includes(value as agentRuntimeSwitchService.RuntimeSwitchFault)
    ) {
      throw new BadRequestError(`Unknown runtime switch fault "${String(value)}"`);
    }
    return value as agentRuntimeSwitchService.RuntimeSwitchFault;
  }

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
      // Wire-compat: translate `type=agent` back to the pre-merge
      // `personal_assistant` so clients on ≤ 0.5.1 (strict zod) still
      // decode the frame. See agentService.legacyWireAgentType.
      agentType: agentService.legacyWireAgentType(agent.type),
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

  function notifyAgentRuntimeRouteChanged(result: {
    agent: {
      uuid: string;
      name: string | null;
      displayName: string;
      type: string;
      clientId: string | null;
      runtimeProvider: string;
    };
    oldClientId: string;
    recoveryAction?: "aborted" | "forwarded";
  }): void {
    if (!result.agent.clientId) return;
    app.notifier
      .notifyAgentRouteChange({
        agentId: result.agent.uuid,
        name: result.agent.name,
        displayName: result.agent.displayName,
        agentType: agentService.legacyWireAgentType(result.agent.type),
        oldClientId: result.recoveryAction === "aborted" || !result.oldClientId ? null : result.oldClientId,
        targetClientId: result.agent.clientId,
        runtimeProvider: result.agent.runtimeProvider,
        reason: "agent_runtime_switch",
      })
      .catch(() => {});
  }

  function shouldSendImmediatePinnedAfterRuntimeRouteChange(result: {
    agent: { clientId: string | null };
    oldClientId: string;
    recoveryAction?: "aborted" | "forwarded";
  }): boolean {
    return result.recoveryAction === "aborted" || result.agent.clientId !== result.oldClientId;
  }

  app.get<{ Params: { uuid: string } }>("/:uuid", async (request) => {
    const { agent } = await requireAgentAccess(request, app.db, "visible");
    const userAvatarUrl = await fetchUserAvatarForHumanAgent(app.db, agent);
    return serializeAgent(agent, userAvatarUrl);
  });

  app.patch<{ Params: { uuid: string } }>("/:uuid", { config: { otelRecordBody: true } }, async (request) => {
    const { agent: existingAgent, scope } = await requireAgentAccess(request, app.db, "manage");
    const body = updateAgentSchema.parse(request.body);
    assertMutableAgentIsNotLandingCampaignTrial(existingAgent);
    agentRuntimeSwitchService.assertNoRuntimeSwitchInProgress(existingAgent);
    assertMetadataDoesNotClaimLandingCampaignTrial(body.metadata);
    if (body.managerId !== undefined && scope.role !== "admin") {
      throw new ForbiddenError("Only admins can reassign an agent's manager");
    }
    // A delegate is a personal choice: only the member themselves may set,
    // change, or clear their own delegate. `manage` scope otherwise lets an
    // admin edit any agent in the org, so gate `delegateMention` writes to the
    // caller acting on their own human agent (humanAgentId === target uuid).
    if (body.delegateMention !== undefined && scope.humanAgentId !== request.params.uuid) {
      throw new ForbiddenError("Only the member themselves can set their own delegate");
    }
    const wantsToBindClient = body.clientId !== undefined;
    const before = wantsToBindClient ? await agentService.getAgent(app.db, request.params.uuid) : null;
    const agent = await agentService.updateAgent(app.db, request.params.uuid, body);
    if (before && before.clientId === null && agent.clientId !== null) {
      notifyClientAgentPinned(agent);
    }
    const userAvatarUrl = await fetchUserAvatarForHumanAgent(app.db, agent);
    return serializeAgent(agent, userAvatarUrl);
  });

  app.post<{ Params: { uuid: string } }>(
    "/:uuid/switch-runtime",
    { config: { otelRecordBody: true } },
    async (request) => {
      const { agent: existingAgent, scope } = await requireAgentAccess(request, app.db, "manage");
      assertMutableAgentIsNotLandingCampaignTrial(existingAgent);
      agentRuntimeSwitchService.assertNoRuntimeSwitchInProgress(existingAgent);
      const body = switchAgentRuntimeSchema.parse(request.body);
      const result = await agentRuntimeSwitchService.switchAgentRuntime(
        app.db,
        request.params.uuid,
        { clientId: body.clientId, runtimeProvider: body.runtimeProvider },
        { userId: scope.userId, memberId: scope.memberId },
        {
          runtimeHttpTokenEnforced: app.config.runtime.agentHttpTokenEnforcement,
          notifier: app.notifier,
          fault: readRuntimeSwitchFaultHeader(request),
        },
      );
      notifyAgentRuntimeRouteChanged(result);
      if (shouldSendImmediatePinnedAfterRuntimeRouteChange(result)) {
        notifyClientAgentPinned(result.agent);
      }
      for (const chatId of result.terminatedChatIds) {
        sendToAgent(result.agent.uuid, { type: "session:terminate", chatId });
      }
      const userAvatarUrl = await fetchUserAvatarForHumanAgent(app.db, result.agent);
      return serializeAgent(result.agent, userAvatarUrl);
    },
  );

  app.post<{ Params: { uuid: string } }>(
    "/:uuid/switch-runtime/recover",
    { config: { otelRecordBody: true } },
    async (request) => {
      const { agent: existingAgent } = await requireAgentAccess(request, app.db, "manage");
      assertMutableAgentIsNotLandingCampaignTrial(existingAgent);
      const result = await agentRuntimeSwitchService.recoverAgentRuntimeSwitch(app.db, request.params.uuid, {
        runtimeHttpTokenEnforced: app.config.runtime.agentHttpTokenEnforcement,
        notifier: app.notifier,
        fault: readRuntimeSwitchFaultHeader(request),
      });
      notifyAgentRuntimeRouteChanged(result);
      if (shouldSendImmediatePinnedAfterRuntimeRouteChange(result)) {
        notifyClientAgentPinned(result.agent);
      }
      for (const chatId of result.terminatedChatIds) {
        sendToAgent(result.agent.uuid, { type: "session:terminate", chatId });
      }
      const userAvatarUrl = await fetchUserAvatarForHumanAgent(app.db, result.agent);
      return serializeAgent(result.agent, userAvatarUrl);
    },
  );

  app.post<{ Params: { uuid: string } }>("/:uuid/disconnect", async (request, reply) => {
    const { agent } = await requireAgentAccess(request, app.db, "manage");
    assertMutableAgentIsNotLandingCampaignTrial(agent);
    agentRuntimeSwitchService.assertNoRuntimeSwitchInProgress(agent);
    await agentRuntimeSessionService.revokeAgentRuntimeSession(app.db, request.params.uuid);
    const wasConnected = forceDisconnect(request.params.uuid);
    await presenceService.setOffline(app.db, request.params.uuid);
    return reply.status(200).send({ disconnected: wasConnected });
  });

  app.post<{ Params: { uuid: string } }>("/:uuid/suspend", async (request) => {
    const { agent: existingAgent } = await requireAgentAccess(request, app.db, "manage");
    assertMutableAgentIsNotLandingCampaignTrial(existingAgent);
    agentRuntimeSwitchService.assertNoRuntimeSwitchInProgress(existingAgent);
    const agent = await agentService.suspendAgent(app.db, request.params.uuid);
    await agentRuntimeSessionService.revokeAgentRuntimeSession(app.db, request.params.uuid);
    forceDisconnect(request.params.uuid, "agent_suspended");
    await presenceService.setOffline(app.db, request.params.uuid);
    const userAvatarUrl = await fetchUserAvatarForHumanAgent(app.db, agent);
    return serializeAgent(agent, userAvatarUrl);
  });

  app.post<{ Params: { uuid: string } }>("/:uuid/reactivate", async (request) => {
    const { agent: existingAgent } = await requireAgentAccess(request, app.db, "manage");
    assertMutableAgentIsNotLandingCampaignTrial(existingAgent);
    agentRuntimeSwitchService.assertNoRuntimeSwitchInProgress(existingAgent);
    const agent = await agentService.reactivateAgent(app.db, request.params.uuid);
    notifyClientAgentPinned(agent);
    const userAvatarUrl = await fetchUserAvatarForHumanAgent(app.db, agent);
    return serializeAgent(agent, userAvatarUrl);
  });

  app.delete<{ Params: { uuid: string } }>("/:uuid", async (request, reply) => {
    const { agent } = await requireAgentAccess(request, app.db, "manage");
    assertMutableAgentIsNotLandingCampaignTrial(agent);
    agentRuntimeSwitchService.assertNoRuntimeSwitchInProgress(agent);
    await agentService.deleteAgent(app.db, request.params.uuid);
    return reply.status(204).send();
  });

  // ─── Avatar image (M2) ──────────────────────────────────────────────
  //
  // PUT accepts the raw image bytes as `image/*` so we don't have to pull
  // in `@fastify/multipart` for a single-field upload. The parser hands
  // the raw stream through and the service pipes it straight to object
  // storage — the payload is never buffered in Node. Content-Length is
  // required (411): the ≤ MAX_AVATAR_IMAGE_BYTES cap is enforced on the
  // declared size before the body is consumed, then byte-exactly during
  // the stream. The web client always pre-resizes to ~50KB WEBP.
  //
  // GET is intentionally public: `<img src>` cannot send the Authorization
  // header. The agent UUID is unguessable v7, and the surrounding ACL on
  // /api/v1/agents already keeps the UUID itself off public surfaces.
  app.addContentTypeParser(/^image\//, (_req, payload, done) => {
    done(null, payload);
  });

  app.put<{ Params: { uuid: string } }>("/:uuid/avatar", async (request, reply) => {
    const { agent } = await requireAgentAccess(request, app.db, "manage");
    assertMutableAgentIsNotLandingCampaignTrial(agent);
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.startsWith("image/")) {
      throw new BadRequestError(
        `Avatar upload requires an image/* Content-Type. Supported: ${SUPPORTED_AVATAR_IMAGE_MIMES.join(", ")}.`,
      );
    }
    const mime = contentType.split(";")[0]?.trim() ?? "";
    const rawLength = request.headers["content-length"];
    const contentLength = typeof rawLength === "string" ? Number.parseInt(rawLength, 10) : Number.NaN;
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw new LengthRequiredError("Avatar uploads must declare Content-Length", {
        code: ATTACHMENT_ERROR_CODES.lengthRequired,
      });
    }
    const body = request.body;
    if (!(body instanceof Readable)) {
      throw new BadRequestError("Avatar upload body must be raw image bytes.");
    }
    const updatedAt = await agentService.setAgentAvatarImage(app.db, app.objectStorage, request.params.uuid, body, {
      mime,
      contentLength,
    });
    return reply.status(200).send({
      avatarImageUrl: agentAvatarImageUrl(request.params.uuid, updatedAt),
    });
  });

  app.delete<{ Params: { uuid: string } }>("/:uuid/avatar", async (request, reply) => {
    const { agent } = await requireAgentAccess(request, app.db, "manage");
    assertMutableAgentIsNotLandingCampaignTrial(agent);
    await agentService.clearAgentAvatarImage(app.db, app.objectStorage, request.params.uuid);
    return reply.status(204).send();
  });

  // ─── Skills (slash-command catalog) ─────────────────────────────────
  //
  // GET is `visible`: any chat member with line-of-sight to the agent can
  // read its skill list to render the slash-command popover after they
  // `@mention` it. PATCH is `manage`: only the manager's daemon may upload
  // — the same scope that PATCHes runtime config and capabilities.
  //
  // The PATCH body replaces the list in full (snapshot semantics). The
  // daemon uploads the full payload once per restart (see
  // `apps/cli/src/commands/daemon/start.ts`) — no per-skill diff, no
  // content-hash short-circuit yet. Restart cadence is low enough that
  // write-amplification hasn't shown up; a hash check belongs on the
  // client side if it ever does.

  app.get<{ Params: { uuid: string } }>("/:uuid/skills", async (request) => {
    await requireAgentAccess(request, app.db, "visible");
    const skills = await agentService.getAgentSkills(app.db, request.params.uuid);
    return { skills };
  });

  app.patch<{ Params: { uuid: string } }>("/:uuid/skills", async (request, reply) => {
    const { agent } = await requireAgentAccess(request, app.db, "manage");
    assertMutableAgentIsNotLandingCampaignTrial(agent);
    const body = updateAgentSkillsSchema.parse(request.body);
    await agentService.updateAgentSkills(app.db, request.params.uuid, body.skills);
    return reply.status(204).send();
  });

  // Public GET lives in `publicAgentAvatarRoutes` below (mounted outside the
  // auth scope) — `<img src>` cannot send Authorization headers.

  /**
   * POST /:uuid/test — health-only connection probe.
   *
   * Reports whether the agent's WS client is currently connected, stale
   * (no heartbeat for STALE_THRESHOLD_MS), or offline, plus the client
   * descriptor when known. Returns immediately — no chat is created, no
   * LLM round-trip is exercised. Diagnosing end-to-end LLM behaviour is
   * the user's own workflow, not an admin endpoint.
   */
  app.post<{ Params: { uuid: string } }>("/:uuid/test", async (request, reply) => {
    const { uuid } = request.params;
    await requireAgentAccess(request, app.db, "manage");

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
        message: `Agent is not connected. Connect the client with: ${getServerCliBinding().binName} login <code>`,
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

    return reply.status(200).send({
      status: "success",
      message: "Agent client is connected and heartbeating.",
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
    await assertNoLandingCampaignTrialAgents(app.db, [targetAgent.uuid]);
    const result = await createChat(app.db, scope.humanAgentId, {
      type: "group",
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
        // v2: wire `mode` field is decision-inert. Project the constant.
        mode: WIRE_RECIPIENT_MODE,
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
    reply.header("Cache-Control", "public, max-age=2592000, immutable");
    reply.header("ETag", `"${image.updatedAt.getTime()}"`);

    // Transitional branch: payload still inline in PG (pre-migration row).
    if (image.data) {
      reply.header("Content-Type", image.mime);
      return reply.send(image.data);
    }

    const objectStorage = app.objectStorage;
    if (!objectStorage || !image.objectKey) {
      // objectKey is set whenever data is absent; a missing storage config
      // for a migrated avatar is a deployment gap, not a client error.
      request.log.error(
        { uuid: request.params.uuid },
        "avatar payload is in object storage but storage is unavailable",
      );
      return reply.status(503).send({ error: "Avatar storage unavailable" });
    }

    // Avatars are always proxied, regardless of `attachments.downloadMode`:
    // a 302 to a presigned URL varies per request (fresh signature), which
    // would defeat the immutable browser cache this surface depends on —
    // chat surfaces render the same avatar hundreds of times per session.
    // The payload is ≤ 512 KiB and streamed, so proxying stays cheap.
    const object = await objectStorage.getObjectStream(image.objectKey);
    if (!object) {
      request.log.error(
        { uuid: request.params.uuid, objectKey: image.objectKey },
        "avatar payload missing from object storage",
      );
      return reply.status(404).send({ error: "Avatar not set" });
    }
    reply.header("Content-Type", image.mime);
    if (object.contentLength !== undefined) {
      reply.header("Content-Length", object.contentLength);
    }
    reply.raw.once("close", () => {
      object.body.destroy();
    });
    return reply.send(object.body);
  });
}
