import {
  AGENT_STATUSES,
  AGENT_VISIBILITY,
  type NotificationQuery,
  type NotificationSeverity,
  type NotificationType,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { notifications } from "../db/schema/notifications.js";
import { uuidv7 } from "../uuid.js";
import { broadcastAdminsCrossInstance } from "./admin-broadcast.js";

export type CreateNotificationData = {
  organizationId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  agentId?: string | null;
  chatId?: string | null;
  /**
   * ID of the physical client (computer) the notification is about. Only
   * used to surface on the admin WS envelope — not persisted on the
   * notifications table itself.
   */
  clientId?: string | null;
  message: string;
  /**
   * Optional dedup key. While a prior unread notification with the same
   * `(organizationId, dedupKey)` exists, repeated inserts are suppressed at
   * the DB layer (partial unique index `uq_notifications_org_dedup_unread`).
   * After the user marks the prior row read, a new notification can fire.
   * Producers without a dedup key get the legacy always-insert behaviour.
   */
  dedupKey?: string | null;
};

/**
 * Create a notification, persist it, and fire-and-forget push to all channels.
 *
 * Returns `null` when the insert was suppressed by the dedup partial unique
 * index — i.e. an unread notification with the same `(orgId, dedupKey)`
 * already exists and the producer should treat this call as a no-op.
 */
export async function createNotification(db: Database, data: CreateNotificationData) {
  const id = uuidv7();

  // ON CONFLICT DO NOTHING on the partial unique index. The index only
  // applies when read=false AND dedup_key IS NOT NULL, so producers without
  // a dedup_key never collide and keep their always-insert semantics.
  const inserted = await db
    .insert(notifications)
    .values({
      id,
      organizationId: data.organizationId,
      type: data.type,
      severity: data.severity,
      agentId: data.agentId ?? null,
      chatId: data.chatId ?? null,
      message: data.message,
      dedupKey: data.dedupKey ?? null,
    })
    .onConflictDoNothing({ target: [notifications.organizationId, notifications.dedupKey] })
    .returning();

  const row = inserted[0];
  if (!row) {
    // Dedup suppressed the insert. Callers should treat this as a no-op —
    // the prior unread row is still in flight to the admin UI.
    return null;
  }

  const notification = {
    id: row.id,
    organizationId: row.organizationId,
    type: row.type,
    severity: row.severity,
    agentId: row.agentId,
    chatId: row.chatId,
    message: row.message,
    read: row.read,
    createdAt: row.createdAt.toISOString(),
  };

  // Fire-and-forget push to all channels. The WS layer re-filters by
  // per-member agent visibility so a push about a private agent never reaches
  // members who can't see that agent via REST.
  pushToAdminWs(notification);
  pushToWebhook(notification).catch(() => {});

  return notification;
}

/**
 * List notifications with pagination and optional filters, scoped to the
 * caller's visible agents.
 *
 * Rule: a member sees a notification iff
 *   - it carries an `agentId` the member can see
 *     (`agents.visibility = organization` OR `agents.managerId = self`), OR
 *   - it has no `agentId` (org-wide system notification)
 *
 * Private agents owned by other members never surface.
 */
export async function listNotifications(db: Database, orgId: string, memberId: string, query: NotificationQuery) {
  const visibleAgents = await loadVisibleAgentIds(db, orgId, memberId);

  if (query.agentId && !visibleAgents.has(query.agentId)) {
    return { items: [], nextCursor: null };
  }

  const targetLimit = query.limit;

  const conditions = [eq(notifications.organizationId, orgId), buildVisibilityCondition([...visibleAgents])];
  if (query.cursor) conditions.push(lt(notifications.createdAt, new Date(query.cursor)));
  if (query.severity) conditions.push(eq(notifications.severity, query.severity));
  if (query.read !== undefined) conditions.push(eq(notifications.read, query.read));
  if (query.agentId) conditions.push(eq(notifications.agentId, query.agentId));

  // Visibility is now part of the SQL predicate (`agent_id IS NULL OR
  // agent_id IN visible`) instead of an in-Node post-filter, so we fetch
  // exactly `limit + 1` rows and rely on the DB to discard invisible rows.
  // This eliminates the 400-row overscan ceiling that previously made
  // long-tail visible rows invisible when invisible-agent noise dominated.
  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(targetLimit + 1);

  const hasMore = rows.length > targetLimit;
  const items = hasMore ? rows.slice(0, targetLimit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

  return {
    items: items.map((n) => ({
      ...n,
      createdAt: n.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

/**
 * Return the unread notification count for this member's visible agents.
 * Single `SELECT COUNT(*)` — no row fetch — so the topbar bell badge can
 * surface an accurate number (>100) without paying for a list query.
 */
export async function unreadCount(db: Database, orgId: string, memberId: string): Promise<number> {
  const visibleAgents = await loadVisibleAgentIds(db, orgId, memberId);

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.organizationId, orgId),
        eq(notifications.read, false),
        buildVisibilityCondition([...visibleAgents]),
      ),
    );
  return row?.count ?? 0;
}

/** Mark a single notification as read, scoped to organization + visible agents. */
export async function markRead(db: Database, notificationId: string, orgId: string, memberId: string) {
  const [existing] = await db
    .select({ id: notifications.id, agentId: notifications.agentId })
    .from(notifications)
    .where(and(eq(notifications.id, notificationId), eq(notifications.organizationId, orgId)))
    .limit(1);
  if (!existing) return null;

  if (existing.agentId) {
    const visible = await loadVisibleAgentIds(db, orgId, memberId);
    if (!visible.has(existing.agentId)) return null;
  }

  const [updated] = await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.id, notificationId), eq(notifications.organizationId, orgId)))
    .returning();
  return updated ?? null;
}

/** Mark all notifications visible to this member as read. */
export async function markAllRead(db: Database, orgId: string, memberId: string) {
  const visible = await loadVisibleAgentIds(db, orgId, memberId);

  // Single UPDATE covering every visible unread row in the org. Org-wide rows
  // (agentId IS NULL) are always visible; agent-scoped rows are filtered to
  // the member's visible agent set. The same visibility predicate is reused
  // by listNotifications and unreadCount so the three surfaces agree.
  await db
    .update(notifications)
    .set({ read: true })
    .where(
      and(
        eq(notifications.organizationId, orgId),
        eq(notifications.read, false),
        buildVisibilityCondition([...visible]),
      ),
    );
}

/**
 * SQL fragment matching every notification visible to a member: org-wide
 * (`agent_id IS NULL`) plus rows tied to an agent in the member's visible
 * set. Centralised so listNotifications, markAllRead, and unreadCount can
 * never drift apart.
 */
function buildVisibilityCondition(visibleAgentIds: string[]) {
  if (visibleAgentIds.length === 0) return isNull(notifications.agentId);
  return or(isNull(notifications.agentId), inArray(notifications.agentId, visibleAgentIds));
}

/**
 * Shared visibility predicate. Mirrors
 * {@link packages/server/src/services/access-control.ts#agentVisibilityCondition}
 * but returns a Set because the notification query joins are mostly in Node.
 */
async function loadVisibleAgentIds(db: Database, orgId: string, memberId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: agents.uuid })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, orgId),
        ne(agents.status, AGENT_STATUSES.DELETED),
        or(eq(agents.visibility, AGENT_VISIBILITY.ORGANIZATION), eq(agents.managerId, memberId)),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

