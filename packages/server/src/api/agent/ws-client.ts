import {
  AGENT_BIND_REJECT_REASONS,
  type AgentBindRejectReason,
  AUTH_REJECTED_CODES,
  AUTH_RETRYABLE_CODES,
  type AuthRejectedCode,
  type AuthRetryableCode,
  agentBindRequestSchema,
  agentPinnedMessageSchema,
  clientRegisterSchema,
  type InboxEntryWithMessage,
  inboxAckFrameSchema,
  inboxDeliverFrameSchema,
  inboxRecoverFrameSchema,
  PROVIDER_MODELS_LIST_TYPE,
  PROVIDER_MODELS_RESULT_TYPE,
  providerModelsResultFrameSchema,
  runtimeStateMessageSchema,
  sessionEventMessageSchema,
  sessionEventRejectedReasonSchema,
  sessionReconcileRequestSchema,
  sessionRuntimeMessageSchema,
  sessionStateMessageSchema,
  WS_AUTH_FRAME_TIMEOUT_MS,
  wsAuthFrameSchema,
} from "@first-tree/shared";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { jwtVerify } from "jose";
import type { WebSocket } from "ws";
import { z } from "zod";
import { agentChatSessions } from "../../db/schema/agent-chat-sessions.js";
import { agents } from "../../db/schema/agents.js";
import { clients } from "../../db/schema/clients.js";
import { members } from "../../db/schema/members.js";
import { users } from "../../db/schema/users.js";
import { ClientOrgMismatchError, ClientRetiredError, ClientUserMismatchError } from "../../errors.js";
import {
  classifyJoseError,
  decodeJwtForTrace,
  endWsConnectionSpan,
  type JwtFailureReason,
  setWsConnectionAttrs,
  startWsConnectionSpan,
  untrustedAttrs,
  withWsMessageSpan,
} from "../../observability/index.js";
import * as activityService from "../../services/activity.js";
import * as agentService from "../../services/agent.js";
import * as agentRuntimeSessionService from "../../services/agent-runtime-session.js";
import * as agentRuntimeSwitchService from "../../services/agent-runtime-switch.js";
import * as clientService from "../../services/client.js";
import * as connectionManager from "../../services/connection-manager.js";
import * as contextTreeIoService from "../../services/context-tree-io.js";
import * as inboxService from "../../services/inbox.js";
import * as landingCampaignChatStateService from "../../services/landing-campaigns/chat-state.js";
import * as notificationService from "../../services/notification.js";
import type { InboxPushHandler, Notifier } from "../../services/notifier.js";
import * as presenceService from "../../services/presence.js";
import { readModelCatalogRpcResult, storeModelCatalogRpcResult } from "../../services/provider-models-rpc.js";
import * as runtimeLivenessService from "../../services/runtime-liveness.js";
import * as sessionEventService from "../../services/session-event.js";

/**
 * Default per-agent in-flight fuse when `server.inbox.maxInFlightPerAgent` is
 * unset. Normal delivery fairness is per `(agent, chat)`; this high-water
 * value bounds pathological recovery storms and badly stalled clients.
 */
const DEFAULT_INBOX_MAX_IN_FLIGHT_PER_AGENT = 8192;
/**
 * Default per-(agent, chat) fairness window. A long turn may fill its own
 * chat-local window, but it should not block delivery to the same agent's
 * other chats.
 */
const DEFAULT_INBOX_MAX_IN_FLIGHT_PER_AGENT_CHAT = 8;
/**
 * Hard cap on entries scanned in a single backlog drain so a recovering
 * client doesn't trigger an arbitrarily large transaction or burst of
 * frames. Anything beyond this stays `pending` and gets picked up by
 * subsequent post-ack drains. Same constant covers both the agent:bound
 * recovery path and the post-ack top-up.
 *
 * Subsequent NOTIFYs and post-ack top-ups continue draining without a
 * single-transaction megabatch.
 */
const INBOX_BACKLOG_BATCH_LIMIT = 50;
/**
 * Low-frequency safety net for missed PG NOTIFY events while the WebSocket
 * remains online. The durable queue is still `inbox_entries`; this only adds a
 * bounded extra trigger for sockets this server instance already owns.
 */
const INBOX_BACKLOG_REPAIR_INTERVAL_MS = 30_000;

const wsMessageSchema = z.object({
  type: z.string(),
  agentId: z.string().optional(),
  ref: z.string().optional(),
});

/**
 * Client WebSocket: one WS per client, multiple agents multiplexed.
 *
 * Protocol (unified-user-token milestone):
 *   1. Client connects; server waits up to {@link WS_AUTH_FRAME_TIMEOUT_MS}
 *      for the first `auth` frame carrying a member access JWT.
 *      Deterministic credential/identity failures ⇒ `auth:rejected` + 4401;
 *      expiry ⇒ `auth:expired` + 4401; transient handshake failures ⇒
 *      `auth:retryable` / 1011 / 1013.
 *   2. `client:register` — bind the client_id to the authenticated user.
 *   3. `agent:bind` — run Rule R-RUN (no token); populate presence.
 *   4. `session:state` / `runtime:state` / `session:event` / `heartbeat`.
 *   5. `agent:unbind` — stop multiplexing for a specific agent.
 *
 * When the JWT is about to expire the server sends `auth:expired` so the
 * SDK can refresh and reconnect without silently half-opening the socket.
 */

/**
 * Authenticated WS session state.
 *
 * Carries only the user identity; org scope is no longer attached to the
 * connection (decouple-client-from-identity §4.2). Bind-time R-RUN resolves
 * the agent's owner via the `agents → manager → user` JOIN at every
 * `agent:bind`, so a revoked or re-scoped membership takes effect the moment
 * the DB row changes — no socket-level cache to invalidate.
 */
type AuthenticatedSession = {
  userId: string;
};

type WsAuthPhase =
  | "auth_frame_timeout"
  | "auth_frame_validation"
  | "jwt_verify"
  | "claims_validation"
  | "user_lookup"
  | "post_auth_welcome"
  | "client_register";

type WsAuthOutcome = "accepted" | "expired" | "rejected" | "retryable" | "protocol_error";

function sendJsonOrThrow(socket: WebSocket, frame: unknown): void {
  if (socket.readyState !== socket.OPEN) {
    throw new Error("WebSocket is not open");
  }
  socket.send(JSON.stringify(frame));
}

function setAuthWsAttrs(
  socket: WebSocket,
  attrs: {
    phase: WsAuthPhase;
    outcome: WsAuthOutcome;
    code: string;
    retryable: boolean;
    closeCode?: number;
    errorClass?: string;
    extraAttrs?: Record<string, string | number | boolean>;
  },
): void {
  setWsConnectionAttrs(socket, {
    "auth.ws.phase": attrs.phase,
    "auth.ws.outcome": attrs.outcome,
    "auth.ws.code": attrs.code,
    "auth.ws.retryable": attrs.retryable,
    "auth.ws.close_code": attrs.closeCode,
    ...(attrs.errorClass ? { "auth.ws.error_class": attrs.errorClass } : {}),
    ...(attrs.extraAttrs ?? {}),
  });
}

function closeWithAuthRejected(
  socket: WebSocket,
  phase: WsAuthPhase,
  code: AuthRejectedCode,
  message?: string,
  errorClass?: string,
  extraAttrs?: Record<string, string | number | boolean>,
): void {
  setAuthWsAttrs(socket, {
    phase,
    outcome: "rejected",
    code,
    retryable: false,
    closeCode: 4401,
    errorClass,
    extraAttrs,
  });
  try {
    sendJsonOrThrow(socket, {
      type: "auth:rejected",
      code,
      ...(message ? { message } : {}),
    });
  } catch {
    // socket may already be gone; close below is still idempotent
  }
  socket.close(4401, "auth rejected");
}

function closeWithAuthExpired(
  socket: WebSocket,
  phase: WsAuthPhase,
  extraAttrs?: Record<string, string | number | boolean>,
  errorClass?: string,
): void {
  setAuthWsAttrs(socket, {
    phase,
    outcome: "expired",
    code: "jwt_expired",
    retryable: true,
    closeCode: 4401,
    extraAttrs,
    errorClass,
  });
  try {
    sendJsonOrThrow(socket, { type: "auth:expired" });
  } catch {
    // socket may already be gone
  }
  socket.close(4401, "auth expired");
}

