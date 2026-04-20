import {
  AGENT_BIND_REJECT_REASONS,
  type AgentBindRejectReason,
  agentBindRequestSchema,
  clientRegisterSchema,
  runtimeStateMessageSchema,
  sessionOutputMessageSchema,
  sessionStateMessageSchema,
  WS_AUTH_FRAME_TIMEOUT_MS,
  wsAuthFrameSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { jwtVerify } from "jose";
import type { WebSocket } from "ws";
import { z } from "zod";
import { agents } from "../../db/schema/agents.js";
import { clients } from "../../db/schema/clients.js";
import { members } from "../../db/schema/members.js";
import { users } from "../../db/schema/users.js";
import * as activityService from "../../services/activity.js";
import * as clientService from "../../services/client.js";
import * as connectionManager from "../../services/connection-manager.js";
import * as notificationService from "../../services/notification.js";
import type { Notifier } from "../../services/notifier.js";
import * as presenceService from "../../services/presence.js";
import * as sessionOutputService from "../../services/session-output.js";

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
 *   4. `session:state` / `runtime:state` / `session:output` / `heartbeat`.
 *   5. `agent:unbind` — stop multiplexing for a specific agent.
 *
 * When the JWT is about to expire the server sends `auth:expired` so the
 * SDK can refresh and reconnect without silently half-opening the socket.
 */

/** Notification cooldown: prevents duplicate notifications for same (agentId, type) within window. */
const NOTIFICATION_COOLDOWN_MS = 300_000; // 5 minutes
const notificationCooldowns = new Map<string, number>();

function shouldNotify(agentId: string, notificationType: string): boolean {
  const key = `${agentId}:${notificationType}`;
  const now = Date.now();
  const lastSent = notificationCooldowns.get(key);
  if (lastSent && now - lastSent < NOTIFICATION_COOLDOWN_MS) return false;
  notificationCooldowns.set(key, now);
  if (notificationCooldowns.size > 1000) {
    for (const [k, ts] of notificationCooldowns) {
      if (now - ts > NOTIFICATION_COOLDOWN_MS) notificationCooldowns.delete(k);
    }
  }
  return true;
}

type AuthenticatedSession = {
  userId: string;
  memberId: string;
  organizationId: string;
  role: string;
};

function sendRejected(socket: WebSocket, ref: string | undefined, reason: AgentBindRejectReason): void {
  socket.send(JSON.stringify({ type: "agent:bind:rejected", ref, reason }));
}

export function clientWsRoutes(notifier: Notifier, instanceId: string) {
  return async (app: FastifyInstance): Promise<void> => {
    const jwtSecretBytes = new TextEncoder().encode(app.config.secrets.jwtSecret);

    app.get("/client", { websocket: true }, async (socket) => {
      let session: AuthenticatedSession | null = null;
      let clientId: string | null = null;
      let authExpiryTimer: NodeJS.Timeout | null = null;
      const boundAgents = new Map<string, { agentId: string; inboxId: string }>();

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
            if (claims.type !== "access" || !claims.sub || !claims.memberId) {
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

            const [member] = await app.db
              .select({ id: members.id, organizationId: members.organizationId, role: members.role })
              .from(members)
              .where(eq(members.id, claims.memberId))
              .limit(1);
            if (!member) {
              throw new Error("Membership not found");
            }

            session = {
              userId: user.id,
              memberId: member.id,
              organizationId: member.organizationId,
              role: member.role,
            };
            clearTimeout(authTimeout);
            scheduleAuthExpiry(claims.exp);
            socket.send(JSON.stringify({ type: "auth:ok" }));
          } catch (err) {
            const message = err instanceof Error ? err.message : "auth failure";
            socket.send(JSON.stringify({ type: "auth:rejected", reason: message }));
            socket.close(4401, "auth rejected");
          }
          return;
        }

        try {
          if (type === "client:register") {
            const data = clientRegisterSchema.parse(msg);

            try {
              await clientService.registerClient(app.db, {
                clientId: data.clientId,
                userId: session.userId,
                instanceId,
                hostname: data.hostname,
                os: data.os,
                sdkVersion: data.sdkVersion,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : "client register failed";
              socket.send(JSON.stringify({ type: "client:register:rejected", message }));
              socket.close(4403, "client register rejected");
              return;
            }

            clientId = data.clientId;
            connectionManager.setClientConnection(data.clientId, socket);
            socket.send(JSON.stringify({ type: "client:registered", clientId: data.clientId }));
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
                clientUserId: clients.userId,
                managerUserId: members.userId,
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
            if (agent.organizationId !== session.organizationId) {
              sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_ORG);
              return;
            }
            if (agent.status !== "active") {
              sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.AGENT_SUSPENDED);
              return;
            }

            // First-bind path: agent.clientId is NULL (e.g. created before
            // the operator brought up a client, or migrated from pre-M1 with
            // no presence record). Claim it for the connecting client iff
            // the manager and the connecting session belong to the same
            // user. The race-safe UPDATE returns 0 rows if another bind
            // claimed it first — surface as WRONG_CLIENT.
            if (agent.clientId === null) {
              if (!agent.managerUserId || agent.managerUserId !== session.userId) {
                sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.NOT_OWNED);
                return;
              }
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

            await presenceService.bindAgent(app.db, agent.id, {
              clientId,
              instanceId,
              runtimeType: bindRequest.runtimeType,
              runtimeVersion: bindRequest.runtimeVersion,
            });

            connectionManager.bindAgentToClient(clientId, agent.id);
            boundAgents.set(agent.id, { agentId: agent.id, inboxId: agent.inboxId });

            notifier.subscribe(agent.inboxId, socket);

            socket.send(
              JSON.stringify({
                type: "agent:bound",
                ref,
                agentId: agent.id,
                displayName: agent.displayName,
                agentType: agent.type,
              }),
            );
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

            socket.send(JSON.stringify({ type: "agent:unbound", agentId }));
          } else if (type === "session:state") {
            const agentId = parsed.data.agentId;
            if (!agentId || !boundAgents.has(agentId)) {
              socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
              return;
            }

            const payload = sessionStateMessageSchema.parse(msg);
            await activityService.upsertSessionState(app.db, agentId, payload.chatId, payload.state, notifier);
          } else if (type === "runtime:state") {
            const agentId = parsed.data.agentId;
            if (!agentId || !boundAgents.has(agentId)) {
              socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
              return;
            }

            const payload = runtimeStateMessageSchema.parse(msg);
            await presenceService.setRuntimeState(app.db, agentId, payload.runtimeState);

            if (payload.runtimeState === "error" && shouldNotify(agentId, "agent_error")) {
              notificationService
                .notifyAgentEvent(app.db, agentId, "agent_error", "high", `Agent ${agentId} entered error state`)
                .catch(() => {});
            } else if (payload.runtimeState === "blocked" && shouldNotify(agentId, "agent_blocked")) {
              notificationService
                .notifyAgentEvent(app.db, agentId, "agent_blocked", "medium", `Agent ${agentId} is blocked`)
                .catch(() => {});
            }
          } else if (type === "session:output") {
            const agentId = parsed.data.agentId;
            if (!agentId || !boundAgents.has(agentId)) {
              socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
              return;
            }

            const payload = sessionOutputMessageSchema.parse(msg);
            sessionOutputService.appendOutput(app.db, agentId, payload.chatId, payload.content).catch(() => {});

            if (shouldNotify(agentId, `session_completed:${payload.chatId}`)) {
              notificationService
                .notifyAgentEvent(
                  app.db,
                  agentId,
                  "session_completed",
                  "low",
                  `Agent ${agentId} completed a task`,
                  payload.chatId,
                )
                .catch(() => {});
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

      socket.on("close", async () => {
        clearTimeout(authTimeout);
        if (authExpiryTimer) clearTimeout(authExpiryTimer);

        for (const [agentId, info] of boundAgents) {
          notifier.unsubscribe(info.inboxId, socket);
          const currentOwner = connectionManager.getAgentClientId(agentId);
          if (currentOwner === clientId) {
            try {
              await presenceService.unbindAgent(app.db, agentId);
              if (shouldNotify(agentId, "agent_disconnected")) {
                notificationService
                  .notifyAgentEvent(app.db, agentId, "agent_disconnected", "medium", `Agent ${agentId} disconnected`)
                  .catch(() => {});
              }
            } catch {
              // best-effort
            }
          }
        }
        boundAgents.clear();

        if (clientId) {
          connectionManager.removeClientConnection(clientId, socket);
          try {
            await clientService.disconnectClient(app.db, clientId);
          } catch {
            // best-effort
          }
        }
      });
    });
  };
}
