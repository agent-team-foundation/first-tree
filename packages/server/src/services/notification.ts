import type {
  NotificationQuery,
  NotificationSeverity,
  NotificationType,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { notifications } from "../db/schema/notifications.js";
import { uuidv7 } from "../uuid.js";
import * as systemConfigService from "./system-config.js";

export type CreateNotificationData = {
  organizationId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  agentId?: string | null;
  chatId?: string | null;
  message: string;
};

/**
 * Push channels: Admin WS, Webhook, Feishu.
 * Set at app startup via `setAdminWsBroadcast` and reloaded from system_configs.
 */
let adminWsBroadcast: ((payload: Record<string, unknown>) => void) | null = null;

/** Register the admin WS broadcast function (called once at app startup). */
export function setAdminWsBroadcast(fn: (payload: Record<string, unknown>) => void): void {
  adminWsBroadcast = fn;
}

/** Create a notification, persist it, and fire-and-forget push to all channels. */
export async function createNotification(db: Database, data: CreateNotificationData) {
  const id = uuidv7();

  const [row] = await db
    .insert(notifications)
    .values({
      id,
      organizationId: data.organizationId,
      type: data.type,
      severity: data.severity,
      agentId: data.agentId ?? null,
      chatId: data.chatId ?? null,
      message: data.message,
    })
    .returning();

  if (!row) throw new Error("Unexpected: INSERT RETURNING produced no row");

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

  // Fire-and-forget push to all channels
  pushToAdminWs(notification);
  pushToWebhook(db, notification).catch(() => {});

  return notification;
}

/** List notifications with pagination and optional filters. */
export async function listNotifications(db: Database, orgId: string, query: NotificationQuery) {
  const conditions = [eq(notifications.organizationId, orgId)];

  if (query.cursor) conditions.push(lt(notifications.createdAt, new Date(query.cursor)));
  if (query.severity) conditions.push(eq(notifications.severity, query.severity));
  if (query.read !== undefined) conditions.push(eq(notifications.read, query.read));
  if (query.agentId) conditions.push(eq(notifications.agentId, query.agentId));

  const where = and(...conditions);

  const rows = await db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
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

/** Mark a single notification as read. */
export async function markRead(db: Database, notificationId: string) {
  const [updated] = await db
    .update(notifications)
    .set({ read: true })
    .where(eq(notifications.id, notificationId))
    .returning();
  return updated ?? null;
}

/** Mark all notifications as read for an organization. */
export async function markAllRead(db: Database, orgId: string) {
  await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.organizationId, orgId), eq(notifications.read, false)));
}

/**
 * Convenience: create a notification for an agent event, resolving org automatically.
 * Fire-and-forget — errors are swallowed.
 */
export async function notifyAgentEvent(
  db: Database,
  agentId: string,
  type: NotificationType,
  severity: NotificationSeverity,
  message: string,
  chatId?: string | null,
): Promise<void> {
  try {
    const [agent] = await db
      .select({ organizationId: agents.organizationId, name: agents.name, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.uuid, agentId))
      .limit(1);
    if (!agent) return;

    // Resolve human-readable name for notification messages
    const name = agent.displayName ?? agent.name ?? agentId;
    const resolvedMessage = message.replace(agentId, name);

    await createNotification(db, {
      organizationId: agent.organizationId,
      type,
      severity,
      agentId,
      chatId: chatId ?? null,
      message: resolvedMessage,
    });
  } catch {
    // fire-and-forget
  }
}

// -- Push channels (fire-and-forget) --

function pushToAdminWs(notification: Record<string, unknown>): void {
  if (!adminWsBroadcast) return;
  try {
    adminWsBroadcast({ type: "notification", data: notification });
  } catch {
    // fire-and-forget
  }
}

async function pushToWebhook(db: Database, notification: Record<string, unknown>): Promise<void> {
  const webhookUrl = (await systemConfigService.getConfig(db, "notification_webhook_url")) as string | null;
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