function closeWithAuthRetryable(
  socket: WebSocket,
  phase: WsAuthPhase,
  code: AuthRetryableCode,
  closeCode: 1011 | 1013,
  message?: string,
  errorClass?: string,
): void {
  setAuthWsAttrs(socket, { phase, outcome: "retryable", code, retryable: true, closeCode, errorClass });
  try {
    sendJsonOrThrow(socket, {
      type: "auth:retryable",
      code,
      ...(message ? { message } : {}),
    });
  } catch {
    // socket may already be gone
  }
  socket.close(closeCode, "auth retryable");
}

function joseErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  if (!("code" in err)) return undefined;
  const code = err.code;
  return typeof code === "string" ? code : undefined;
}

function rejectedCodeForJoseError(reason: JwtFailureReason, err: unknown): AuthRejectedCode {
  if (joseErrorCode(err) === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
    return AUTH_REJECTED_CODES.INVALID_CLAIMS;
  }
  switch (reason) {
    case "jwt_signature_invalid":
    case "jwt_malformed":
    case "jwt_verify_failed":
      return AUTH_REJECTED_CODES.INVALID_TOKEN;
    case "jwt_expired":
      return AUTH_REJECTED_CODES.INVALID_TOKEN;
  }
}

function sendRejected(socket: WebSocket, ref: string | undefined, reason: AgentBindRejectReason): void {
  socket.send(JSON.stringify({ type: "agent:bind:rejected", ref, reason }));
}

