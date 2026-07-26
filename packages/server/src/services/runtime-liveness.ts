import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";

export type ClientHeartbeatRecord = {
  clientId: string;
  instanceId: string;
  routedAgentIds: readonly string[];
  /** Optional pause reason from the client heartbeat frame. Absent/null clears. */
  pausedReason?: "auth_rejected" | "auth_refresh_failed" | null;
};

export type ClientHeartbeatResult = {
  clientUpdated: boolean;
  restoredAgentIds: string[];
};

/**
 * Record positive liveness evidence from the active client WebSocket.
 *
 * Heartbeat proves client/socket reachability and, for agents still routed on
 * that socket, route reachability. It does not prove runtime activity or
 * provider health, so this operation intentionally leaves runtime fields alone.
 */
export async function recordClientHeartbeat(db: Database, data: ClientHeartbeatRecord): Promise<ClientHeartbeatResult> {
  const now = new Date();

  const updatedClients = await db
    .update(clients)
    .set({
      status: "connected",
      instanceId: data.instanceId,
      lastSeenAt: now,
      pausedReason: data.pausedReason ?? null,
    })
    .where(
      and(
        eq(clients.id, data.clientId),
        isNull(clients.retiredAt),
        or(isNull(clients.instanceId), eq(clients.instanceId, data.instanceId)),
      ),
    )
    .returning({ id: clients.id });

  const routedAgentIds = [...new Set(data.routedAgentIds)];
  if (updatedClients.length === 0 || routedAgentIds.length === 0) {
    return { clientUpdated: updatedClients.length > 0, restoredAgentIds: [] };
  }

  const restoredAgents = await db
    .update(agentPresence)
    .set({
      status: "online",
      clientId: data.clientId,
      instanceId: data.instanceId,
      lastSeenAt: now,
    })
    .where(
      and(
        inArray(agentPresence.agentId, routedAgentIds),
        sql`EXISTS (
          SELECT 1 FROM ${agents}
          WHERE ${agents.uuid} = ${agentPresence.agentId}
            AND ${agents.clientId} = ${data.clientId}
            AND ${agents.status} = 'active'
        )`,
      ),
    )
    .returning({ agentId: agentPresence.agentId });

  return {
    clientUpdated: updatedClients.length > 0,
    restoredAgentIds: restoredAgents.map((row) => row.agentId),
  };
}
