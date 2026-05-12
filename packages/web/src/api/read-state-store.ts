/**
 * Per-browser, per-chat read-state cache: the id of the last message the
 * user has actually seen in each chat, plus when it was recorded.
 *
 * On chat open, the UI reads this value and scrolls to that message
 * instead of the bottom (the M1-era default). Tracked locally only —
 * the server has no concept of per-user last-read, by design.
 *
 * Lives in the same IndexedDB database (`first-tree-hub-chat-cache`) as
 * the message cache, in a separate store. v1 schema = a single row per
 * chatId; if multi-account-per-device becomes a real concern later, the
 * key can be extended without breaking compatibility.
 *
 * Origin: proposal `hub-chat-scroll-and-cache.20260509.md` (M2) — see
 * issue first-tree-all 120.
 */

const DB_NAME = "first-tree-hub-chat-cache";
const DB_VERSION = 2;
const MESSAGES_STORE = "messages";
const MESSAGES_INDEX = "by_chat_created";
const READ_STATE_STORE = "read-state";

export type ReadState = {
  chatId: string;
  lastReadMessageId: string;
  lastReadAt: number;
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
      // v1 → ensure the messages store exists (created by message-store.ts
      // for users still on schema v1; we re-create defensively here so the
      // upgrade is idempotent regardless of which module ran first).
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        const store = db.createObjectStore(MESSAGES_STORE, { keyPath: ["chatId", "messageId"] });
        store.createIndex(MESSAGES_INDEX, ["chatId", "createdAt"], { unique: false });
      }
      // v2 → add the read-state store.
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
 * Read the last-read marker for `chatId`. Returns `null` on cache miss,
 * on IndexedDB unavailability, or on any read error — never throws.
 */
export async function getLastRead(chatId: string): Promise<ReadState | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(READ_STATE_STORE, "readonly");
    const store = tx.objectStore(READ_STATE_STORE);
    const req = store.get(chatId);
    req.onsuccess = () => {
      const row = req.result as ReadState | undefined;
      resolve(row ?? null);
    };
    req.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
  });
}

/**
 * Upsert the last-read marker for `chatId`. Fire-and-forget at call
 * sites: the write is best-effort, must never delay rendering, and
 * silently no-ops if IndexedDB is unavailable.
 */
export async function setLastRead(chatId: string, lastReadMessageId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(READ_STATE_STORE, "readwrite");
    const store = tx.objectStore(READ_STATE_STORE);
    const entry: ReadState = {
      chatId,
      lastReadMessageId,
      lastReadAt: Date.now(),
    };
    store.put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/**
 * Remove the last-read marker for `chatId`. Intended for diagnostic /
 * debug use today; the production UI never calls this. Resolves
 * silently on IndexedDB unavailability.
 */
export async function clearLastRead(chatId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(READ_STATE_STORE, "readwrite");
    const store = tx.objectStore(READ_STATE_STORE);
    store.delete(chatId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}
