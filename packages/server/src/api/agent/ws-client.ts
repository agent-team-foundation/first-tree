import {
  AGENT_BIND_REJECT_REASONS,
  type AgentBindRejectReason,
  agentBindRequestSchema,
  agentPinnedMessageSchema,
  clientRegisterSchema,
  type InboxEntryWithMessage,
  inboxAckFrameSchema,
  inboxDeliverFrameSchema,
  runtimeStateMessageSchema,
  sessionEventMessageSchema,
  sessionReconcileRequestSchema,
  sessionRuntimeMessageSchema,
  sessionStateMessageSchema,
  WS_AUTH_FRAME_TIMEOUT_MS,
  wsAuthFrameSchema,
} from "@first-tree/shared";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { jwtVerify } from "jose";
import type { WebSocket } from "ws";
import { z } from "zod";
import { agentChatSessions } from "../../db/schema/agent-chat-sessions.js";
import { agents } from "../../db/schema/agents.js";
import { clients } from "../../db/schema/clients.js";
import { members } from "../../db/schema/members.js";
import { users } from "../../db/schema/users.js";
import { ClientOrgMismatchError, ClientUserMismatchError } from "../../errors.js";
import {
  endWsConnectionSpan,
  setWsConnectionAttrs,
  startWsConnectionSpan,
  withWsMessageSpan,
} from "../../observability/index.js";
import * as activityService from "../../services/activity.js";
import * as clientService from "../../services/client.js";
import { ClientDedupConflictError } from "../../services/client.js";
import * as connectionManager from "../../services/connection-manager.js";
import * as inboxService from "../../services/inbox.js";
import * as notificationService from "../../services/notification.js";
import type { InboxPushHandler, Notifier } from "../../services/notifier.js";
import * as presenceService from "../../services/presence.js";
import * as sessionEventService from "../../services/session-event.js";

/**
 * Default per-agent in-flight cap when `server.inbox.maxInFlightPerAgent` is
 * unset. Mirrors the schema default so a hub running without an explicit
 * `inbox` block still gets reasonable backpressure.
 */
const DEFAULT_INBOX_MAX_IN_FLIGHT_PER_AGENT = 32;
/**
 * Hard cap on entries scanned in a single backlog drain so a recovering
 * client doesn't trigger an arbitrarily large transaction or burst of
 * frames. Anything beyond this stays `pending` and gets picked up by
 * subsequent post-ack drains. Same constant covers both the agent:bound
 * recovery path and the post-ack top-up.
 *
 * Lower than proposal §3.3's 500 on purpose: the actual limit per drain is
 * `min(remainingInFlightBudget, INBOX_BACKLOG_BATCH_LIMIT)`, so with a
 * default cap of 32 the drain SQL never asks for more than ~32 anyway.
 * Subsequent NOTIFYs and post-ack top-ups continue draining without a
 * single-transaction megabatch.
 */
const INBOX_BACKLOG_BATCH_LIMIT = 50;

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
 *      Failure ⇒ server sends `auth:rejected` and closes (code 4401).
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

function sendRejected(socket: WebSocket, ref: string | undefined, reason: AgentBindRejectReason): void {
  socket.send(JSON.stringify({ type: "agent:bind:rejected", ref, reason }));
}