// -- Message composition --------------------------------------------------

type AgentContext = {
  organizationId: string;
  agentName: string;
  clientId: string | null;
  clientLabel: string | null;
};

type ChatContext = {
  chatLabel: string;
};

async function resolveAgentContext(db: Database, agentId: string): Promise<AgentContext | null> {
  const [agent] = await db
    .select({
      organizationId: agents.organizationId,
      name: agents.name,
      displayName: agents.displayName,
      clientId: agents.clientId,
    })
    .from(agents)
    .where(eq(agents.uuid, agentId))
    .limit(1);
  if (!agent) return null;

  let clientLabel: string | null = null;
  if (agent.clientId) {
    const [client] = await db
      .select({ hostname: clients.hostname, id: clients.id })
      .from(clients)
      .where(eq(clients.id, agent.clientId))
      .limit(1);
    clientLabel = client?.hostname ?? agent.clientId;
  }

  return {
    organizationId: agent.organizationId,
    agentName: agent.displayName ?? agent.name ?? agentId,
    clientId: agent.clientId,
    clientLabel,
  };
}

async function resolveChatContext(db: Database, chatId: string): Promise<ChatContext> {
  const [chat] = await db.select({ topic: chats.topic }).from(chats).where(eq(chats.id, chatId)).limit(1);
  // Chat topic is nullable; fall back to a short hash of the chat id so the
  // message still reads as a concrete entity rather than "Chat null completed".
  const shortId = chatId.slice(0, 8);
  const label = chat?.topic && chat.topic.trim().length > 0 ? chat.topic.trim() : `Chat ${shortId}`;
  return { chatLabel: label };
}

