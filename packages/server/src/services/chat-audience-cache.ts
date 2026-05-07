/**
 * Process-local cache for the per-chat realtime push audience
 * (`chat_participants ∪ chat_subscriptions`, keyed by human agent
 * uuid). Sits in front of the admin WS dispatch so a chat with N
 * messages/sec doesn't issue N audience-resolution queries; one query
 * + cache hit per chat per TTL window.
 *
 * The cache exposes both a populator (`getCachedAudience`) and an
 * invalidator (`invalidateChatAudience`). Participant-mutation paths
 * (`addMeChatParticipants`, `joinMeChat`, `leaveMeChat`,
 * `recomputeChatWatchers`, `joinAsParticipant`, `leaveAsParticipant`)
 * MUST call `invalidateChatAudience` after their tx commits so the
 * very next dispatch reflects the new audience without waiting for
 * the TTL to age out — without invalidation, a freshly-added speaker
 * would miss `chat:message` pushes for up to TTL_MS.
 *
 * Cross-instance correctness: not handled here. The PG NOTIFY layer
 * already broadcasts message events to every replica; each replica's
 * audience cache is independently invalidated by its own
 * service-layer mutations on chats it routes traffic for. For
 * cross-replica participant changes to invalidate this cache, route
 * the mutation through the same replica that hosts the WS connection
 * (sticky routing) or add a dedicated `chat:audience` PG NOTIFY in
 * a follow-up.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { createLogger } from "../observability/index.js";

const log = createLogger("ChatAudienceCache");

const TTL_MS = 5_000;
const MAX_ENTRIES = 1024;

type Entry = { audience: Set<string>; expiresAt: number };
const cache = new Map<string, Entry>();

/** Resolve a chat's push audience, hitting the cache when fresh.
 *  Returns null on DB error (caller should skip dispatch). */
export async function getCachedAudience(db: Database, chatId: string): Promise<Set<string> | null> {
  const now = Date.now();
  const cached = cache.get(chatId);
  if (cached && cached.expiresAt > now) return cached.audience;

  try {
    const rows = await db.execute<{ agent_id: string }>(sql`
      SELECT agent_id FROM chat_participants WHERE chat_id = ${chatId}
      UNION
      SELECT agent_id FROM chat_subscriptions WHERE chat_id = ${chatId}
    `);
    const audience = new Set(rows.map((r) => r.agent_id));
    cache.set(chatId, { audience, expiresAt: now + TTL_MS });
    if (cache.size > MAX_ENTRIES) {
      // Opportunistic cleanup: walk the map and drop expired entries.
      for (const [k, v] of cache) {
        if (v.expiresAt <= now) cache.delete(k);
      }
    }
    return audience;
  } catch (err) {
    // Returning null causes `dispatchChatMessage` to skip the push for
    // this event. Web reconnects refetch on their own, so transient
    // failures here just mean a few seconds of latency instead of a
    // missed message — but a sustained log here would mean the realtime
    // path is silently degraded, which is worth surfacing.
    log.warn({ err, chatId }, "failed to resolve chat audience");
    return null;
  }
}

/** Drop the cached audience for a chat. Called from participant-
 *  mutation paths after their transaction commits, so the next
 *  `chat:message` dispatch hits the DB and reflects the new
 *  membership instead of serving a stale TTL window. */
export function invalidateChatAudience(chatId: string): void {
  cache.delete(chatId);
}