export function clientWsRoutes(notifier: Notifier, instanceId: string) {
  return async (app: FastifyInstance): Promise<void> => {
    const jwtSecretBytes = new TextEncoder().encode(app.config.secrets.jwtSecret);

    const inboxMaxInFlightPerAgent = app.config.inbox?.maxInFlightPerAgent ?? DEFAULT_INBOX_MAX_IN_FLIGHT_PER_AGENT;
    const inboxMaxInFlightPerAgentChat =
      app.config.inbox?.maxInFlightPerAgentChat ?? DEFAULT_INBOX_MAX_IN_FLIGHT_PER_AGENT_CHAT;

    notifier.onAgentRouteChange((payload) => {
      if (payload.oldClientId) {
        connectionManager.forceDisconnect(payload.agentId, payload.reason, payload.oldClientId);
      }
      const frame = agentPinnedMessageSchema.safeParse({
        type: "agent:pinned",
        agentId: payload.agentId,
        name: payload.name,
        displayName: payload.displayName,
        agentType: payload.agentType,
        runtimeProvider: payload.runtimeProvider,
      });
      if (!frame.success) {
        app.log.warn(
          { err: frame.error.flatten(), agentId: payload.agentId, clientId: payload.targetClientId },
          "agent route change frame failed schema validation — not sending",
        );
        return;
      }
      connectionManager.sendToClient(payload.targetClientId, frame.data);
    });

    // Cross-replica reverse commands: only the DB-authoritative instance may
    // deliver. A stale open socket on a previous replica must not receive the
    // same ref after reconnect/takeover.
    notifier.onDaemonClientCommand((payload) => {
      if (payload.type !== PROVIDER_MODELS_LIST_TYPE) return;
      if (payload.targetInstanceId !== instanceId) return;
      connectionManager.sendToClient(payload.clientId, {
        type: PROVIDER_MODELS_LIST_TYPE,
        provider: payload.provider,
        ref: payload.ref,
      });
    });

    // Cross-replica result wake: catalog is in clients.metadata; resolve any
    // local HTTP waiter that registered waitForClientReply for this ref.
    notifier.onDaemonClientCommandResult((payload) => {
      void (async () => {
        const catalog = await readModelCatalogRpcResult(app.db, payload.clientId, payload.ref);
        if (!catalog) return;
        connectionManager.resolveClientReply(payload.clientId, payload.ref, catalog);
      })().catch((err) => {
        app.log.debug({ err, clientId: payload.clientId, ref: payload.ref }, "provider-models result wake failed");
      });
    });

    // WS upgrade is excluded from HTTP tracing in app.ts via the autotelic
    // plugin's `ignoreRoutes` — fastify hijacks the reply on upgrade, so a
    // `onResponse`-terminated HTTP span would never end. The connection's
    // observability lifecycle is handled by `startWsConnectionSpan` /
    // `endWsConnectionSpan` below, with per-message spans parented onto it.
    app.get("/client", { websocket: true }, async (socket, request) => {
      const ua = request.headers["user-agent"];
      startWsConnectionSpan(socket, {
        remoteIp: request.ip,
        userAgent: typeof ua === "string" ? ua.slice(0, 200) : undefined,
      });
      let session: AuthenticatedSession | null = null;
      // JWT default org claim — kept solely so `registerClient` can satisfy
      // the legacy `clients.organization_id` NOT NULL constraint as a
      // placeholder (see decouple-client-from-identity §4.1.1). NOT consulted
      // by any rule; never compared against `agent.organizationId` or used
      // for visibility filtering.
      let jwtDefaultOrgId: string | null = null;
      let clientId: string | null = null;
      let authExpiryTimer: NodeJS.Timeout | null = null;
      // `organizationId` is cached per-bound-agent (not per-session): the agent
      // table is the authority for an agent's org, and frames that need to
      // emit org-scoped NOTIFY (admin WS broadcast filter) read it from this
      // cache rather than the long-retired session.organizationId.
      const boundAgents = new Map<
        string,
        { agentId: string; inboxId: string; organizationId: string; runtimeProvider: string }
      >();

      type InboxInFlightChatBucket = {
        chatId: string | null;
        entryIds: Set<number>;
      };
      type InboxInFlightOwner = {
        agentId: string;
        chatKey: string;
      };

      /**
       * Per-socket in-flight `inbox:deliver` ids for backpressure. Tracking ids
       * instead of scalar counters lets ACK and same-socket recovery remove
       * exactly the reset rows before redelivery, so the cap cannot leak when
       * an entry is delivered twice on the same connection.
       */
      const inboxInFlightByAgent = new Map<string, Map<string, InboxInFlightChatBucket>>();
      const inboxInFlightOwnersByEntryId = new Map<number, InboxInFlightOwner>();
      /**
       * Socket-wide inbox operation queue. This is intentionally stronger than
       * per-agent delivery serialization: `inbox:ack` does not carry an
       * agentId, so putting ACK DB updates, recovery resets, and delivery
       * drains in one FIFO is the simple way to preserve WS frame order for
       * the ACK/recover race.
       */
      let inboxOperationQueue: Promise<void> = Promise.resolve();
      const lastInboxRepairDrainAtByAgent = new Map<string, number>();

      function sendPinnedAgentFrame(agent: {
        uuid: string;
        name: string | null;
        displayName: string;
        type: string;
        runtimeProvider: string;
      }): void {
        const parsed = agentPinnedMessageSchema.safeParse({
          type: "agent:pinned",
          agentId: agent.uuid,
          name: agent.name,
          displayName: agent.displayName,
          // Wire-compat: translate `type=agent` back to the pre-merge
          // `personal_assistant` so clients on ≤ 0.5.1 (strict zod)
          // still decode the frame. See agentService.legacyWireAgentType.
          agentType: agentService.legacyWireAgentType(agent.type),
          runtimeProvider: agent.runtimeProvider,
        });
        if (!parsed.success) {
          app.log.warn(
            { err: parsed.error.flatten(), agentId: agent.uuid, clientId },
            "agent:pinned backfill frame failed schema validation — skipping",
          );
          return;
        }
        socket.send(JSON.stringify(parsed.data));
      }

      async function reconcilePinnedAgentsForClient(): Promise<void> {
        if (!clientId || socket.readyState !== socket.OPEN) return;
        const pinned = await clientService.listActiveAgentsPinnedToClient(app.db, clientId);
        for (const agent of pinned) {
          const local = boundAgents.get(agent.uuid);
          if (local?.runtimeProvider === agent.runtimeProvider && isAgentStillRoutedHere(agent.uuid)) {
            continue;
          }
          sendPinnedAgentFrame(agent);
        }
      }

      function isAgentStillRoutedHere(agentId: string): boolean {
        return (
          boundAgents.has(agentId) && clientId !== null && connectionManager.getAgentClientId(agentId) === clientId
        );
      }

      function dropLocalAgentBinding(agentId: string, reason: string): void {
        const info = boundAgents.get(agentId);
        if (info) {
          notifier.unsubscribe(info.inboxId, socket);
        }
        boundAgents.delete(agentId);
        lastInboxRepairDrainAtByAgent.delete(agentId);
        clearInboxInFlightForAgent(agentId);
        if (clientId) {
          connectionManager.unbindAgentFromClient(agentId, clientId);
        }
        app.log.info({ clientId, agentId, reason }, "dropped stale local agent binding");
      }

      async function ensureAgentStillRoutedHere(agentId: string): Promise<boolean> {
        if (!isAgentStillRoutedHere(agentId)) return false;
        const info = boundAgents.get(agentId);
        if (!info || !clientId) return false;
        const [row] = await app.db
          .select({
            clientId: agents.clientId,
            runtimeProvider: agents.runtimeProvider,
            status: agents.status,
            metadata: agents.metadata,
          })
          .from(agents)
          .where(eq(agents.uuid, agentId))
          .limit(1);
        if (row?.clientId === clientId && row.status === "active" && row.runtimeProvider === info.runtimeProvider) {
          return true;
        }
        const switchClaim = agentRuntimeSwitchService.getRuntimeSwitchClaim(row?.metadata);
        if (
          row?.status === "suspended" &&
          switchClaim?.phase === "claimed" &&
          switchClaim.oldClientId === clientId &&
          switchClaim.oldRuntimeProvider === info.runtimeProvider
        ) {
          return false;
        }
        dropLocalAgentBinding(agentId, "authoritative_route_changed");
        return false;
      }

      function inboxInFlightCount(agentId: string): number {
        const byChat = inboxInFlightByAgent.get(agentId);
        if (!byChat) return 0;
        let total = 0;
        for (const bucket of byChat.values()) total += bucket.entryIds.size;
        return total;
      }

      function inboxChatKey(chatId: string | null): string {
        return chatId === null ? "null" : `chat:${chatId}`;
      }

      function inboxInFlightCountForChat(agentId: string, chatId: string | null): number {
        return inboxInFlightByAgent.get(agentId)?.get(inboxChatKey(chatId))?.entryIds.size ?? 0;
      }

      function inboxInFlightChatBudgets(agentId: string): Array<{ chatId: string | null; remaining: number }> {
        const byChat = inboxInFlightByAgent.get(agentId);
        if (!byChat) return [];
        return [...byChat.values()].map((bucket) => ({
          chatId: bucket.chatId,
          remaining: Math.max(0, inboxMaxInFlightPerAgentChat - bucket.entryIds.size),
        }));
      }

      function logPerChatCaps(agentId: string, inboxId: string, inFlightCount: number): void {
        const byChat = inboxInFlightByAgent.get(agentId);
        if (!byChat) return;
        for (const bucket of byChat.values()) {
          if (bucket.entryIds.size < inboxMaxInFlightPerAgentChat) continue;
          app.log.debug(
            {
              agentId,
              inboxId,
              chatId: bucket.chatId,
              inFlightCount,
              chatInFlightCount: bucket.entryIds.size,
              globalCap: inboxMaxInFlightPerAgent,
              chatCap: inboxMaxInFlightPerAgentChat,
            },
            "inbox push: per-chat cap active, skipping capped chat backlog",
          );
        }
      }

      function removeInboxInFlight(entryIds: readonly number[]): void {
        for (const entryId of entryIds) {
          const owner = inboxInFlightOwnersByEntryId.get(entryId);
          if (!owner) continue;
          const byChat = inboxInFlightByAgent.get(owner.agentId);
          const bucket = byChat?.get(owner.chatKey);
          bucket?.entryIds.delete(entryId);
          inboxInFlightOwnersByEntryId.delete(entryId);
          if (bucket && bucket.entryIds.size === 0) byChat?.delete(owner.chatKey);
          if (byChat && byChat.size === 0) inboxInFlightByAgent.delete(owner.agentId);
        }
      }

      function addInboxInFlight(agentId: string, chatId: string | null, entryId: number): void {
        removeInboxInFlight([entryId]);
        const chatKey = inboxChatKey(chatId);
        const byChat = inboxInFlightByAgent.get(agentId) ?? new Map<string, InboxInFlightChatBucket>();
        const bucket = byChat.get(chatKey) ?? { chatId, entryIds: new Set<number>() };
        bucket.entryIds.add(entryId);
        byChat.set(chatKey, bucket);
        inboxInFlightByAgent.set(agentId, byChat);
        inboxInFlightOwnersByEntryId.set(entryId, { agentId, chatKey });
      }

      function clearInboxInFlightForAgent(agentId: string): void {
        const byChat = inboxInFlightByAgent.get(agentId);
        if (!byChat) return;
        for (const bucket of byChat.values()) {
          for (const entryId of bucket.entryIds) inboxInFlightOwnersByEntryId.delete(entryId);
        }
        inboxInFlightByAgent.delete(agentId);
      }

      function chainInboxDelivery(_agentId: string, op: () => Promise<void>): Promise<void> {
        const prev = inboxOperationQueue;
        const next = prev.then(op, op);
        inboxOperationQueue = next.catch(() => {});
        return next;
      }

      /**
       * Returns `false` when the socket has already moved out of `OPEN` —
       * the only failure mode the caller can observe synchronously.
       *
       * Note: `ws.send` is fire-and-forget; a buffered frame that fails
       * to actually flush (TCP slow-close, internal queue full) does NOT
       * surface here. That class of loss is recovered when the client
       * reconnects: `agent:bind` resets every still-`delivered` row back
       * to `pending` before draining (see
       * docs/inflight-message-recovery-design.md §4). If you ever need
       * flush-level confirmation, switch to the `ws.send(frame, cb)`
       * callback form (see `notifier.ts pushFrameToInbox`).
       */
      function sendInboxDeliverFrame(entry: InboxEntryWithMessage): boolean {
        if (socket.readyState !== socket.OPEN) return false;
        const frame = {
          type: "inbox:deliver",
          entryId: entry.id,
          inboxId: entry.inboxId,
          chatId: entry.chatId,
          message: entry.message,
        };
        // Self-validate the wire shape against the same schema the client
        // applies. A failure here means the server has serialised something
        // the client will reject — log loudly so a schema-drift bug surfaces
        // server-side instead of getting stuck behind the client's silent
        // drop. We still send the frame: client also logs the issue, and
        // dropping here unilaterally would leave the entry as `delivered`
        // forever (unable to ack on a frame the client never saw).
        const validated = inboxDeliverFrameSchema.safeParse(frame);
        if (!validated.success) {
          app.log.error(
            {
              entryId: entry.id,
              inboxId: entry.inboxId,
              issues: validated.error.issues.map((i) => ({
                path: i.path.join("."),
                code: i.code,
                message: i.message,
              })),
            },
            "inbox:deliver frame failed self-validation — wire shape drift",
          );
        }
        socket.send(JSON.stringify(frame));
        return true;
      }

      /**
       * Build the per-socket push handler bound to a specific agent. A NOTIFY
       * is only a wake-up hint; the handler drains pending backlog oldest-first
       * instead of exact-claiming the notified messageId. The per-agent delivery
       * queue above serializes claim+send so two NOTIFYs cannot reorder same-chat
       * frames before the client records attempt membership.
       */
      function makeInboxPushHandler(agentId: string, inboxId: string): InboxPushHandler {
        return (messageId: string) =>
          chainInboxDelivery(agentId, () => drainBacklogForAgent(agentId, inboxId, { source: "notify", messageId }));
      }

      function maybeRepairInboxBacklog(agentId: string, inboxId: string): void {
        if (socket.readyState !== socket.OPEN) return;
        if (!isAgentStillRoutedHere(agentId)) return;

        const now = Date.now();
        const lastRepairAt = lastInboxRepairDrainAtByAgent.get(agentId) ?? 0;
        if (now - lastRepairAt < INBOX_BACKLOG_REPAIR_INTERVAL_MS) return;
        lastInboxRepairDrainAtByAgent.set(agentId, now);

        chainInboxDelivery(agentId, () => drainBacklogForAgent(agentId, inboxId, { source: "repair" })).catch((err) => {
          app.log.error({ err, agentId, inboxId }, "inbox backlog repair crashed");
        });
      }

      /**
       * Drain up to `INBOX_BACKLOG_BATCH_LIMIT` pending entries for an agent
       * over the current WS. Normal scheduling is capped by the per-chat
       * fairness window; the agent-wide cap is only a high-water fuse.
       *
       * Used in four places:
       *   1. Right after `agent:bound` — covers reconnects where NOTIFYs
       *      were dropped while the socket was offline.
       *   2. Right after an `inbox:ack` — top up the in-flight slot just
       *      freed, in case the previous NOTIFY was dropped at-cap.
       *   3. On `inbox:recover` — reset and redeliver one chat's unacked
       *      recovery debt.
       *   4. Low-frequency bound-socket repair — drains durable pending
       *      notify rows when PG NOTIFY was missed but the socket stayed up.
       *
       * Delivery operations are serialized on the socket, so budget checks and the
       * subsequent claim/send loop observe one consistent per-socket in-flight
       * counter. That ordering is part of the ack-through safety contract.
       */
      async function drainBacklogForAgent(
        agentId: string,
        inboxId: string,
        trigger?:
          | { source: "notify"; messageId: string }
          | { source: "bind" | "ack" | "repair" }
          | { source: "recover"; chatId: string },
      ): Promise<void> {
        if (socket.readyState !== socket.OPEN) return;
        if (!(await ensureAgentStillRoutedHere(agentId))) return;
        const inFlight = inboxInFlightCount(agentId);
        const globalSlotsFree = inboxMaxInFlightPerAgent - inFlight;
        if (globalSlotsFree <= 0) {
          app.log.warn(
            {
              agentId,
              inboxId,
              chatId: trigger?.source === "recover" ? trigger.chatId : null,
              messageId: trigger?.source === "notify" ? trigger.messageId : undefined,
              inFlightCount: inFlight,
              chatInFlightCount:
                trigger?.source === "recover" ? inboxInFlightCountForChat(agentId, trigger.chatId) : undefined,
              globalCap: inboxMaxInFlightPerAgent,
              chatCap: inboxMaxInFlightPerAgentChat,
            },
            "inbox push: global in-flight fuse reached, leaving backlog pending",
          );
          return;
        }
        logPerChatCaps(agentId, inboxId, inFlight);

        const recoverChatId = trigger?.source === "recover" ? trigger.chatId : undefined;
        const limit =
          recoverChatId === undefined
            ? Math.min(globalSlotsFree, INBOX_BACKLOG_BATCH_LIMIT)
            : Math.min(
                globalSlotsFree,
                Math.max(0, inboxMaxInFlightPerAgentChat - inboxInFlightCountForChat(agentId, recoverChatId)),
                INBOX_BACKLOG_BATCH_LIMIT,
              );
        if (limit <= 0) {
          if (recoverChatId !== undefined) {
            app.log.debug(
              {
                agentId,
                inboxId,
                chatId: recoverChatId,
                inFlightCount: inFlight,
                chatInFlightCount: inboxInFlightCountForChat(agentId, recoverChatId),
                globalCap: inboxMaxInFlightPerAgent,
                chatCap: inboxMaxInFlightPerAgentChat,
              },
              "inbox push: recovery chat at per-chat cap, leaving backlog pending",
            );
          }
          return;
        }

        let entries: InboxEntryWithMessage[];
        try {
          entries =
            trigger?.source === "recover"
              ? await inboxService.claimBacklogForPushForChat(app.db, inboxId, trigger.chatId, limit)
              : await inboxService.claimBacklogForPushFair(app.db, inboxId, {
                  limit,
                  defaultPerChatLimit: inboxMaxInFlightPerAgentChat,
                  chatBudgets: inboxInFlightChatBudgets(agentId),
                });
        } catch (err) {
          app.log.error({ err, agentId, inboxId, limit }, "claim backlog for WS push failed");
          return;
        }

        if (trigger?.source === "repair" && entries.length > 0) {
          app.log.info(
            {
              source: "repair",
              agentId,
              inboxId,
              drained: entries.length,
              inFlightCount: inFlight,
              globalCap: inboxMaxInFlightPerAgent,
              chatCap: inboxMaxInFlightPerAgentChat,
            },
            "inbox backlog repair drained pending notify rows",
          );
        }

        for (const entry of entries) {
          addInboxInFlight(agentId, entry.chatId, entry.id);
          if (!sendInboxDeliverFrame(entry)) {
            removeInboxInFlight([entry.id]);
            // Socket gone mid-drain — stop pushing. Remaining entries stay
            // 'delivered'; the next bind from this client resets them and
            // re-drains.
            return;
          }
        }
      }

      // FIFO per session so session:event persistence happens before any
      // subsequent eviction's clearEvents — without this, the message handler
      // is async and the next message can race the previous one's DB write.
      const sessionOpQueues = new Map<string, Promise<void>>();
      function chainSessionOp(agentId: string, chatId: string, op: () => Promise<void>): Promise<void> {
        const key = `${agentId}:${chatId}`;
        const prev = sessionOpQueues.get(key) ?? Promise.resolve();
        const next = prev.then(op, op);
        sessionOpQueues.set(
          key,
          next.finally(() => {
            if (sessionOpQueues.get(key) === next) sessionOpQueues.delete(key);
          }),
        );
        return next;
      }

      let authTimeout: NodeJS.Timeout | null = null;
      const clearAuthTimeout = () => {
        if (!authTimeout) return;
        clearTimeout(authTimeout);
        authTimeout = null;
      };
      const rejectAuthAndClose = (
        phase: WsAuthPhase,
        code: AuthRejectedCode,
        message?: string,
        errorClass?: string,
        extraAttrs?: Record<string, string | number | boolean>,
      ) => {
        clearAuthTimeout();
        closeWithAuthRejected(socket, phase, code, message, errorClass, extraAttrs);
      };
      const expireAuthAndCloseWithAttrs = (
        phase: WsAuthPhase,
        extraAttrs?: Record<string, string | number | boolean>,
        errorClass?: string,
      ) => {
        clearAuthTimeout();
        closeWithAuthExpired(socket, phase, extraAttrs, errorClass);
      };
      const retryAuthAndClose = (
        phase: WsAuthPhase,
        code: AuthRetryableCode,
        closeCode: 1011 | 1013,
        message?: string,
        errorClass?: string,
      ) => {
        clearAuthTimeout();
        closeWithAuthRetryable(socket, phase, code, closeCode, message, errorClass);
      };

      authTimeout = setTimeout(() => {
        if (!session) {
          retryAuthAndClose("auth_frame_timeout", AUTH_RETRYABLE_CODES.AUTH_TIMEOUT, 1013, "auth frame timeout");
        }
      }, WS_AUTH_FRAME_TIMEOUT_MS);

      const scheduleAuthExpiry = (expSeconds: number | undefined) => {
        if (authExpiryTimer) {
          clearTimeout(authExpiryTimer);
          authExpiryTimer = null;
        }
        if (!expSeconds) return;
        const delay = expSeconds * 1000 - Date.now();
        if (delay <= 0) return;
        authExpiryTimer = setTimeout(() => {
          closeWithAuthExpired(socket, "jwt_verify");
        }, delay);
      };

      socket.on("message", async (raw) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          if (!session) {
            rejectAuthAndClose(
              "auth_frame_validation",
              AUTH_REJECTED_CODES.INVALID_AUTH_FRAME,
              "invalid JSON auth frame",
            );
          } else {
            socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
          }
          return;
        }

        const parsed = wsMessageSchema.safeParse(msg);
        if (!parsed.success) {
          if (!session) {
            rejectAuthAndClose(
              "auth_frame_validation",
              AUTH_REJECTED_CODES.INVALID_AUTH_FRAME,
              "invalid auth message format",
            );
          } else {
            socket.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
          }
          return;
        }

        const { type, ref } = parsed.data;

        // ── Auth gate — the very first frame must be {type:"auth"}.
        if (!session) {
          if (type !== "auth") {
            rejectAuthAndClose(
              "auth_frame_validation",
              AUTH_REJECTED_CODES.INVALID_AUTH_FRAME,
              "first frame must be auth",
            );
            return;
          }
          const authParsed = wsAuthFrameSchema.safeParse(msg);
          if (!authParsed.success) {
            rejectAuthAndClose("auth_frame_validation", AUTH_REJECTED_CODES.INVALID_AUTH_FRAME, "invalid auth frame");
            return;
          }

          const token = authParsed.data.token;
          let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
          try {
            const verified = await jwtVerify(token, jwtSecretBytes);
            payload = verified.payload;
          } catch (err) {
            const reason = classifyJoseError(err);
            const traceClaims = untrustedAttrs("auth.ws", decodeJwtForTrace(token));
            const errorClass = err instanceof Error ? err.name : reason;
            if (reason === "jwt_expired") {
              expireAuthAndCloseWithAttrs("jwt_verify", traceClaims, errorClass);
              return;
            }
            rejectAuthAndClose(
              "jwt_verify",
              rejectedCodeForJoseError(reason, err),
              "JWT verification failed",
              errorClass,
              traceClaims,
            );
            return;
          }

          const tokenType = payload.type;
          if (tokenType !== "access") {
            rejectAuthAndClose(
              "claims_validation",
              tokenType === undefined ? AUTH_REJECTED_CODES.INVALID_CLAIMS : AUTH_REJECTED_CODES.WRONG_TOKEN_TYPE,
              "member access token required",
              tokenType === undefined ? "missing_token_type" : "wrong_token_type",
            );
            return;
          }
          const userId = payload.sub;
          if (typeof userId !== "string" || userId.length === 0) {
            rejectAuthAndClose(
              "claims_validation",
              AUTH_REJECTED_CODES.INVALID_CLAIMS,
              "missing subject claim",
              "missing_sub",
            );
            return;
          }

          let user: { id: string; status: string } | undefined;
          try {
            [user] = await app.db
              .select({ id: users.id, status: users.status })
              .from(users)
              .where(eq(users.id, userId))
              .limit(1);
          } catch (err) {
            app.log.warn({ err, userId }, "WS auth user lookup failed; asking client to retry");
            retryAuthAndClose(
              "user_lookup",
              AUTH_RETRYABLE_CODES.AUTH_BACKEND_UNAVAILABLE,
              1013,
              "authentication backend unavailable",
              err instanceof Error ? err.name : "UnknownError",
            );
            return;
          }
          if (!user) {
            rejectAuthAndClose("user_lookup", AUTH_REJECTED_CODES.USER_NOT_FOUND, "user not found");
            return;
          }
          if (user.status !== "active") {
            rejectAuthAndClose("user_lookup", AUTH_REJECTED_CODES.USER_SUSPENDED, "user suspended");
            return;
          }

          // Session is org-free (decouple-client-from-identity §4.2). The
          // JWT's `organizationId`/`memberId`/`role` claims are recorded as
          // hints only; bind-time R-RUN re-resolves the agent's owner
          // through `agents → manager → user` against the live DB.
          session = { userId: user.id };
          jwtDefaultOrgId = typeof payload.organizationId === "string" ? payload.organizationId : null;
          setWsConnectionAttrs(socket, { "user.id": user.id });
          clearAuthTimeout();
          scheduleAuthExpiry(payload.exp);

          try {
            sendJsonOrThrow(socket, { type: "auth:ok" });
            // Wire-additive: older clients drop the unknown type; newer ones
            // use it to detect version drift. `capabilities.wsInboxDeliver`
            // must stay `true` here so 0.10.4 ~ 0.14.2 clients suppress
            // their local 5s HTTP poll on bootstrap — without this flag they
            // would fall back to `GET /inbox` + `POST /inbox/:id/ack` and
            // the missing ack endpoint would loop messages forever. 0.14.3+
            // clients ignore the field entirely.
            sendJsonOrThrow(socket, {
              type: "server:welcome",
              serverCommandVersion: app.commandVersion(),
              serverTimeMs: Date.now(),
              capabilities: { wsInboxDeliver: true, wsInboxAckConfirm: true, wsSessionEventConfirm: true },
            });
            setAuthWsAttrs(socket, {
              phase: "post_auth_welcome",
              outcome: "accepted",
              code: "auth_ok",
              retryable: false,
            });
          } catch (err) {
            app.log.warn({ err, userId: user.id }, "WS post-auth handshake failed; asking client to retry");
            retryAuthAndClose(
              "post_auth_welcome",
              AUTH_RETRYABLE_CODES.HANDSHAKE_INTERNAL_ERROR,
              1011,
              "post-auth handshake failed",
              err instanceof Error ? err.name : "UnknownError",
            );
          }
          return;
        }

        const spanAttrs: Record<string, unknown> = ref !== undefined ? { "ws.message.ref": String(ref) } : {};
        await withWsMessageSpan(socket, type, spanAttrs, async () => {
          // Re-assert the outer auth-gate narrowing — TS drops it across the async closure boundary.
          if (!session) return;
          try {
            if (type === "client:register") {
              const data = clientRegisterSchema.parse(msg);

              // Resolve a placeholder `organizationId` for the legacy NOT NULL
              // column on `clients`. The column is no longer read by any path
              // (decouple-client-from-identity §4.1.1) but still has the FK
              // constraint, so we need *some* valid org id at INSERT time. Use
              // the user's most-recently-active membership; fall back to
              // jwtDefaultOrgId for legacy tokens that still carry it.
              let placeholderOrgId = jwtDefaultOrgId;
              if (!placeholderOrgId) {
                const [m] = await app.db
                  .select({ organizationId: members.organizationId })
                  .from(members)
                  .where(and(eq(members.userId, session.userId), eq(members.status, "active")))
                  .orderBy(desc(members.createdAt), desc(members.id))
                  .limit(1);
                placeholderOrgId = m?.organizationId ?? null;
              }
              if (!placeholderOrgId) {
                setAuthWsAttrs(socket, {
                  phase: "client_register",
                  outcome: "rejected",
                  code: "no_membership",
                  retryable: false,
                  closeCode: 4403,
                });
                socket.send(
                  JSON.stringify({
                    type: "client:register:rejected",
                    message: "User has no active organization membership",
                  }),
                );
                socket.close(4403, "no membership");
                return;
              }
              try {
                await clientService.registerClient(app.db, {
                  clientId: data.clientId,
                  userId: session.userId,
                  organizationId: placeholderOrgId,
                  instanceId,
                  hostname: data.hostname,
                  os: data.os,
                  sdkVersion: data.sdkVersion,
                  lastUpdateAttempt: data.lastUpdateAttempt,
                });
              } catch (err) {
                const message = err instanceof Error ? err.message : "client register failed";
                const code =
                  err instanceof ClientUserMismatchError
                    ? err.code
                    : err instanceof ClientOrgMismatchError || err instanceof ClientRetiredError
                      ? err.code
                      : undefined;
                setAuthWsAttrs(socket, {
                  phase: "client_register",
                  outcome: "rejected",
                  code: code ?? "client_register_failed",
                  retryable: false,
                  closeCode: 4403,
                  errorClass: err instanceof Error ? err.name : "UnknownError",
                });
                socket.send(
                  JSON.stringify({
                    type: "client:register:rejected",
                    message,
                    ...(code ? { code } : {}),
                  }),
                );
                socket.close(4403, "client register rejected");
                return;
              }

              clientId = data.clientId;
              setWsConnectionAttrs(socket, { "client.id": data.clientId });
              connectionManager.setClientConnection(data.clientId, socket);
              socket.send(JSON.stringify({ type: "client:registered", clientId: data.clientId }));

              // Backfill `agent:pinned` for any agent already bound to this
              // client at registration time. Without this, an admin who pins an
              // agent while the client is offline would still need a manual
              // `agent add` after restart — the realtime push in
              // admin/agents.ts only fires for live sockets. The client dedupes
              // on agentId, so re-firing on every reconnect is safe.
              try {
                await reconcilePinnedAgentsForClient();
              } catch (err) {
                app.log.error(
                  { err, clientId: data.clientId },
                  "agent:pinned backfill on client:register failed — client may need manual `agent add`",
                );
              }
            } else if (type === "agent:bind") {
              if (!clientId) {
                socket.send(JSON.stringify({ type: "error", ref, message: "Must register client first" }));
                return;
              }

              const bindRequest = agentBindRequestSchema.parse(msg);
              const [bindingClient] = await app.db
                .select({ userId: clients.userId, retiredAt: clients.retiredAt })
                .from(clients)
                .where(eq(clients.id, clientId))
                .limit(1);
              if (!bindingClient || bindingClient.userId !== session.userId) {
                sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.NOT_OWNED);
                return;
              }
              if (bindingClient.retiredAt) {
                sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_CLIENT);
                return;
              }

              const [agent] = await app.db
                .select({
                  id: agents.uuid,
                  displayName: agents.displayName,
                  type: agents.type,
                  organizationId: agents.organizationId,
                  inboxId: agents.inboxId,
                  status: agents.status,
                  clientId: agents.clientId,
                  managerId: agents.managerId,
                  runtimeProvider: agents.runtimeProvider,
                  clientUserId: clients.userId,
                  managerUserId: members.userId,
                  managerMemberStatus: members.status,
                })
                .from(agents)
                .leftJoin(clients, eq(agents.clientId, clients.id))
                .leftJoin(members, eq(agents.managerId, members.id))
                .where(and(eq(agents.uuid, bindRequest.agentId)))
                .limit(1);

              if (!agent) {
                sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.UNKNOWN_AGENT);
                return;
              }
              if (agent.status !== "active") {
                sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.AGENT_SUSPENDED);
                return;
              }

              // R-RUN owner check: same user AND manager's membership still
              // active. Multi-org under the same user is permitted — agent
              // org binding is not consulted (decouple-client-from-identity
              // §4.3). Membership flipped to inactive denies new binds while
              // already-bound agents continue running until unbind.
              const ownerOk = agent.managerUserId !== null && agent.managerUserId === session.userId;
              const membershipActive = agent.managerMemberStatus === "active";
              if (!ownerOk || !membershipActive) {
                sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.NOT_OWNED);
                return;
              }

              // Reject a runtime-provider mismatch BEFORE any first-bind claim.
              // The claim below is the one-shot NULL → ID that fixes an agent's
              // client for life (re-bind is removed), so a client running a
              // different runtime must never be allowed to pin an unbound agent
              // — otherwise it claims the agent, gets rejected here, and no
              // other client can recover it (they would only see WRONG_CLIENT).
              // The client repair path re-fetches authoritative state and
              // respawns the right handler before retrying the bind.
              if (bindRequest.runtimeType !== agent.runtimeProvider) {
                sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.RUNTIME_PROVIDER_MISMATCH);
                return;
              }

              // First-bind path: agent.clientId is NULL (e.g. created before
              // the operator brought up a client, or migrated from pre-M1 with
              // no presence record). The race-safe UPDATE returns 0 rows if
              // another bind claimed it first — surface as WRONG_CLIENT.
              //
              // The claim is also pinned to the `managerId` read above. A
              // concurrent leave/remove transfers a departing member's managed
              // agents by *changing* their `managerId` and clearing the pin, so
              // requiring the manager to be unchanged closes the departure race:
              // if the transfer already landed, the claim matches 0 rows and is
              // rejected instead of re-pinning the departed owner's client onto a
              // now-transferred agent (which would revive the retireClient
              // deadlock); if this claim lands first, the departure's
              // managerId-keyed transfer still re-scans and unpins it.
              if (agent.clientId === null) {
                const claim = await app.db
                  .update(agents)
                  .set({ clientId, updatedAt: new Date() })
                  .where(
                    and(
                      eq(agents.uuid, agent.id),
                      isNull(agents.clientId),
                      eq(agents.managerId, agent.managerId),
                      sql`EXISTS (
                        SELECT 1 FROM ${clients}
                        WHERE ${clients.id} = ${clientId}
                          AND ${clients.userId} = ${session.userId}
                          AND ${clients.retiredAt} IS NULL
                      )`,
                    ),
                  )
                  .returning({ uuid: agents.uuid });
                if (claim.length === 0) {
                  sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_CLIENT);
                  return;
                }
              } else if (agent.clientId !== clientId) {
                sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_CLIENT);
                return;
              } else if (!agent.clientUserId || agent.clientUserId !== session.userId) {
                sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.NOT_OWNED);
                return;
              }

              if (!connectionManager.isActiveClientConnection(clientId, socket)) {
                sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_CLIENT);
                return;
              }

              let runtimeSessionToken: string;
              try {
                runtimeSessionToken = await agentRuntimeSessionService.bindAgentRuntimeSession(
                  app.db,
                  agent.id,
                  clientId,
                );
              } catch (err) {
                app.log.warn({ err, agentId: agent.id, clientId }, "agent:bind runtime session claim failed");
                sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_CLIENT);
                return;
              }

              const published = await presenceService.bindAgentIfActiveClient(app.db, agent.id, {
                clientId,
                instanceId,
                runtimeType: bindRequest.runtimeType,
                runtimeVersion: bindRequest.runtimeVersion,
              });
              if (!published) {
                await agentRuntimeSessionService
                  .revokeAgentRuntimeSessionIfTokenMatches(app.db, agent.id, clientId, runtimeSessionToken)
                  .catch(() => {});
                sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_CLIENT);
                return;
              }

              if (!connectionManager.isActiveClientConnection(clientId, socket)) {
                const revoked = await agentRuntimeSessionService
                  .revokeAgentRuntimeSessionIfTokenMatches(app.db, agent.id, clientId, runtimeSessionToken)
                  .catch(() => false);
                if (revoked && connectionManager.getAgentClientId(agent.id) !== clientId) {
                  await presenceService.unbindAgent(app.db, agent.id, { expectedClientId: clientId }).catch(() => {});
                }
                sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_CLIENT);
                return;
              }

              // An agent that just rebound has, by definition, recovered from
              // whatever fault (stale / error / blocked) was last reported —
              // close any open unread fault row so the bell badge clears
              // instead of lingering across the offline gap.
              notificationService.markAgentFaultsResolved(app.db, agent.id).catch(() => {});

              connectionManager.bindAgentToClient(clientId, agent.id, runtimeSessionToken);
              boundAgents.set(agent.id, {
                agentId: agent.id,
                inboxId: agent.inboxId,
                organizationId: agent.organizationId,
                runtimeProvider: agent.runtimeProvider,
              });

              // In-flight recovery: a freshly-(re)connected client may not
              // have acked entries the previous socket received before it
              // dropped (process crash, network blip, etc.). Reset every
              // `delivered` row for this inbox back to `pending` so the
              // follow-up `drainBacklogForAgent` re-pushes them. This must
              // complete before `agent:bound`: clients clear their local
              // bind-recovery guard when they observe that frame.
              try {
                const reset = await inboxService.resetDeliveredForInboxes(app.db, [agent.inboxId]);
                if (reset > 0) {
                  app.log.info(
                    { agentId: agent.id, inboxId: agent.inboxId, reset },
                    "agent:bind reset delivered → pending for in-flight recovery",
                  );
                }
              } catch (err) {
                // Not fatal — drain still runs against whatever is pending.
                // Genuinely-stuck delivered rows will be picked up by the
                // next bind.
                app.log.error(
                  { err, agentId: agent.id, inboxId: agent.inboxId },
                  "agent:bind resetDeliveredForInboxes failed",
                );
              }

              // Subscribe to NOTIFY traffic with a per-socket push handler so
              // NOTIFYs land as `inbox:deliver` frames on this connection.
              notifier.subscribe(agent.inboxId, socket, makeInboxPushHandler(agent.id, agent.inboxId));

              socket.send(
                JSON.stringify({
                  type: "agent:bound",
                  ref,
                  agentId: agent.id,
                  displayName: agent.displayName,
                  agentType: agent.type,
                  runtimeSessionToken,
                }),
              );

              // Reconnect/recovery: drain any pending entries that piled up
              // while this socket was offline (or while another instance held
              // the subscription), plus everything the bind-time reset above
              // just flipped from `delivered` to `pending`. Failures are
              // logged inside the helper — don't crash the bind path.
              chainInboxDelivery(agent.id, () =>
                drainBacklogForAgent(agent.id, agent.inboxId, { source: "bind" }),
              ).catch((err) => {
                app.log.error({ err, agentId: agent.id }, "post-bind backlog drain crashed");
              });
            } else if (type === "agent:unbind") {
              const agentId = parsed.data.agentId;
              if (!agentId || !boundAgents.has(agentId)) {
                socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
                return;
              }

              const info = boundAgents.get(agentId);
              const stillRoutedHere = await ensureAgentStillRoutedHere(agentId);
              if (info) {
                notifier.unsubscribe(info.inboxId, socket);
              }

              if (stillRoutedHere && clientId) {
                await agentRuntimeSessionService.revokeAgentRuntimeSession(app.db, agentId, clientId);
                await presenceService.unbindAgent(app.db, agentId, { expectedClientId: clientId });
                connectionManager.unbindAgentFromClient(agentId, clientId);
              } else {
                app.log.info({ clientId, agentId }, "stale agent:unbind ignored for global binding");
              }
              boundAgents.delete(agentId);
              lastInboxRepairDrainAtByAgent.delete(agentId);
              clearInboxInFlightForAgent(agentId);

              socket.send(JSON.stringify({ type: "agent:unbound", agentId }));
            } else if (type === "session:state") {
              const agentId = parsed.data.agentId;
              if (!agentId || !(await ensureAgentStillRoutedHere(agentId))) {
                socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
                return;
              }

              const payloadResult = sessionStateMessageSchema.safeParse(msg);
              if (!payloadResult.success) {
                // Strict wire contract: the client may only report active/suspended.
                // A stale client sending `evicted` gets a hard reject; its local state
                // has already moved, and the next inbound message will re-sync via the
                // evictedMappings resume path. See proposal §Wire-Level Strictness.
                socket.send(
                  JSON.stringify({
                    type: "error",
                    message: "Unsupported session state from client; client upgrade required",
                  }),
                );
                const rawState = (msg as { state?: unknown }).state;
                app.log.warn({ clientId, agentId, rawState }, "session:state rejected — stale client wire");
                return;
              }

              const boundAgentInfo = boundAgents.get(agentId);
              if (!boundAgentInfo) return;
              // Run on the per-(agent,chat) FIFO so a `session:runtime`
              // frame (which only writes to an `active` row) can't be
              // reordered ahead of the `session:state active` that
              // creates / activates that row. The op MUST catch internally
              // (mirroring `session:event`): a thrown upsert would
              // otherwise reject the queued promise with no handler (the
              // chain only consumes the prior op's rejection when a
              // *next* op is enqueued), surfacing as an unhandled
              // rejection.
              await chainSessionOp(agentId, payloadResult.data.chatId, async () => {
                try {
                  await activityService.upsertSessionState(
                    app.db,
                    agentId,
                    payloadResult.data.chatId,
                    payloadResult.data.state,
                    boundAgentInfo.organizationId,
                    notifier,
                  );
                } catch (err) {
                  socket.send(
                    JSON.stringify({
                      type: "error",
                      message: `Failed to persist session state: ${err instanceof Error ? err.message : String(err)}`,
                    }),
                  );
                }
              });
            } else if (type === "session:runtime") {
              const agentId = parsed.data.agentId;
              if (!agentId || !(await ensureAgentStillRoutedHere(agentId))) {
                socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
                return;
              }

              const payloadResult = sessionRuntimeMessageSchema.safeParse(msg);
              if (!payloadResult.success) {
                socket.send(JSON.stringify({ type: "error", message: "Malformed session:runtime frame" }));
                return;
              }
              const boundInfo = boundAgents.get(agentId);
              if (!boundInfo) return;
              const { chatId, runtimeState } = payloadResult.data;
              // Same per-(agent,chat) FIFO as session:state / session:event —
              // setSessionRuntime gates on `state='active'`, so the upstream
              // state write must drain first.
              await chainSessionOp(agentId, chatId, async () => {
                try {
                  await activityService.setSessionRuntime(
                    app.db,
                    agentId,
                    chatId,
                    runtimeState,
                    boundInfo.organizationId,
                    notifier,
                  );
                } catch (err) {
                  socket.send(
                    JSON.stringify({
                      type: "error",
                      message: `Failed to persist session runtime: ${err instanceof Error ? err.message : String(err)}`,
                    }),
                  );
                }
              });
            } else if (type === "session:reconcile") {
              const agentId = parsed.data.agentId;
              if (!agentId || !(await ensureAgentStillRoutedHere(agentId))) {
                socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
                return;
              }

              const payloadResult = sessionReconcileRequestSchema.safeParse(msg);
              if (!payloadResult.success) {
                socket.send(JSON.stringify({ type: "error", message: "Malformed session:reconcile frame" }));
                return;
              }

              const { chatIds } = payloadResult.data;
              const aliveRows = chatIds.length
                ? await app.db
                    .select({ chatId: agentChatSessions.chatId })
                    .from(agentChatSessions)
                    .where(
                      and(
                        eq(agentChatSessions.agentId, agentId),
                        inArray(agentChatSessions.chatId, chatIds),
                        ne(agentChatSessions.state, "evicted"),
                      ),
                    )
                : [];
              const alive = new Set(aliveRows.map((r) => r.chatId));
              const staleChatIds = chatIds.filter((id) => !alive.has(id));

              socket.send(
                JSON.stringify({
                  type: "session:reconcile:result",
                  agentId,
                  staleChatIds,
                }),
              );
            } else if (type === "runtime:state") {
              const agentId = parsed.data.agentId;
              if (!agentId || !(await ensureAgentStillRoutedHere(agentId))) {
                socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
                return;
              }

              const payload = runtimeStateMessageSchema.parse(msg);
              const boundAgentInfo = boundAgents.get(agentId);
              if (!boundAgentInfo) return;
              await presenceService.setRuntimeState(app.db, agentId, payload.runtimeState, {
                organizationId: boundAgentInfo.organizationId,
                notifier,
              });

              // All three fault types share one dedup key (`agent:{id}:fault`),
              // so a noisy reconcile loop — or a runtime that flips error →
              // blocked → error — collapses to a single unread row. Healthy
              // states close that row so the badge doesn't linger after the
              // agent has already recovered.
              if (payload.runtimeState === "error") {
                notificationService.notifyAgentEvent(app.db, agentId, "agent_error", "high").catch(() => {});
              } else if (payload.runtimeState === "blocked") {
                notificationService.notifyAgentEvent(app.db, agentId, "agent_blocked", "medium").catch(() => {});
              } else if (payload.runtimeState === "idle" || payload.runtimeState === "working") {
                notificationService.markAgentFaultsResolved(app.db, agentId).catch(() => {});
              }
            } else if (type === "session:event") {
              const rawMsg = msg as Record<string, unknown>;
              const agentId = parsed.data.agentId;
              if (!agentId || !(await ensureAgentStillRoutedHere(agentId))) {
                const rawRef = typeof rawMsg.ref === "string" && rawMsg.ref.length > 0 ? rawMsg.ref : null;
                if (rawRef && agentId) {
                  socket.send(
                    JSON.stringify({
                      type: "session:event:rejected",
                      ref: rawRef,
                      agentId,
                      reason: sessionEventRejectedReasonSchema.enum.agent_not_bound,
                    }),
                  );
                } else {
                  socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
                }
                return;
              }

              const payloadResult = sessionEventMessageSchema.safeParse(msg);
              if (!payloadResult.success) {
                const rawRef = typeof rawMsg.ref === "string" && rawMsg.ref.length > 0 ? rawMsg.ref : null;
                if (rawRef) {
                  socket.send(
                    JSON.stringify({
                      type: "session:event:rejected",
                      ref: rawRef,
                      agentId,
                      chatId: typeof rawMsg.chatId === "string" ? rawMsg.chatId : undefined,
                      reason: sessionEventRejectedReasonSchema.enum.malformed,
                    }),
                  );
                } else {
                  socket.send(JSON.stringify({ type: "error", message: "Malformed session:event frame" }));
                }
                return;
              }
              const payload = payloadResult.data;
              const boundInfo = boundAgents.get(agentId);
              chainSessionOp(agentId, payload.chatId, async () => {
                try {
                  const persistedEvent = await sessionEventService.appendEvent(
                    app.db,
                    agentId,
                    payload.chatId,
                    payload.event,
                  );
                  if (
                    payload.ref &&
                    payload.event.kind === "turn_end" &&
                    payload.event.payload.status === "success" &&
                    typeof payload.event.payload.turnCompletionId === "string"
                  ) {
                    const result = await landingCampaignChatStateService.completeLandingCampaignTrialAgentTurn(
                      app.db,
                      payload.chatId,
                      agentId,
                      payload.event.payload.turnCompletionId,
                    );
                    if (result.advanced) {
                      notifier.notifyChatUpdated(payload.chatId).catch(() => {});
                    }
                  }
                  if (boundInfo) {
                    await contextTreeIoService
                      .recordFromSessionEvent(app.db, {
                        organizationId: boundInfo.organizationId,
                        agentId,
                        chatId: payload.chatId,
                        runtimeProvider: boundInfo.runtimeProvider,
                        sessionEvent: persistedEvent,
                      })
                      .catch((err) => {
                        app.log.warn(
                          { err, agentId, chatId: payload.chatId },
                          "context-tree IO record failed (non-fatal)",
                        );
                      });
                  }
                  if (boundInfo) {
                    // Best-effort cross-instance kick so admin WS sockets in
                    // the same org can invalidate `liveActivity` without
                    // waiting for the 15s `me/chats` poll. Failures are
                    // swallowed inside the notifier (fire-and-forget).
                    notifier
                      .notifySessionEvent(agentId, payload.chatId, payload.event.kind, boundInfo.organizationId)
                      .catch(() => {});
                  }
                  if (payload.ref) {
                    socket.send(
                      JSON.stringify({
                        type: "session:event:accepted",
                        ref: payload.ref,
                        agentId,
                        chatId: payload.chatId,
                      }),
                    );
                  }
                } catch (err) {
                  if (payload.ref) {
                    socket.send(
                      JSON.stringify({
                        type: "session:event:rejected",
                        ref: payload.ref,
                        agentId,
                        chatId: payload.chatId,
                        reason: sessionEventRejectedReasonSchema.enum.persist_failed,
                      }),
                    );
                  } else {
                    socket.send(
                      JSON.stringify({
                        type: "error",
                        message: `Failed to persist session event: ${err instanceof Error ? err.message : String(err)}`,
                      }),
                    );
                  }
                }
              });
            } else if (type === "inbox:ack") {
              const payloadResult = inboxAckFrameSchema.safeParse(msg);
              if (!payloadResult.success) {
                // Server-side log so a buggy / malicious client's malformed
                // frames are visible in trace backends even when the client
                // discards the error reply. Wire-shape drift between
                // client and server schemas is the most common cause.
                app.log.warn(
                  {
                    clientId,
                    issues: payloadResult.error.issues.map((i) => ({
                      path: i.path.join("."),
                      code: i.code,
                      message: i.message,
                    })),
                  },
                  "malformed inbox:ack frame — replying error",
                );
                socket.send(JSON.stringify({ type: "error", message: "Malformed inbox:ack frame" }));
                return;
              }
              const { entryId, ref } = payloadResult.data;

              await chainInboxDelivery("__socket", async () => {
                try {
                  const routedBoundAgents = [];
                  for (const agent of boundAgents.values()) {
                    if (await ensureAgentStillRoutedHere(agent.agentId)) {
                      routedBoundAgents.push(agent);
                    }
                  }
                  const ackResult = await inboxService.ackEntryByIdForBoundAgents(
                    app.db,
                    entryId,
                    routedBoundAgents.map((a) => a.inboxId),
                  );
                  if (!ackResult.ok) {
                    if (ref) {
                      socket.send(
                        JSON.stringify({
                          type: "inbox:ack:rejected",
                          entryId,
                          ref,
                          reason: ackResult.reason,
                        }),
                      );
                    }
                    app.log.debug(
                      {
                        clientId,
                        entryId,
                        ref,
                        agentId: null,
                        boundInboxes: routedBoundAgents.length,
                        reason: ackResult.reason,
                        ackEvent: "inbox_ack_rejected",
                      },
                      "inbox:ack rejected",
                    );
                    return;
                  }
                  // Find the agentId that owns this inbox to decrement the
                  // counter and trigger backlog drain.
                  const owner = routedBoundAgents.find((a) => a.inboxId === ackResult.throughEntry.inboxId);
                  if (ref) {
                    socket.send(
                      JSON.stringify({
                        type: "inbox:ack:accepted",
                        entryId,
                        ref,
                        disposition: ackResult.disposition,
                        ackedCount: ackResult.ackedCount,
                      }),
                    );
                  }
                  app.log.debug(
                    {
                      clientId,
                      entryId,
                      ref,
                      agentId: owner?.agentId ?? null,
                      disposition: ackResult.disposition,
                      ackedCount: ackResult.ackedCount,
                      ackedEntryIds: ackResult.ackedEntryIds,
                      ackEvent: "inbox_ack_accepted",
                    },
                    "inbox:ack accepted",
                  );
                  if (owner && ackResult.ackedEntryIds.length > 0) {
                    removeInboxInFlight(ackResult.ackedEntryIds);
                    // Slot freed → top up. Cheap when no backlog (single SQL
                    // statement returning 0 rows). Critical when the cap was
                    // hit and queued NOTIFYs got dropped (proposal §3.5).
                    await drainBacklogForAgent(owner.agentId, owner.inboxId, { source: "ack" });
                  }
                } catch (err) {
                  app.log.error({ err, entryId }, "inbox:ack handling failed");
                }
              });
            } else if (type === "inbox:recover") {
              const payloadResult = inboxRecoverFrameSchema.safeParse(msg);
              if (!payloadResult.success) {
                app.log.warn(
                  {
                    clientId,
                    issues: payloadResult.error.issues.map((i) => ({
                      path: i.path.join("."),
                      code: i.code,
                      message: i.message,
                    })),
                  },
                  "malformed inbox:recover frame — replying error",
                );
                socket.send(JSON.stringify({ type: "error", message: "Malformed inbox:recover frame" }));
                return;
              }
              const { agentId, chatId, ref } = payloadResult.data;
              await chainInboxDelivery("__socket", async () => {
                const info = boundAgents.get(agentId);
                if (!info || !(await ensureAgentStillRoutedHere(agentId))) {
                  socket.send(
                    JSON.stringify({
                      type: "inbox:recover:rejected",
                      ref,
                      agentId,
                      chatId,
                      reason: "agent_not_bound",
                    }),
                  );
                  return;
                }

                try {
                  const recovered = await inboxService.recoverUnackedForScope(app.db, {
                    inboxId: info.inboxId,
                    chatId,
                  });
                  removeInboxInFlight(recovered.resetEntryIds);
                  socket.send(
                    JSON.stringify({
                      type: "inbox:recover:accepted",
                      ref,
                      agentId,
                      chatId,
                      resetCount: recovered.resetEntryIds.length,
                    }),
                  );
                  await drainBacklogForAgent(agentId, info.inboxId, { source: "recover", chatId });
                } catch (err) {
                  app.log.error({ err, agentId, chatId }, "inbox:recover handling failed");
                  socket.send(
                    JSON.stringify({
                      type: "inbox:recover:rejected",
                      ref,
                      agentId,
                      chatId,
                      reason: "recover_failed",
                    }),
                  );
                }
              });
            } else if (type === "heartbeat") {
              if (clientId && connectionManager.isActiveClientConnection(clientId, socket)) {
                const routedAgentIds = [];
                for (const id of boundAgents.keys()) {
                  if (await ensureAgentStillRoutedHere(id)) routedAgentIds.push(id);
                }
                const liveness = await runtimeLivenessService.recordClientHeartbeat(app.db, {
                  clientId,
                  instanceId,
                  routedAgentIds,
                });
                const repairableAgentIds = new Set(liveness.restoredAgentIds);
                for (const info of boundAgents.values()) {
                  if (repairableAgentIds.has(info.agentId) && (await ensureAgentStillRoutedHere(info.agentId))) {
                    maybeRepairInboxBacklog(info.agentId, info.inboxId);
                  }
                }
                await reconcilePinnedAgentsForClient();
              }
              socket.send(JSON.stringify({ type: "heartbeat:ack" }));
            } else if (type === PROVIDER_MODELS_RESULT_TYPE) {
              if (!clientId) {
                socket.send(JSON.stringify({ type: "error", message: "Must register client first" }));
                return;
              }
              const result = providerModelsResultFrameSchema.safeParse(msg);
              if (!result.success) {
                socket.send(JSON.stringify({ type: "error", message: "Malformed provider-models:result frame" }));
                return;
              }
              // Reject a locally replaced socket before touching durable state.
              if (!connectionManager.isActiveClientConnection(clientId, socket)) {
                app.log.debug(
                  { clientId, ref: result.data.ref },
                  "ignoring provider-models:result from replaced local socket",
                );
                return;
              }
              // Ownership + persist are one UPDATE (`id` AND `instance_id`); a
              // takeover between a prior SELECT and write cannot land a catalog.
              const stored = await storeModelCatalogRpcResult(
                app.db,
                clientId,
                result.data.ref,
                result.data.catalog,
                instanceId,
              );
              if (!stored) {
                app.log.debug(
                  { clientId, ref: result.data.ref, instanceId },
                  "ignoring provider-models:result; client ownership moved before durable write",
                );
                return;
              }
              const resolved = connectionManager.resolveClientReply(clientId, result.data.ref, result.data.catalog);
              await notifier.notifyDaemonClientCommandResult({ clientId, ref: result.data.ref });
              if (!resolved) {
                app.log.debug(
                  { clientId, ref: result.data.ref },
                  "provider-models:result matched no pending HTTP waiter on this replica",
                );
              }
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : "Internal error";
            socket.send(JSON.stringify({ type: "error", message }));
          }
        });
      });

      socket.on("close", async (closeCode?: number) => {
        endWsConnectionSpan(socket, closeCode);
        clearAuthTimeout();
        if (authExpiryTimer) clearTimeout(authExpiryTimer);

        for (const [, info] of boundAgents) {
          notifier.unsubscribe(info.inboxId, socket);
        }
        boundAgents.clear();
        lastInboxRepairDrainAtByAgent.clear();
        inboxInFlightByAgent.clear();
        inboxInFlightOwnersByEntryId.clear();

        if (clientId) {
          // Reconnect-race guard. A typical `systemctl restart` produces this
          // sequence:
          //
          //   t0  old client process exits → server starts processing this
          //       onClose handler asynchronously
          //   t1  new client process connects + registers → setClientConnection
          //       installs the new socket as the active one for `clientId` and
          //       writes clients.status='connected'
          //   t2  the t0 onClose finally awaits to disconnectClient and would
          //       happily stamp clients.status='disconnected', clobbering t1
          //
          // A WebSocket close is only a transport loss. Proactive auth
          // refreshes and short network blips reconnect in seconds, so do not
          // stamp the client or agents disconnected here. Heartbeat staleness
          // cleanup owns the grace window and marks the client/agents offline
          // only if they do not reconnect in time.
          connectionManager.removeClientConnection(clientId, socket);
        }
      });
    });
  };
}
