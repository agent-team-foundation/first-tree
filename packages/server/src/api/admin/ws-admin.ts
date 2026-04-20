import { AGENT_STATUSES, AGENT_VISIBILITY } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, ne, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { jwtVerify } from "jose";
import type { WebSocket } from "ws";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { registerAdminBroadcaster } from "../../services/admin-broadcast.js";
import type { Notifier } from "../../services/notifier.js";

/**
 * Admin WebSocket: real-time push channel for Dashboard, scoped by organization
 * AND agent visibility (a member only sees pulse data for agents they are
 * allowed to see via REST).
 */

type SocketMeta = {
  organizationId: string;
  memberId: string;
  visibleAgentIds: Set<string>;
};

async function loadVisibleAgentIds(db: Database, organizationId: string, memberId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: agents.uuid })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, organizationId),
        ne(agents.status, AGENT_STATUSES.DELETED),
        or(eq(agents.visibility, AGENT_VISIBILITY.ORGANIZATION), eq(agents.managerId, memberId)),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

function filterPulseAgents(agentsMap: Record<string, unknown>, visible: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [agentId, buckets] of Object.entries(agentsMap)) {
    if (visible.has(agentId)) out[agentId] = buckets;
  }
  return out;
}

export function adminWsRoutes(notifier: Notifier, jwtSecret: string) {
  const adminSockets = new Map<WebSocket, SocketMeta>();
  const secret = new TextEncoder().encode(jwtSecret);

  function broadcastOrgScoped(payload: Record<string, unknown>) {
    const orgId = payload.organizationId;
    // Drop org-less payloads so the filter never falls through to a cross-org broadcast.
    if (typeof orgId !== "string" || orgId.length === 0) return;

    const isPulseTick = payload.type === "pulse:tick" && typeof payload.agents === "object" && payload.agents !== null;
    const sharedData = isPulseTick ? null : JSON.stringify(payload);

    for (const [ws, meta] of adminSockets) {
      if (ws.readyState !== 1 || meta.organizationId !== orgId) continue;
      if (isPulseTick) {
        // Per-recipient filter so a member never learns about agents they can't see via REST.
        const filtered = filterPulseAgents(payload.agents as Record<string, unknown>, meta.visibleAgentIds);
        ws.send(JSON.stringify({ ...payload, agents: filtered }));
      } else {
        ws.send(sharedData as string);
      }
    }
  }

  registerAdminBroadcaster(broadcastOrgScoped);

  notifier.onSessionStateChange((payload) => {
    broadcastOrgScoped({ type: "session:state", ...payload });
  });

  return async (app: FastifyInstance): Promise<void> => {
    app.get("/admin", { websocket: true }, async (socket, request) => {
      const token = (request.query as Record<string, string>).token;
      if (!token) {
        socket.send(JSON.stringify({ type: "error", message: "Missing token query parameter" }));
        socket.close(4001, "Missing token");
        return;
      }

      let organizationId: string;
      let memberId: string;
      try {
        const { payload } = await jwtVerify(token, secret);
        if (
          payload.type !== "access" ||
          !payload.sub ||
          typeof payload.organizationId !== "string" ||
          typeof payload.memberId !== "string"
        ) {
          socket.send(JSON.stringify({ type: "error", message: "Invalid token type" }));
          socket.close(4001, "Invalid token");
          return;
        }
        organizationId = payload.organizationId;
        memberId = payload.memberId;
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Invalid or expired token" }));
        socket.close(4001, "Auth failed");
        return;
      }

      // Visibility cached at connect time. New agents added mid-session won't
      // appear in pulses until the dashboard reconnects — acceptable trade-off
      // vs running this query per pulse tick.
      const visibleAgentIds = await loadVisibleAgentIds(app.db, organizationId, memberId);

      adminSockets.set(socket, { organizationId, memberId, visibleAgentIds });
      socket.send(JSON.stringify({ type: "admin:connected" }));

      socket.on("close", () => {
        adminSockets.delete(socket);
      });
    });
  };
}
