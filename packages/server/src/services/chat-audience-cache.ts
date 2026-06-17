/**
 * Process-local cache for the per-chat realtime push audience
 * (every row in `chat_membership` for the chat — speakers + watchers,
 * keyed by human agent uuid). Sits in front of the admin WS dispatch
 * so a chat with N messages/sec doesn't issue N audience-resolution
 * queries; one query + cache hit per chat per TTL window.
 *
 * The cache exposes both a populator (`getCachedAudience`) and an
 * invalidator (`invalidateChatAudience`). Participant-mutation paths
 * MUST call `invalidateChatAudience` after their tx commits so the
 * very next dispatch reflects the new audience without waiting for
 * the TTL to age out — without invalidation, a freshly-added speaker
 * would miss `chat:message` pushes for up to TTL_MS.
 *
 * Canonical bundles already enclose this step internally — callers that
 * route through `applyMembershipWrite` (used by `inviteParticipantsToChat`
 * / `ensureParticipant`) or through `joinAsParticipant` /
 * `leaveAsParticipant` do NOT need to call it themselves. Direct callers
 * of `addChatParticipants`, `recomputeChatWatchers`, or any other ad-hoc
 * speaker-row write are still responsible.
 *
 * Cross-instance correctness: handled via a fan-out dispatcher.
 * `invalidateChatAudience` drops the LOCAL replica's entry AND fires a
 * registered dispatcher (wired at boot to a `chat_audience_events` PG
 * NOTIFY) so every other replica drops its entry too. Each replica's
 * NOTIFY listener calls `invalidateChatAudienceLocal` — the local-only
 * variant — so the fan-out cannot loop. Without this, a membership change
 * made on replica A would leave replica B (hosting a viewer's admin WS)
 * serving a stale audience — and silently dropping that member's
 * `chat:message` pushes — until the entry aged out after TTL_MS.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { createLogger } from "../observability/index.js";

const log = createLogger("ChatAudienceCache");

// Cross-replica fan-out hook. Registered once at boot (see app.ts) with a
// function that issues the `chat_audience_events` PG NOTIFY. Left null in
// unit tests and single-process contexts, where the local drop is enough.
type AudienceInvalidationDispatcher = (chatId: string) => void;
let dispatcher: AudienceInvalidationDispatcher | null = null;

/** Wire the cross-replica fan-out (the PG NOTIFY publisher). Call once at boot. */
export function registerChatAudienceDispatcher(fn: AudienceInvalidationDispatcher): void {
  dispatcher = fn;
}

/** Drop the cross-replica fan-out hook (test teardown). */
export function resetChatAudienceDispatcher(): void {
  dispatcher = null;
}

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
      SELECT agent_id FROM chat_membership WHERE chat_id = ${chatId}
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
 *  membership instead of serving a stale TTL window. Also fans the
 *  invalidation to every other replica via the registered dispatcher so
 *  the replica hosting a viewer's admin WS doesn't keep a stale audience. */
export function invalidateChatAudience(chatId: string): void {
  cache.delete(chatId);
  if (dispatcher) {
    try {
      dispatcher(chatId);
    } catch {
      // best-effort fan-out — a miss just means the remote replica's entry
      // ages out after TTL_MS instead of being dropped immediately.
    }
  }
}

/** Drop the cached audience for a chat on THIS replica only — no cross-replica
 *  fan-out. Used by the `chat_audience_events` NOTIFY listener so a fanned
 *  invalidation cannot re-broadcast and loop. */
export function invalidateChatAudienceLocal(chatId: string): void {
  cache.delete(chatId);
}
