import type { MessageWithDelivery } from "../api/chats.js";

/**
 * Detect a known gap between the IDB cache range and the server's "last 50"
 * window. If there is no id-overlap and the server's oldest fetched message
 * is strictly newer than the cache's newest, the user was away long enough
 * that more than 50 messages went past in between and there is no way to
 * fill them in until cursor pagination ships.
 *
 * Returns the id of the newest cached message (= the anchor before which the
 * gap banner should render) when a gap is detected. Returns `null` when
 * there is overlap (the common case), when either side is empty, or when
 * the server window already reaches at least as far back as the cache.
 */
export function findGapAfterMessageId(
  fromCache: readonly MessageWithDelivery[],
  fromServer: readonly MessageWithDelivery[],
): string | null {
  const firstCached = fromCache[0];
  const firstServer = fromServer[0];
  if (!firstCached || !firstServer) return null;

  const serverIds = new Set(fromServer.map((m) => m.id));
  for (const cached of fromCache) {
    if (serverIds.has(cached.id)) return null;
  }

  let newestCached = firstCached;
  for (const m of fromCache) {
    if (m.createdAt > newestCached.createdAt) newestCached = m;
  }
  let oldestServer = firstServer;
  for (const m of fromServer) {
    if (m.createdAt < oldestServer.createdAt) oldestServer = m;
  }

  if (oldestServer.createdAt <= newestCached.createdAt) return null;
  return newestCached.id;
}
