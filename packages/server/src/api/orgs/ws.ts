import { AGENT_STATUSES, AGENT_VISIBILITY } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, ne, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { jwtVerify } from "jose";
import type { WebSocket } from "ws";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { members } from "../../db/schema/members.js";
import { endWsConnectionSpan, setWsConnectionAttrs, startWsConnectionSpan } from "../../observability/index.js";
import { registerAdminBroadcaster } from "../../services/admin-broadcast.js";
import { getCachedAudience } from "../../services/chat-audience-cache.js";
import type { Notifier } from "../../services/notifier.js";

/**
 * Class B — `/api/v1/orgs/:orgId/ws`. Real-time admin push channel.
 * Org is taken from the path; JWT only needs `sub`. Membership in the
 * target org is probed in real time on every handshake — a revoked
 * membership refuses immediately.
 */

type SocketMeta = {
  organizationId: string;
  memberId: string;
  humanAgentId: string;
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

export function orgWsRoutes(notifier: Notifier, jwtSecret: string) {
  const adminSockets = new Map<WebSocket, SocketMeta>();
  const secret = new TextEncoder().encode(jwtSecret);

  function broadcastOrgScoped(payload: Record<string, unknown>) {
    const orgId = payload.organizationId;
    if (typeof orgId !== "string" || orgId.length === 0) return;

    const isPulseTick = payload.type === "pulse:tick" && typeof payload.agents === "object" && payload.agents !== null;
    const isNotification = payload.type === "notification";
    const notificationAgentId =
      isNotification && typeof payload.agentId === "string" && payload.agentId.length > 0 ? payload.agentId : null;
    const sharedData = isPulseTick ? null : JSON.stringify(payload);

    for (const [ws, meta] of adminSockets) {
      if (ws.readyState !== 1 || meta.organizationId !== orgId) continue;
      if (isPulseTick) {
        const filtered = filterPulseAgents(payload.agents as Record<string, unknown>, meta.visibleAgentIds);
        ws.send(JSON.stringify({ ...payload, agents: filtered }));
      } else {
        if (isNotification && notificationAgentId && !meta.visibleAgentIds.has(notificationAgentId)) {
          continue;
        }
        ws.send(sharedData as string);
      }
    }
  }

  registerAdminBroadcaster(broadcastOrgScoped);

  notifier.onSessionStateChange((payload) => {
    broadcastOrgScoped({ type: "session:state", ...payload });
  });

  notifier.onChatMessage(({ chatId }) => {
    void dispatchChatMessage(chatId);
  });

  async function dispatchChatMessage(chatId: string): Promise<void> {
    if (adminSockets.size === 0) return;
    const audience = await getCachedAudience(getDbForChatLookup(), chatId);
    if (!audience || audience.size === 0) return;
    const frame = JSON.stringify({ type: "chat:message", chatId });
    for (const [ws, meta] of adminSockets) {
      if (ws.readyState !== 1) continue;
      if (!audience.has(meta.humanAgentId)) continue;
      try {
        ws.send(frame);
      } catch {
        // socket-level errors surface via close handler
      }
    }
  }

  let cachedDbForChatLookup: Database | null = null;
  function getDbForChatLookup(): Database {
    if (!cachedDbForChatLookup) throw new Error("admin WS: db not initialised yet");
    return cachedDbForChatLookup;
  }
  function rememberDb(db: Database): void {
    if (!cachedDbForChatLookup) cachedDbForChatLookup = db;
  }

  return async (app: FastifyInstance): Promise<void> => {
    app.get<{ Params: { orgId: string } }>("/", { websocket: true }, async (socket, request) => {
      startWsConnectionSpan(socket, { remoteIp: request.ip });

      const orgIdFromPath = (request.params as { orgId?: string }).orgId;
      const token = (request.query as Record<string, string>).token;
      if (!token || !orgIdFromPath) {
        socket.send(JSON.stringify({ type: "error", message: "Missing token or org" }));
        socket.close(4001, "Missing token");
        endWsConnectionSpan(socket, 4001);
        return;
      }

      let userId: string;
      try {
        const { payload } = await jwtVerify(token, secret);
        if (payload.type !== "access" || typeof payload.sub !== "string") {
          socket.send(JSON.stringify({ type: "error", message: "Invalid token type" }));
          socket.close(4001, "Invalid token");
          endWsConnectionSpan(socket, 4001);
          return;
        }
        userId = payload.sub;
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Invalid or expired token" }));
        socket.close(4001, "Auth failed");
        endWsConnectionSpan(socket, 4001);
        return;
      }

      const organizationId = orgIdFromPath;
      const [memberRow] = await app.db
        .select({ id: members.id, role: members.role, agentId: members.agentId })
        .from(members)
        .where(
          and(eq(members.userId, userId), eq(members.organizationId, organizationId), eq(members.status, "active")),
        )
        .limit(1);
      if (!memberRow) {
        socket.send(JSON.stringify({ type: "error", message: "Not an active member of this organization" }));
        socket.close(4403, "Not a member");
        endWsConnectionSpan(socket, 4403);
        return;
      }
      const memberId = memberRow.id;

      setWsConnectionAttrs(socket, { organizationId, memberId });
      rememberDb(app.db);

      const visibleAgentIds = await loadVisibleAgentIds(app.db, organizationId, memberId);

      const [humanAgentRow] = await app.db
        .select({ uuid: agents.uuid })
        .from(agents)
        .where(eq(agents.uuid, memberRow.agentId))
        .limit(1);
      const humanAgentId = humanAgentRow?.uuid ?? memberRow.agentId;

      adminSockets.set(socket, { organizationId, memberId, humanAgentId, visibleAgentIds });
      socket.send(JSON.stringify({ type: "admin:connected" }));

      socket.on("close", (code) => {
        adminSockets.delete(socket);
        endWsConnectionSpan(socket, code);
      });
    });
  };
}
