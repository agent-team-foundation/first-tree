/**
 * Per-browser, per-chat **scroll-position** memory: the id of the
 * message that sat at the bottom edge of the user's viewport the last
 * time they left this chat (unmount, tab visibility-loss, or as the
 * scroll settled mid-session).
 *
 * On chat open, the UI scrolls that message to the viewport bottom,
 * so any later-arrived messages — agent replies that came in while
 * the chat was unselected, or that the user scrolled past without
 * seeing — sit just below the fold. A floating pill surfaces their
 * count.
 *
 * Earlier revisions modeled this as a *monotonic last-read marker*
 * (advanced forward only as a message was in the viewport for
 * ≥500ms). That was rejected during PR 286 manual sign-off: the user
 * expects "come back to where I left visually" — i.e. when leaving
 * the bottom and then scrolling up to re-read, returning to the chat
 * later should NOT skip back to the bottom even if no new messages
 * arrived. A snapshot-on-leave model captures that intent directly.
 *
 * The IDB schema field name is `bottomVisibleMessageId` to match the
 * new semantics. The store name (`read-state`) and surrounding code
 * still use the historical "read state" vocabulary because the
 * concept is, externally, "where to drop the user back into the
 * chat" — and the rest of the codebase (UnreadDivider, unread count)
 * still talks about reads even though the underlying signal is
 * scroll-position-on-leave.
 *
 * Origin: proposal `hub-chat-scroll-and-cache.20260509.md` (M2),
 * revised during PR 286 manual sign-off — see issue
 * first-tree-all 120.
 */

const DB_NAME = "first-tree-hub-chat-cache";
const DB_VERSION = 2;
const MESSAGES_STORE = "messages";
const MESSAGES_INDEX = "by_chat_created";
const READ_STATE_STORE = "read-state";

export type ReadState = {
  chatId: string;
  /**
   * The message that was at (or nearest to) the bottom edge of the
   * viewport when the user last left this chat. Not necessarily the
   * latest message in the chat — that's the whole point.
   */
  bottomVisibleMessageId: string;
  /** Wall-clock when the snapshot was taken. Used for diagnostics. */
  updatedAt: number;
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
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        const store = db.createObjectStore(MESSAGES_STORE, { keyPath: ["chatId", "messageId"] });
        store.createIndex(MESSAGES_INDEX, ["chatId", "createdAt"], { unique: false });
      }
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
 * Read the scroll-position snapshot for `chatId`. Returns `null` on
 * cache miss, on IndexedDB unavailability, or on any read error —
 * never throws.
 */
export async function getReadState(chatId: string): Promise<ReadState | null> {
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
 * Upsert the scroll-position snapshot for `chatId`. Fire-and-forget
 * at call sites: the write is best-effort, must never delay
 * rendering, and silently no-ops if IndexedDB is unavailable.
 */
export async function setReadState(chatId: string, bottomVisibleMessageId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(READ_STATE_STORE, "readwrite");
    const store = tx.objectStore(READ_STATE_STORE);
    const entry: ReadState = {
      chatId,
      bottomVisibleMessageId,
      updatedAt: Date.now(),
    };
    store.put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/**
 * Remove the scroll-position snapshot for `chatId`. Intended for
 * diagnostic / debug use today; the production UI never calls this.
 * Resolves silently on IndexedDB unavailability.
 */
export async function clearReadState(chatId: string): Promise<void> {
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
