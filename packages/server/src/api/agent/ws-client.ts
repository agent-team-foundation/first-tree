import {
  agentActivitySchema,
  agentBindSchema,
  clientRegisterSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentTokens } from "../../db/schema/agent-tokens.js";
import { agents } from "../../db/schema/agents.js";
import * as activityService from "../../services/activity.js";
import * as clientService from "../../services/client.js";
import * as connectionManager from "../../services/connection-manager.js";
import type { Notifier } from "../../services/notifier.js";
import * as presenceService from "../../services/presence.js";
import { hashToken } from "../../utils.js";

const wsMessageSchema = z.object({
  type: z.string(),
  agentId: z.string().optional(),
  ref: z.string().optional(),
});

/**
 * M1 Client WebSocket: one WS per client, multiple agents multiplexed.
 *
 * Protocol:
 *   1. Client connects (no auth required at WS level)
 *   2. client:register — register client with env info
 *   3. agent:bind — bind agent to this client (authenticates via token)
 *   4. agent:activity — report runtime state changes
 *   5. heartbeat — client-level heartbeat
 *   6. agent:unbind — unbind agent
 */
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
          } else if (type === "agent:activity") {
            const agentId = parsed.data.agentId;
            if (!agentId || !boundAgents.has(agentId)) {
              socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
              return;
            }

            const activityPayload = agentActivitySchema.parse(msg);
            await activityService.updateActivity(app.db, agentId, activityPayload);
          } else if (type === "heartbeat") {
            if (clientId) {
              await clientService.heartbeatClient(app.db, clientId);
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
