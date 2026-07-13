import { AGENT_STATUSES, AGENT_VISIBILITY, type AgentChatStatus } from "@first-tree/shared";
import { and, eq, ne, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { jwtVerify } from "jose";
import type { WebSocket } from "ws";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { members } from "../../db/schema/members.js";
import {
  createLogger,
  endWsConnectionSpan,
  setWsConnectionAttrs,
  startWsConnectionSpan,
} from "../../observability/index.js";
import { registerAdminBroadcaster } from "../../services/admin-broadcast.js";
import { getChatAgentStatuses } from "../../services/agent-chat-status.js";
import { getCachedAudience } from "../../services/chat-audience-cache.js";
import type { Notifier } from "../../services/notifier.js";

const log = createLogger("OrgWs");

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
    const sharedData = isPulseTick ? null : JSON.stringify(payload);

    for (const [ws, meta] of adminSockets) {
      if (ws.readyState !== 1 || meta.organizationId !== orgId) continue;
      if (isPulseTick) {
        const filtered = filterPulseAgents(payload.agents as Record<string, unknown>, meta.visibleAgentIds);
        ws.send(JSON.stringify({ ...payload, agents: filtered }));
      } else {
        ws.send(sharedData as string);
      }
    }
  }

  registerAdminBroadcaster(broadcastOrgScoped);

  notifier.onSessionStateChange((payload) => {
    void dispatchSessionFrame("session:state", payload);
  });

  notifier.onSessionEvent((payload) => {
    void dispatchSessionFrame("session:event", payload);
  });

  notifier.onSessionRuntime((payload) => {
    // Same shape as session:state — a per-(agent,chat) flip whose composite
    // status the audience patches in place. Audience filter is the same
    // (status carries narration via the freshly-recomputed activity).
    void dispatchSessionFrame("session:runtime", payload);
  });

  notifier.onChatMessage(({ chatId }) => {
    void dispatchChatMessage(chatId);
  });

  notifier.onChatUpdated(({ chatId }) => {
    void dispatchChatUpdated(chatId);
  });

  notifier.onMeChatsChanged(({ humanAgentId, organizationId }) => {
    dispatchMeChatsChanged(humanAgentId, organizationId);
  });

  /**
   * Deliver a session:state / session:event / session:runtime frame. The
   * recomputed agent status carries the agent's narration (activity.detail
   * / turnText), so it is attached ONLY for sockets whose viewer can access
   * the chat — NEVER sent org-wide. Audience members get the enriched frame
   * and patch `["chat-agent-status", chatId]` in place; every other org
   * socket gets the bare routing frame (invalidate-only). Computed once per
   * NOTIFY, only while admin sockets are connected.
   *
   * `session:runtime` rides on the same path as `session:state` because
   * they are semantically siblings — both signal "a per-(agent,chat)
   * composite axis flipped", just on different axes (lifecycle vs D-axis
   * runtime). Sharing the path keeps the web cache reconciliation
   * deterministic (one in-place patch, no invalidate races).
   */
  async function dispatchSessionFrame(
    type: "session:state" | "session:event" | "session:runtime",
    payload: { agentId: string; chatId: string; organizationId: string } & Record<string, unknown>,
  ): Promise<void> {
    if (adminSockets.size === 0) return;
    let status: AgentChatStatus | undefined;
    let audience: ReadonlySet<string> | null = null;
    try {
      const db = getDbForChatLookup();
      audience = await getCachedAudience(db, payload.chatId);
      if (audience && audience.size > 0) {
        status = (await getChatAgentStatuses(db, payload.chatId)).find((s) => s.agentId === payload.agentId);
      }
    } catch (err) {
      // Best-effort enrichment: on any failure fall back to the bare frame
      // everywhere (the client's invalidate path + refetch floor still cover it).
      // Logged (not silent) so a sustained DB hiccup that degrades the realtime
      // delta to refetch-latency is visible rather than invisible.
      log.warn({ err, chatId: payload.chatId, agentId: payload.agentId }, "session-frame status enrichment failed");
      status = undefined;
    }
    const bareFrame = JSON.stringify({ type, ...payload });
    const enrichedFrame = status ? JSON.stringify({ type, ...payload, status }) : bareFrame;
    for (const [ws, meta] of adminSockets) {
      if (ws.readyState !== 1 || meta.organizationId !== payload.organizationId) continue;
      const frame = status && audience?.has(meta.humanAgentId) ? enrichedFrame : bareFrame;
      try {
        ws.send(frame);
      } catch {
        // socket-level errors surface via close handler
      }
    }
  }

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

  // Metadata-change sibling of dispatchChatMessage: same chat-audience gate, but
  // emits a `chat:updated` frame (no messageId) so clients refresh chat-detail +
  // the conversation list without touching the message timeline.
  async function dispatchChatUpdated(chatId: string): Promise<void> {
    if (adminSockets.size === 0) return;
    const audience = await getCachedAudience(getDbForChatLookup(), chatId);
    if (!audience || audience.size === 0) return;
    const frame = JSON.stringify({ type: "chat:updated", chatId });
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

  // Per-USER sibling of dispatchChatUpdated: a private me-chats change (pin /
  // unpin) fans a bare `me-chats:changed` invalidation to ONLY the acting
  // user's own sockets in that org. Deliberately NO chat-audience lookup — pin
  // state is private and must never reach another member's devices, so the gate
  // is identity (`humanAgentId`) + org, not chat membership. One user with two
  // devices in the org sees both rails regroup; nobody else is touched. Sync
  // (no DB), so it runs inline on the notifier callback.
  function dispatchMeChatsChanged(humanAgentId: string, organizationId: string): void {
    if (adminSockets.size === 0) return;
    const frame = JSON.stringify({ type: "me-chats:changed" });
    for (const [ws, meta] of adminSockets) {
      if (ws.readyState !== 1) continue;
      if (meta.humanAgentId !== humanAgentId || meta.organizationId !== organizationId) continue;
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
      const ua = request.headers["user-agent"];
      startWsConnectionSpan(socket, {
        remoteIp: request.ip,
        userAgent: typeof ua === "string" ? ua.slice(0, 200) : undefined,
      });

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
