import { NOTIFICATION_TYPES, type NotificationSeverity, type NotificationType } from "@first-tree/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { notifications } from "../db/schema/notifications.js";
import { uuidv7 } from "../uuid.js";

export type CreateNotificationData = {
  organizationId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  agentId?: string | null;
  chatId?: string | null;
  message: string;
  /**
   * Optional dedup key. While a prior unread notification with the same
   * `(organizationId, dedupKey)` exists, repeated inserts are suppressed at
   * the DB layer (partial unique index `uq_notifications_org_dedup_unread`).
   * After the row flips to read (e.g. via {@link markAgentFaultsResolved}),
   * a new notification can fire. Producers without a dedup key get the
   * legacy always-insert behaviour.
   */
  dedupKey?: string | null;
};

/**
 * Persist a notification and fire-and-forget push to the outbound webhook.
 *
 * Dedup contract (when `dedupKey` is set and an unread row already exists):
 *   - **severity escalates monotonically** — `high` never drops back to
 *     `medium`, `medium` never drops back to `low`.
 *   - **type and message take the latest event's values** — so a row keyed by
 *     `agent:{id}:fault` reflects the most recent observation.
 *   - **createdAt is preserved** so ordering tracks "when did this incident
 *     open" rather than "when was the last observation".
 *
 * Rows without a `dedupKey` never hit the partial unique index and keep the
 * legacy always-insert behaviour.
 */
export async function createNotification(db: Database, data: CreateNotificationData) {
  const id = uuidv7();

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
    .onConflictDoUpdate({
      target: [notifications.organizationId, notifications.dedupKey],
      set: {
        severity: sql`CASE
          WHEN ${notifications.severity} = 'high' OR excluded.severity = 'high' THEN 'high'
          WHEN ${notifications.severity} = 'medium' OR excluded.severity = 'medium' THEN 'medium'
          ELSE 'low'
        END`,
        type: sql`excluded.type`,
        message: sql`excluded.message`,
      },
      targetWhere: sql`${notifications.read} = false AND ${notifications.dedupKey} IS NOT NULL`,
    })
    .returning();

  const row = inserted[0];
  if (!row) {
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

  pushToWebhook(notification).catch(() => {});

  return notification;
}

// -- Message composition --------------------------------------------------

type AgentContext = {
  organizationId: string;
  agentName: string;
  clientId: string | null;
  clientLabel: string | null;
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

function composeMessage(type: NotificationType, agentCtx: AgentContext): string {
  const agent = agentCtx.agentName;
  const computer = agentCtx.clientLabel ?? "Unknown computer";

  switch (type) {
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
 * Convenience: create a notification for an agent event, resolving org and
 * agent display name automatically.
 *
 * Default dedup_key when none is supplied: `agent:{agentId}:fault`. All three
 * current fault types (error / blocked / stale) collapse onto one unread row
 * per agent. Pair with {@link markAgentFaultsResolved}, which closes the row
 * when the agent recovers.
 *
 * Fire-and-forget — errors are swallowed so event producers never fail just
 * because the notification pipeline is unhealthy.
 */
export async function notifyAgentEvent(
  db: Database,
  agentId: string,
  type: NotificationType,
  severity: NotificationSeverity,
  options: { dedupKey?: string | null } = {},
): Promise<void> {
  try {
    const agentCtx = await resolveAgentContext(db, agentId);
    if (!agentCtx) return;

    const message = composeMessage(type, agentCtx);
    const dedupKey = options.dedupKey === undefined ? `agent:${agentId}:fault` : options.dedupKey;

    await createNotification(db, {
      organizationId: agentCtx.organizationId,
      type,
      severity,
      agentId,
      message,
      dedupKey,
    });
  } catch {
    // fire-and-forget
  }
}

/**
 * Mark every unread fault-scoped notification for this agent as read. Called
 * when the agent recovers — either by rebinding (offline → online) or by
 * reporting a healthy runtime state (error/blocked → idle/working). Without
 * this, a transient incident leaves its row in "unread" forever and dedup
 * would suppress the next genuine incident.
 *
 * Fire-and-forget — same rationale as {@link notifyAgentEvent}.
 */
export async function markAgentFaultsResolved(db: Database, agentId: string): Promise<void> {
  try {
    await db
      .update(notifications)
      .set({ read: true })
      .where(
        and(
          eq(notifications.agentId, agentId),
          eq(notifications.read, false),
          inArray(notifications.type, [
            NOTIFICATION_TYPES.AGENT_ERROR,
            NOTIFICATION_TYPES.AGENT_BLOCKED,
            NOTIFICATION_TYPES.AGENT_STALE,
          ]),
        ),
      );
  } catch {
    // fire-and-forget
  }
}

// -- Outbound webhook (fire-and-forget) -----------------------------------

async function pushToWebhook(notification: Record<string, unknown>): Promise<void> {
  const webhookUrl = process.env.FIRST_TREE_NOTIFICATION_WEBHOOK_URL;
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