export function clientWsRoutes(notifier: Notifier, instanceId: string) {
  return async (app: FastifyInstance): Promise<void> => {
    const jwtSecretBytes = new TextEncoder().encode(app.config.secrets.jwtSecret);

    const inboxMaxInFlightPerAgent = app.config.inbox?.maxInFlightPerAgent ?? DEFAULT_INBOX_MAX_IN_FLIGHT_PER_AGENT;

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
      const boundAgents = new Map<string, { agentId: string; inboxId: string; organizationId: string }>();

      /**
       * Per-agent in-flight `inbox:deliver` counter for backpressure. Lives on
       * the socket — when the WS closes it goes with it; that's intentional,
       * because re-counting on a fresh connection would bias the cap against
       * a healthy reconnect.
       */
      const inboxInFlight = new Map<string, number>();

      /**
       * Returns `false` when the socket has already moved out of `OPEN` —
       * the only failure mode the caller can observe synchronously.
       *
       * Note: `ws.send` is fire-and-forget; a buffered frame that fails
       * to actually flush (TCP slow-close, internal queue full) does NOT
       * surface here. That class of loss is recovered by the 300s timeout
       * reaper rolling the entry back to `pending` (§3.7). If you ever
       * need flush-level confirmation, switch to the `ws.send(frame, cb)`
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
       * Build the per-socket push handler bound to a specific agent. Closes
       * over `agentId`, `inboxId`, the socket, and the in-flight counter.
       *
       * Backpressure: when the agent is at-cap we drop the NOTIFY (entry
       * stays `pending` server-side) and a debug log records the drop so
       * staging can correlate "messages slow" reports against cap hits.
       * The dropped row is replayed by `drainBacklogForAgent` once an ack
       * frees a slot, or by the next NOTIFY when we're back below cap (§3.5).
       *
       * Multi-row claims: a single `(inboxId, messageId)` pair maps to
       * exactly one `inbox_entries` row now that cross-chat reply routing
       * has been removed (see first-tree-context PR #281). The claim still
       * returns an array — `claimAndBuildForPush` is defensive against
       * legacy duplicates and any future fan-out variant.
       *
       * The cap is intentionally **soft**: claim happens after the gate
       * check, so any N>1 future claim could nudge in-flight slightly past
       * `inboxMaxInFlightPerAgent`. N is bounded by the
       * `(inbox_id, message_id, chat_id)` unique constraint, so worst-case
       * overshoot is small and the memory headroom in §3.5's 64MB estimate
       * covers it.
       */
      function makeInboxPushHandler(agentId: string, inboxId: string): InboxPushHandler {
        return async (messageId: string) => {
          const current = inboxInFlight.get(agentId) ?? 0;
          if (current >= inboxMaxInFlightPerAgent) {
            app.log.debug(
              { agentId, inboxId, messageId, inFlightCount: current, cap: inboxMaxInFlightPerAgent },
              "inbox push: at cap, dropping NOTIFY (will replay via post-ack drain)",
            );
            return;
          }

          let entries: InboxEntryWithMessage[];
          try {
            entries = await inboxService.claimAndBuildForPush(app.db, inboxId, messageId);
          } catch (err) {
            app.log.error({ err, inboxId, messageId, agentId }, "claimAndBuildForPush failed");
            return;
          }
          if (entries.length === 0) {
            // Benign race — another instance (or the post-ack backlog drain)
            // claimed it first.
            return;
          }

          for (const entry of entries) {
            inboxInFlight.set(agentId, (inboxInFlight.get(agentId) ?? 0) + 1);
            if (!sendInboxDeliverFrame(entry)) {
              // Socket dropped mid-loop. The entry is still 'delivered' in
              // the DB; the existing 300s timeout reaper rolls it back to
              // 'pending' so a reconnect (or another instance) re-delivers.
              // Release the slot we just took, then bail — remaining
              // unsent entries also stay 'delivered' for the reaper.
              inboxInFlight.set(agentId, Math.max(0, (inboxInFlight.get(agentId) ?? 1) - 1));
              return;
            }
          }
        };
      }

      /**
       * Drain up to `INBOX_BACKLOG_BATCH_LIMIT` pending entries for an agent
       * over the current WS, capped by the remaining in-flight budget so a
       * full drain stays within the per-agent backpressure cap (§3.3, §3.5).
       *
       * Used in two places:
       *   1. Right after `agent:bound` — covers reconnects where NOTIFYs
       *      were dropped while the socket was offline.
       *   2. Right after an `inbox:ack` — top up the in-flight slot just
       *      freed, in case the previous NOTIFY was dropped at-cap.
       *
       * The cap is **soft**: this function reads `slotsFree` once before the
       * `claimBacklogForPush` round-trip, and a NOTIFY-driven push handler
       * may increment the counter concurrently. In the worst case in-flight
       * temporarily exceeds the cap by the number of concurrent pushes. With
       * the default cap of 32 and N ≤ 2 per push handler invocation, the
       * memory headroom in §3.5's 64MB estimate covers this.
       */
      async function drainBacklogForAgent(agentId: string, inboxId: string): Promise<void> {
        if (socket.readyState !== socket.OPEN) return;
        const inFlight = inboxInFlight.get(agentId) ?? 0;
        const slotsFree = inboxMaxInFlightPerAgent - inFlight;
        if (slotsFree <= 0) return;
        const limit = Math.min(slotsFree, INBOX_BACKLOG_BATCH_LIMIT);

        let entries: InboxEntryWithMessage[];
        try {
          entries = await inboxService.claimBacklogForPush(app.db, inboxId, limit);
        } catch (err) {
          app.log.error({ err, agentId, inboxId, limit }, "claimBacklogForPush failed");
          return;
        }

        for (const entry of entries) {
          inboxInFlight.set(agentId, (inboxInFlight.get(agentId) ?? 0) + 1);
          if (!sendInboxDeliverFrame(entry)) {
            inboxInFlight.set(agentId, Math.max(0, (inboxInFlight.get(agentId) ?? 1) - 1));
            // Socket gone mid-drain — stop pushing. Remaining entries stay
            // 'delivered'; reaper will reset them and a future reconnect picks
            // them up.
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

      const authTimeout = setTimeout(() => {
        if (!session) {
          try {
            socket.send(JSON.stringify({ type: "auth:rejected", reason: "timeout" }));
          } catch {
            // socket may already be closed
          }
          socket.close(4401, "auth timeout");
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
          try {
            socket.send(JSON.stringify({ type: "auth:expired" }));
          } catch {
            // ignore
          }
          socket.close(4401, "auth expired");
        }, delay);
      };

      socket.on("message", async (raw) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
          return;
        }

        const parsed = wsMessageSchema.safeParse(msg);
        if (!parsed.success) {
          socket.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
          return;
        }

        const { type, ref } = parsed.data;

        // ── Auth gate — the very first frame must be {type:"auth"}.
        if (!session) {
          if (type !== "auth") {
            socket.send(JSON.stringify({ type: "auth:rejected", reason: "not_authenticated" }));
            socket.close(4401, "not authenticated");
            return;
          }
          const authParsed = wsAuthFrameSchema.safeParse(msg);
          if (!authParsed.success) {
            socket.send(JSON.stringify({ type: "auth:rejected", reason: "invalid_frame" }));
            socket.close(4401, "invalid auth");
            return;
          }

          try {
            const { payload } = await jwtVerify(authParsed.data.token, jwtSecretBytes);
            const claims = payload as {
              sub?: string;
              memberId?: string;
              organizationId?: string;
              role?: string;
              type?: string;
              exp?: number;
            };
            if (claims.type !== "access" || !claims.sub) {
              throw new Error("Invalid token claims");
            }

            const [user] = await app.db
              .select({ id: users.id, status: users.status })
              .from(users)
              .where(eq(users.id, claims.sub))
              .limit(1);
            if (!user || user.status !== "active") {
              throw new Error("User not found or suspended");
            }

            // Session is org-free (decouple-client-from-identity §4.2). The
            // JWT's `organizationId`/`memberId`/`role` claims are recorded as
            // hints only; bind-time R-RUN re-resolves the agent's owner
            // through `agents → manager → user` against the live DB.
            session = { userId: user.id };
            jwtDefaultOrgId = typeof claims.organizationId === "string" ? claims.organizationId : null;
            setWsConnectionAttrs(socket, { "user.id": user.id });
            clearTimeout(authTimeout);
            scheduleAuthExpiry(claims.exp);
            socket.send(JSON.stringify({ type: "auth:ok" }));
            // Wire-additive: older clients drop the unknown type; newer ones
            // use it to detect version drift. `capabilities.wsInboxDeliver`
            // must stay `true` here so 0.10.4 ~ 0.14.2 clients suppress
            // their local 5s HTTP poll on bootstrap — without this flag they
            // would fall back to `GET /inbox` + `POST /inbox/:id/ack` and
            // the missing ack endpoint would loop messages forever. 0.14.3+
            // clients ignore the field entirely.
            socket.send(
              JSON.stringify({
                type: "server:welcome",
                serverCommandVersion: app.commandVersion(),
                serverTimeMs: Date.now(),
                capabilities: { wsInboxDeliver: true },
              }),
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : "auth failure";
            socket.send(JSON.stringify({ type: "auth:rejected", reason: message }));
            socket.close(4401, "auth rejected");
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
                socket.send(
                  JSON.stringify({
                    type: "client:register:rejected",
                    message: "User has no active organization membership",
                  }),
                );
                socket.close(4403, "no membership");
                return;
              }
              let registerResult: clientService.RegisterClientResult;
              try {
                registerResult = await clientService.registerClient(
                  app.db,
                  {
                    clientId: data.clientId,
                    userId: session.userId,
                    organizationId: placeholderOrgId,
                    instanceId,
                    hostname: data.hostname,
                    os: data.os,
                    sdkVersion: data.sdkVersion,
                    lastUpdateAttempt: data.lastUpdateAttempt,
                  },
                  // Connection-stealing guard for soft-dedup: the canonical
                  // slot is "live" iff a DIFFERENT socket holds it and is
                  // still OPEN. If our own socket is registered there (e.g.
                  // an in-flight reconnect via the same id), we are NOT
                  // stealing — let the register through.
                  (canonicalId) => {
                    const existing = connectionManager.getClientConnection(canonicalId);
                    return existing !== undefined && existing !== socket && existing.readyState === existing.OPEN;
                  },
                );
              } catch (err) {
                const message = err instanceof Error ? err.message : "client register failed";
                const code =
                  err instanceof ClientUserMismatchError
                    ? err.code
                    : err instanceof ClientOrgMismatchError
                      ? err.code
                      : err instanceof ClientDedupConflictError
                        ? err.code
                        : undefined;
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

              // Use the canonical id for the local session, connection
              // manager registration, and the response frame. On the
              // soft-dedup redirect path the caller's input id is not the
              // identity the server tracks — see services/client.ts §B.
              clientId = registerResult.canonicalClientId;
              setWsConnectionAttrs(socket, { "client.id": registerResult.canonicalClientId });
              connectionManager.setClientConnection(registerResult.canonicalClientId, socket);
              socket.send(JSON.stringify({ type: "client:registered", clientId: registerResult.canonicalClientId }));

              // Backfill `agent:pinned` for any agent already bound to this
              // client at registration time. Without this, an admin who pins an
              // agent while the client is offline would still need a manual
              // `first-tree agent add` after restart — the realtime push in
              // admin/agents.ts only fires for live sockets. The client dedupes
              // on agentId, so re-firing on every reconnect is safe.
              //
              // Skip the backfill on the dedup-redirect path: the new CLI is
              // about to set `closing=true` and close this socket, so any
              // frames we push are wasted. The next reconnect (with the
              // canonical id in yaml) hits the same-id (A) branch and
              // backfills then to a stable socket.
              if (!registerResult.redirected) {
                try {
                  const pinned = await clientService.listActiveAgentsPinnedToClient(
                    app.db,
                    registerResult.canonicalClientId,
                  );
                  for (const agent of pinned) {
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
                        {
                          err: parsed.error.flatten(),
                          agentId: agent.uuid,
                          clientId: registerResult.canonicalClientId,
                        },
                        "agent:pinned backfill frame failed schema validation — skipping",
                      );
                      continue;
                    }
                    socket.send(JSON.stringify(parsed.data));
                  }
                } catch (err) {
                  app.log.error(
                    { err, clientId: registerResult.canonicalClientId },
                    "agent:pinned backfill on client:register failed — client may need manual `agent add`",
                  );
                }
              }
            } else if (type === "agent:bind") {
              if (!clientId) {
                socket.send(JSON.stringify({ type: "error", ref, message: "Must register client first" }));
                return;
              }

              const bindRequest = agentBindRequestSchema.parse(msg);

              const [agent] = await app.db
                .select({
                  id: agents.uuid,
                  displayName: agents.displayName,
                  type: agents.type,
                  organizationId: agents.organizationId,
                  inboxId: agents.inboxId,
                  status: agents.status,
                  clientId: agents.clientId,
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

              // First-bind path: agent.clientId is NULL (e.g. created before
              // the operator brought up a client, or migrated from pre-M1 with
              // no presence record). The race-safe UPDATE returns 0 rows if
              // another bind claimed it first — surface as WRONG_CLIENT.
              if (agent.clientId === null) {
                const claim = await app.db
                  .update(agents)
                  .set({ clientId, updatedAt: new Date() })
                  .where(and(eq(agents.uuid, agent.id), isNull(agents.clientId)))
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

              // Reject if the connecting client is running a different runtime
              // provider than the one pinned on the agent. The client repair
              // path will re-fetch authoritative state and respawn the right
              // handler before retrying the bind.
              if (bindRequest.runtimeType !== agent.runtimeProvider) {
                sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.RUNTIME_PROVIDER_MISMATCH);
                return;
              }

              await presenceService.bindAgent(app.db, agent.id, {
                clientId,
                instanceId,
                runtimeType: bindRequest.runtimeType,
                runtimeVersion: bindRequest.runtimeVersion,
              });

              // An agent that just rebound has, by definition, recovered from
              // whatever fault (stale / error / blocked) was last reported —
              // close any open unread fault row so the bell badge clears
              // instead of lingering across the offline gap.
              notificationService.markAgentFaultsResolved(app.db, agent.id).catch(() => {});

              connectionManager.bindAgentToClient(clientId, agent.id);
              boundAgents.set(agent.id, {
                agentId: agent.id,
                inboxId: agent.inboxId,
                organizationId: agent.organizationId,
              });

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
                }),
              );

              // Reconnect/recovery: drain any pending entries that piled up
              // while this socket was offline (or while another instance held
              // the subscription). Failures are logged inside the helper —
              // don't crash the bind path.
              drainBacklogForAgent(agent.id, agent.inboxId).catch((err) => {
                app.log.error({ err, agentId: agent.id }, "post-bind backlog drain crashed");
              });
            } else if (type === "agent:unbind") {
              const agentId = parsed.data.agentId;
              if (!agentId || !boundAgents.has(agentId)) {
                socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
                return;
              }

              const info = boundAgents.get(agentId);
              if (info) {
                notifier.unsubscribe(info.inboxId, socket);
              }

              await presenceService.unbindAgent(app.db, agentId);
              connectionManager.unbindAgentFromClient(agentId);
              boundAgents.delete(agentId);
              inboxInFlight.delete(agentId);

              socket.send(JSON.stringify({ type: "agent:unbound", agentId }));
            } else if (type === "session:state") {
              const agentId = parsed.data.agentId;
              if (!agentId || !boundAgents.has(agentId)) {
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
              if (!agentId || !boundAgents.has(agentId)) {
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
              if (!agentId || !boundAgents.has(agentId)) {
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
              if (!agentId || !boundAgents.has(agentId)) {
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
              const agentId = parsed.data.agentId;
              if (!agentId || !boundAgents.has(agentId)) {
                socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
                return;
              }

              const payload = sessionEventMessageSchema.parse(msg);
              const boundInfo = boundAgents.get(agentId);
              chainSessionOp(agentId, payload.chatId, async () => {
                try {
                  await sessionEventService.appendEvent(app.db, agentId, payload.chatId, payload.event);
                  if (boundInfo) {
                    // Best-effort cross-instance kick so admin WS sockets in
                    // the same org can invalidate `liveActivity` without
                    // waiting for the 15s `me/chats` poll. Failures are
                    // swallowed inside the notifier (fire-and-forget).
                    notifier
                      .notifySessionEvent(agentId, payload.chatId, payload.event.kind, boundInfo.organizationId)
                      .catch(() => {});
                  }
                } catch (err) {
                  socket.send(
                    JSON.stringify({
                      type: "error",
                      message: `Failed to persist session event: ${err instanceof Error ? err.message : String(err)}`,
                    }),
                  );
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
              const { entryId } = payloadResult.data;

              // Find the agent / inbox this entry belongs to from the bind
              // map. We never trust an `agentId` from the wire here — that
              // would let one bound agent ack another agent's entry. Instead
              // we resolve the inbox via the DB (one round-trip) and check
              // the resulting inboxId is in this socket's bound set.
              try {
                const ackedEntry = await inboxService.ackEntryByIdForBoundAgents(
                  app.db,
                  entryId,
                  [...boundAgents.values()].map((a) => a.inboxId),
                );
                if (!ackedEntry) {
                  // Either the entry doesn't exist, or it's not in 'delivered'
                  // status, or it belongs to an inbox this socket hasn't bound.
                  // All three are non-fatal — the client may have raced a
                  // server-side reset (300s timeout reaper) or be ack'ing a
                  // stale entry from a previous run. Debug-level only because
                  // the 300s reaper race is expected at low volume; promoting
                  // to warn would flood the logs on every reconnect.
                  app.log.debug(
                    { clientId, entryId, boundInboxes: boundAgents.size },
                    "inbox:ack matched no row — stale ack or reaper race",
                  );
                  return;
                }
                // Find the agentId that owns this inbox to decrement the
                // counter and trigger backlog drain.
                const owner = [...boundAgents.values()].find((a) => a.inboxId === ackedEntry.inboxId);
                if (owner) {
                  inboxInFlight.set(owner.agentId, Math.max(0, (inboxInFlight.get(owner.agentId) ?? 1) - 1));
                  // Slot freed → top up. Cheap when no backlog (single SQL
                  // statement returning 0 rows). Critical when the cap was
                  // hit and queued NOTIFYs got dropped (proposal §3.5).
                  drainBacklogForAgent(owner.agentId, owner.inboxId).catch((err) => {
                    app.log.error({ err, agentId: owner.agentId }, "post-ack backlog drain crashed");
                  });
                }
              } catch (err) {
                app.log.error({ err, entryId }, "inbox:ack handling failed");
              }
            } else if (type === "heartbeat") {
              if (clientId) {
                await clientService.heartbeatClient(app.db, clientId);
                await Promise.all([...boundAgents.keys()].map((id) => presenceService.touchAgent(app.db, id)));
              }
              socket.send(JSON.stringify({ type: "heartbeat:ack" }));
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : "Internal error";
            socket.send(JSON.stringify({ type: "error", message }));
          }
        });
      });

      socket.on("close", async (closeCode?: number) => {
        endWsConnectionSpan(socket, closeCode);
        clearTimeout(authTimeout);
        if (authExpiryTimer) clearTimeout(authExpiryTimer);

        for (const [agentId, info] of boundAgents) {
          notifier.unsubscribe(info.inboxId, socket);
          const currentOwner = connectionManager.getAgentClientId(agentId);
          if (currentOwner === clientId) {
            try {
              await presenceService.unbindAgent(app.db, agentId);
            } catch {
              // best-effort
            }
          }
        }
        boundAgents.clear();

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
          // `isActiveClientConnection` returns false at t2 because the in-
          // memory entry now points at the *new* socket, not us. Skip the DB
          // write in that case so the new connection's `connected` status
          // survives. Bug captured live at /clients[0].status='disconnected'
          // with last_seen_at 13s old + a fully-registered client.log.
          const stillActive = connectionManager.isActiveClientConnection(clientId, socket);
          connectionManager.removeClientConnection(clientId, socket);
          if (stillActive) {
            try {
              await clientService.disconnectClient(app.db, clientId);
            } catch {
              // best-effort
            }
          }
        }
      });
    });
  };
}