/**
 * Compose a human-readable message for each notification type.
 *
 * Keep subjects consistent with what the dashboard shows the member:
 *   - Session-scoped events → subject is the chat (topic / "Chat xxxxxxxx")
 *   - Client-scoped events  → subject is the computer (hostname / clientId)
 *   - Agent-scoped events   → subject is the agent display name
 */
function composeMessage(type: NotificationType, agentCtx: AgentContext, chatCtx: ChatContext | null): string {
  const agent = agentCtx.agentName;
  const computer = agentCtx.clientLabel ?? "Unknown computer";
  const chat = chatCtx?.chatLabel ?? null;

  switch (type) {
    case "session_completed":
      return chat ? `${chat} completed` : `${agent} completed a task`;
    case "session_error":
      return chat ? `${chat} hit an error` : `${agent} hit a session error`;
    case "agent_stale":
      return `Computer ${computer} is unresponsive`;
    case "agent_error":
      return `${agent} entered error state`;
    case "agent_blocked":
      return `${agent} is blocked`;
    default:
      return `${agent} event`;
  }
}

/**
 * Convenience: create a notification for an agent event, resolving org,
 * agent display name, computer hostname, and chat topic automatically.
 * Callers supply the event type, severity, and (recommended) dedup_key; the
 * message text is generated here so language/phrasing is centralized (see
 * {@link composeMessage}).
 *
 * Default dedup_key when none is supplied: `agent:{agentId}:{type}` or, when
 * a chatId is present, `chat:{chatId}:{type}`. This makes "burst of identical
 * events for the same agent/chat surfaces a single unread row" the default
 * behaviour rather than an opt-in — pass `dedupKey: null` if you want the
 * legacy "every event creates a new row" semantics.
 *
 * Fire-and-forget — errors are swallowed so event producers never fail just
 * because the notification pipeline is unhealthy.
 */
export async function notifyAgentEvent(
  db: Database,
  agentId: string,
  type: NotificationType,
  severity: NotificationSeverity,
  options: { chatId?: string | null; dedupKey?: string | null } = {},
): Promise<void> {
  try {
    const agentCtx = await resolveAgentContext(db, agentId);
    if (!agentCtx) return;

    const chatId = options.chatId ?? null;
    const chatCtx = chatId ? await resolveChatContext(db, chatId) : null;
    const message = composeMessage(type, agentCtx, chatCtx);

    const dedupKey =
      options.dedupKey === undefined
        ? chatId
          ? `chat:${chatId}:${type}`
          : `agent:${agentId}:${type}`
        : options.dedupKey;

    await createNotification(db, {
      organizationId: agentCtx.organizationId,
      type,
      severity,
      agentId,
      chatId,
      clientId: agentCtx.clientId,
      message,
      dedupKey,
    });
  } catch {
    // fire-and-forget
  }
}

// -- Push channels (fire-and-forget) --

function pushToAdminWs(notification: Record<string, unknown>): void {
  // organizationId is hoisted to the top of the envelope so the admin WS route
  // can filter strictly (no `!orgId` fallback that silently fans out to every
  // org). `agentId` is also hoisted so the WS route can additionally scope by
  // per-member agent visibility before relaying to a given socket.
  //
  // Cross-instance: the envelope goes onto the `admin_broadcast_envelopes`
  // PG NOTIFY channel; every server instance LISTENs and feeds the envelope
  // back into its local `broadcastToAdmins` fanout. With a single instance the
  // round-trip is sub-millisecond; with multiple, every admin socket on every
  // instance sees the same event without an extra delivery hop.
  broadcastAdminsCrossInstance({
    type: "notification",
    organizationId: notification.organizationId as string,
    agentId: (notification.agentId as string | null) ?? null,
    data: notification,
  });
}

async function pushToWebhook(notification: Record<string, unknown>): Promise<void> {
  const webhookUrl = process.env.FIRST_TREE_HUB_NOTIFICATION_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // fire-and-forget — webhook delivery is best-effort
  }
}
