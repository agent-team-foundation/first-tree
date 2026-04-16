import {
  agentBindSchema,
  clientRegisterSchema,
  runtimeStateMessageSchema,
  sessionOutputMessageSchema,
  sessionStateMessageSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentTokens } from "../../db/schema/agent-tokens.js";
import { agents } from "../../db/schema/agents.js";
import * as activityService from "../../services/activity.js";
import * as clientService from "../../services/client.js";
import * as connectionManager from "../../services/connection-manager.js";
import * as notificationService from "../../services/notification.js";
import type { Notifier } from "../../services/notifier.js";
import * as presenceService from "../../services/presence.js";
import * as sessionOutputService from "../../services/session-output.js";
import { hashToken } from "../../utils.js";

const wsMessageSchema = z.object({
  type: z.string(),
  agentId: z.string().optional(),
  ref: z.string().optional(),
});

/**
 * Client WebSocket: one WS per client, multiple agents multiplexed.
 *
 * Protocol:
 *   1. Client connects (no auth required at WS level)
 *   2. client:register — register client with env info
 *   3. agent:bind — bind agent to this client (authenticates via token)
 *   4. session:state — report per-session state changes
 *   5. heartbeat — client-level heartbeat
 *   6. agent:unbind — unbind agent
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
  // Prevent unbounded growth — prune old entries periodically
  if (notificationCooldowns.size > 1000) {
    for (const [k, ts] of notificationCooldowns) {
      if (now - ts > NOTIFICATION_COOLDOWN_MS) notificationCooldowns.delete(k);
    }
  }
  return true;
}

export function clientWsRoutes(notifier: Notifier, instanceId: string) {
  return async (app: FastifyInstance): Promise<void> => {
    app.get("/client", { websocket: true }, async (socket) => {
      let clientId: string | null = null;
      const boundAgents = new Map<string, { agentId: string; inboxId: string }>();

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

        try {
          if (type === "client:register") {
            const data = clientRegisterSchema.parse(msg);
            clientId = data.clientId;

            await clientService.registerClient(app.db, {
              clientId: data.clientId,
              instanceId,
              hostname: data.hostname,
              os: data.os,
              sdkVersion: data.sdkVersion,
            });

            connectionManager.setClientConnection(data.clientId, socket);

            socket.send(JSON.stringify({ type: "client:registered", clientId: data.clientId }));
          } else if (type === "agent:bind") {
            if (!clientId) {
              socket.send(JSON.stringify({ type: "error", ref, message: "Must register client first" }));
              return;
            }

            const data = agentBindSchema.parse(msg);

            // Authenticate agent via token
            const raw = data.token;
            if (!raw.startsWith("aghub_")) {
              socket.send(JSON.stringify({ type: "error", ref, message: "Invalid token format" }));
              return;
            }

            const hash = hashToken(raw);
            const [tokenRow] = await app.db
              .select({ agentId: agentTokens.agentId })
              .from(agentTokens)
              .where(and(eq(agentTokens.tokenHash, hash), isNull(agentTokens.revokedAt)))
              .limit(1);

            if (!tokenRow) {
              socket.send(JSON.stringify({ type: "error", ref, message: "Invalid or revoked token" }));
              return;
            }

            const [agent] = await app.db
              .select({
                id: agents.uuid,
                displayName: agents.displayName,
                type: agents.type,
                organizationId: agents.organizationId,
                inboxId: agents.inboxId,
              })
              .from(agents)
              .where(and(eq(agents.uuid, tokenRow.agentId), eq(agents.status, "active")))
              .limit(1);

            if (!agent) {
              socket.send(JSON.stringify({ type: "error", ref, message: "Agent is suspended or not found" }));
              return;
            }

            // Bind agent to this client
            await presenceService.bindAgent(app.db, agent.id, {
              clientId,
              instanceId,
              runtimeType: data.runtimeType,
              runtimeVersion: data.runtimeVersion,
            });

            connectionManager.bindAgentToClient(clientId, agent.id);
            boundAgents.set(agent.id, { agentId: agent.id, inboxId: agent.inboxId });

            // Subscribe to inbox notifications
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

            // Notify session completed (with cooldown to avoid noise from rapid outputs)
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
        // Unbind agents that are still owned by this client.
        // If an agent was re-bound to a different client while this socket was alive,
        // we must NOT unbind it (that would corrupt the new binding).
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
