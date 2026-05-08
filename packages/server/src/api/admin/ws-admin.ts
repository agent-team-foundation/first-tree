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
 * Admin WebSocket: real-time push channel for Dashboard, scoped by organization
 * AND agent visibility (a member only sees pulse data for agents they are
 * allowed to see via REST).
 */

type SocketMeta = {
  organizationId: string;
  memberId: string;
  /**
   * The 1:1 human agent for the (user, org) of this socket. Used by the
   * chat-first workspace `chat:message` push: a chat audience is expressed
   * in agent uuids (chat_participants + chat_subscriptions), so we match
   * each socket against that set by `humanAgentId`.
   */
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

export function adminWsRoutes(notifier: Notifier, jwtSecret: string) {
  const adminSockets = new Map<WebSocket, SocketMeta>();
  const secret = new TextEncoder().encode(jwtSecret);

  function broadcastOrgScoped(payload: Record<string, unknown>) {
    const orgId = payload.organizationId;
    // Drop org-less payloads so the filter never falls through to a cross-org broadcast.
    if (typeof orgId !== "string" || orgId.length === 0) return;

    const isPulseTick = payload.type === "pulse:tick" && typeof payload.agents === "object" && payload.agents !== null;
    // Agent-scoped notifications carry `agentId` on the envelope — suppress
    // the push for any socket whose member can't see that agent via REST.
    // Notifications with null agentId are org-wide and fan out unrestricted.
    const isNotification = payload.type === "notification";
    const notificationAgentId =
      isNotification && typeof payload.agentId === "string" && payload.agentId.length > 0 ? payload.agentId : null;
    const sharedData = isPulseTick ? null : JSON.stringify(payload);

    for (const [ws, meta] of adminSockets) {
      if (ws.readyState !== 1 || meta.organizationId !== orgId) continue;
      if (isPulseTick) {
        // Per-recipient filter so a member never learns about agents they can't see via REST.
        const filtered = filterPulseAgents(payload.agents as Record<string, unknown>, meta.visibleAgentIds);
        ws.send(JSON.stringify({ ...payload, agents: filtered }));
      } else {
        if (isNotification && notificationAgentId && !meta.visibleAgentIds.has(notificationAgentId)) {
          // This member cannot see the agent — skip the push. The REST list
          // endpoint also filters them out so the bell's unread count stays
          // consistent with the data the dashboard actually shows.
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

  // Chat-first workspace: `chat:message` is per-chat, not per-org. We resolve
  // the audience as `chat_participants ∪ chat_subscriptions` (both keyed by
  // human agent uuid for our purposes) and dispatch only to sockets whose
  // `humanAgentId` is in that set. Best-effort — DB errors / dropped frames
  // are tolerated by the web client which falls back to refetch on reconnect.
  notifier.onChatMessage(({ chatId }) => {
    void dispatchChatMessage(chatId);
  });

  // Per-chat audience cache lives in `services/chat-audience-cache.ts`
  // so the participant-mutation paths can call `invalidateChatAudience`
  // after their tx commits — without that hook, a freshly-added speaker
  // would miss `chat:message` pushes for up to the TTL window.

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
        // socket-level errors are surfaced via close handler
      }
    }
  }

  // The DB handle is captured per-request below; keep a back-reference so the
  // notifier callback (which has no fastify request scope) can run a small
  // lookup. Set on first WS upgrade and reused thereafter.
  let cachedDbForChatLookup: Database | null = null;
  function getDbForChatLookup(): Database {
    if (!cachedDbForChatLookup) {
      throw new Error("admin WS: db not initialised yet");
    }
    return cachedDbForChatLookup;
  }
  function rememberDb(db: Database): void {
    if (!cachedDbForChatLookup) cachedDbForChatLookup = db;
  }

  return async (app: FastifyInstance): Promise<void> => {
    // See ws-client.ts for why config.otel is disabled on WS upgrade routes.
    app.get("/admin", { websocket: true, config: { otel: false } }, async (socket, request) => {
      startWsConnectionSpan(socket, { remoteIp: request.ip });

      const token = (request.query as Record<string, string>).token;
      if (!token) {
        socket.send(JSON.stringify({ type: "error", message: "Missing token query parameter" }));
        socket.close(4001, "Missing token");
        endWsConnectionSpan(socket, 4001);
        return;
      }

      let userId: string;
      let organizationId: string;
      try {
        const { payload } = await jwtVerify(token, secret);
        if (
          payload.type !== "access" ||
          typeof payload.sub !== "string" ||
          typeof payload.organizationId !== "string"
        ) {
          socket.send(JSON.stringify({ type: "error", message: "Invalid token type" }));
          socket.close(4001, "Invalid token");
          endWsConnectionSpan(socket, 4001);
          return;
        }
        userId = payload.sub;
        // JWT `organizationId` is a hint for which org the dashboard wants
        // to watch; the authoritative membership comes from the realtime
        // probe below (decouple-client-from-identity §D.4).
        organizationId = payload.organizationId;
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Invalid or expired token" }));
        socket.close(4001, "Auth failed");
        endWsConnectionSpan(socket, 4001);
        return;
      }

      // Realtime membership probe — refuse the subscription if the user is
      // no longer an active member of the org. Must run on every handshake;
      // a JWT for a revoked membership cannot keep watching the dashboard.
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

      // Cache the db handle for the chat-message notifier callback (which has
      // no fastify scope). Idempotent.
      rememberDb(app.db);

      // Visibility cached at connect time. New agents added mid-session won't
      // appear in pulses until the dashboard reconnects — acceptable trade-off
      // vs running this query per pulse tick.
      const visibleAgentIds = await loadVisibleAgentIds(app.db, organizationId, memberId);

      // Resolve the (user, org) human agent uuid. members.agentId is unique
      // and non-null after migration 0024.
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
