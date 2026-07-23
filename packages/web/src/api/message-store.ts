/**
 * Per-browser cache of chat messages keyed by `[chatId, messageId]`.
 *
 * First Tree's chat history is the **outcome stream** — only finalised messages are
 * persisted; transient `session_events` / `session_outputs` are not cached
 * here (they are session-lifecycle scoped on the server per
 * `agent-hub/client-runtime.md`, and come from a separate query in the UI).
 *
 * Lifecycle:
 *  - On chat open, the UI hydrates instantly from this cache so users see
 *    messages without a spinner-then-content flash.
 *  - The 5-second polling fetch writes through to this cache (idempotent
 *    upsert by composite key), so the cache grows over time and survives
 *    page reloads.
 *
 * Out of scope for v1:
 *  - Eviction (LRU / time-based). Storage grows unbounded; revisit when
 *    real-data sizes warrant it.
 *  - Cursor-based pagination of older history (a separate milestone).
 *
 * Origin: proposal `hub-chat-scroll-and-cache.20260509.md` (M1) — see
 * issue first-tree-all 119 under parent first-tree-all 118.
 */

import type { MessageWithDelivery } from "./chats.js";

const DB_NAME = "first-tree-chat-cache";
// Schema version is shared with read-state-store.ts (M2). Both modules
// open the same DB; whichever opens first triggers any pending upgrade.
// Each module's onupgradeneeded must defensively create-if-not-exists
// every store, so the schema lands the same regardless of call order.
const DB_VERSION = 2;
const STORE = "messages";
const INDEX_BY_CHAT_CREATED = "by_chat_created";
const READ_STATE_STORE = "read-state";

type StoredMessage = {
  // Composite key columns first so the keyPath is `[chatId, messageId]`.
  chatId: string;
  messageId: string;
  // The full server-side message payload, including transient delivery
  // status if present at cache-write time.
  payload: MessageWithDelivery;
  // Mirrors `payload.createdAt` lifted to a top-level field so the
  // `[chatId, createdAt]` index can range-scan without deserialising the
  // payload.
  createdAt: string;
  // When this row was last upserted; useful for future LRU eviction.
  cachedAt: number;
};

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: ["chatId", "messageId"] });
        store.createIndex(INDEX_BY_CHAT_CREATED, ["chatId", "createdAt"], { unique: false });
      }
      // Mirror the read-state store creation so this module's upgrade
      // handler is self-sufficient regardless of which module triggers
      // the v1 → v2 transition.
      if (!db.objectStoreNames.contains(READ_STATE_STORE)) {
        db.createObjectStore(READ_STATE_STORE, { keyPath: "chatId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/**
 * Read all cached messages for `chatId`, ordered ascending by `createdAt`
 * (oldest first, matching the timeline render order). Returns an empty
 * array on cache miss or if IndexedDB is unavailable — never throws.
 */
export async function getCachedMessages(chatId: string): Promise<MessageWithDelivery[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const index = store.index(INDEX_BY_CHAT_CREATED);
    // Range over the composite index from [chatId, ""] to [chatId, "￿"]
    // so we get exactly this chat's rows in createdAt order.
    const range = IDBKeyRange.bound([chatId, ""], [chatId, "￿"]);
    const out: MessageWithDelivery[] = [];
    const req = index.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const row = cursor.value as StoredMessage;
      out.push(row.payload);
      cursor.continue();
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => resolve(out);
    tx.onabort = () => resolve(out);
  });
}

/**
 * Upsert each message into the cache, keyed by `[chatId, messageId]`.
 * Idempotent — repeated writes of the same id overwrite. Messages from a
 * different chat than `chatId` are silently skipped (defensive; should
 * not happen with the current API).
 *
 * Returns silently on IndexedDB unavailability so write-through can be
 * fire-and-forget (`void cacheMessages(...)`) at the call site.
 */
export async function cacheMessages(chatId: string, messages: readonly MessageWithDelivery[]): Promise<void> {
  if (messages.length === 0) return;
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const now = Date.now();
    for (const m of messages) {
      if (m.chatId !== chatId) continue;
      const entry: StoredMessage = {
        chatId: m.chatId,
        messageId: m.id,
        payload: m,
        createdAt: m.createdAt,
        cachedAt: now,
      };
      store.put(entry);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/**
 * Remove every cached message for every chat. Called on logout so a later
 * account (or anyone else on the same browser profile) cannot read the
 * previous user's conversation history out of IndexedDB (SEC-042). The
 * cache is server-backed, so the next login re-hydrates it on demand.
 * Resolves silently on IndexedDB unavailability or clear failure —
 * logout must never be blocked by best-effort local cleanup.
 */
export async function clearAllChatCaches(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/**
 * Remove every cached message for `chatId`. Intended for diagnostic /
 * debug use today (e.g. clearing a corrupt cache); not wired into the
 * UI. Resolves silently on IndexedDB unavailability.
 */
export async function clearChatCache(chatId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const index = store.index(INDEX_BY_CHAT_CREATED);
    const range = IDBKeyRange.bound([chatId, ""], [chatId, "￿"]);
    const req = index.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}
