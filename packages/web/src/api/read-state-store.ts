/**
 * Per-browser, per-chat snapshot taken when the user leaves a chat,
 * used to restore scroll position and to mark the old/new boundary
 * on return.
 *
 * The two persisted ids serve distinct roles:
 *
 *  - `bottomVisibleMessageId` — the message that sat at the bottom
 *    edge of the viewport at leave time. On return, the UI scrolls
 *    this message back to the viewport bottom so the user resumes
 *    at the same visual position.
 *
 *  - `latestKnownMessageId` — the chat tip (chronologically latest
 *    message in the chat) at leave time. On return, any message
 *    strictly newer than this is "new since you were last here":
 *    counted by the pill and divided from prior content by the
 *    "New Messages" divider.
 *
 * The two are equal when the user left the chat at the bottom. They
 * diverge when the user scrolled up before leaving — `bottomVisible`
 * trails behind `latestKnown`. The bug that drove this distinction:
 * if `latestKnown` were instead the user's session high watermark,
 * a mid-scroll leave + return would falsely surface the messages
 * between the high water and the chat tip as "new" — but they were
 * already there before the user left.
 *
 * Origin: proposal `hub-chat-scroll-and-cache.20260509.md` (M2),
 * revised through PR 286 manual sign-off. See issue first-tree-all
 * 120.
 */

import { currentUserIdFromToken } from "../lib/current-user-id.js";

// Pre-namespacing database name (SEC-042). This module shares one
// per-account database (`first-tree-chat-cache:u:<userId>`) with
// message-store.ts but holds its own connection, so the logout purge must
// close BOTH modules' handles. The legacy database is deleted — not
// migrated — on first namespaced open; see message-store.ts for the
// rationale.
const LEGACY_DB_NAME = "first-tree-chat-cache";
const DB_VERSION = 2;
const MESSAGES_STORE = "messages";
const MESSAGES_INDEX = "by_chat_created";
const READ_STATE_STORE = "read-state";

export type ReadState = {
  chatId: string;
  /**
   * The message that was at (or nearest to) the bottom edge of the
   * viewport at the moment the user left this chat. Drives the
   * `scrollToMessageImmediate` anchor on return.
   */
  bottomVisibleMessageId: string;
  /**
   * The chat tip — the chronologically latest message present in
   * the chat at the moment the user left. Distinct from
   * `bottomVisibleMessageId` whenever the user scrolled up before
   * leaving (bottom-visible trails behind the tip).
   *
   * On return, anything strictly newer than this id is "new since
   * your last visit": counted by the pill and divided from prior
   * content by the "New Messages" divider. Anything ≤ this id was
   * already in the chat when the user left, even if they hadn't
   * scrolled to it — so it does not count as new.
   *
   * Optional only for backward compatibility with rows written
   * before this field existed.
   */
  latestKnownMessageId?: string;
  /** Wall-clock when the snapshot was taken. Used for diagnostics. */
  updatedAt: number;
};

// One connection per database name; see message-store.ts for why this is
// a map rather than a single cached promise.
const dbPromises = new Map<string, Promise<IDBDatabase | null>>();
let legacyDeleteRequested = false;

function dbNameForUser(userId: string): string {
  return `${LEGACY_DB_NAME}:u:${userId}`;
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  // Per-call identity resolution — anonymous sessions never touch disk;
  // an in-page account switch transparently lands on the right database.
  const userId = currentUserIdFromToken();
  if (userId === null) return Promise.resolve(null);
  const dbName = dbNameForUser(userId);
  const existing = dbPromises.get(dbName);
  if (existing) return existing;
  const promise = new Promise<IDBDatabase | null>((resolve) => {
    const req = indexedDB.open(dbName, DB_VERSION);
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
    req.onsuccess = () => {
      const db = req.result;
      // Let a purge or another tab's delete/upgrade proceed instead of
      // staying blocked on this connection.
      db.onversionchange = () => {
        db.close();
        dbPromises.delete(dbName);
      };
      if (!legacyDeleteRequested) {
        legacyDeleteRequested = true;
        try {
          // Idempotent with message-store's own legacy delete.
          indexedDB.deleteDatabase(LEGACY_DB_NAME);
        } catch {
          // Best-effort — the logout purge sweeps the legacy name too.
        }
      }
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  dbPromises.set(dbName, promise);
  return promise;
}

/**
 * Close this module's connections ahead of a purge's `deleteDatabase`.
 * message-store.ts holds a separate connection to the same database, so
 * the purge calls both modules' `closeDbForPurge`.
 */
export function closeDbForPurge(): void {
  for (const promise of dbPromises.values()) {
    void promise.then((db) => db?.close());
  }
  dbPromises.clear();
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
 * Upsert the snapshot for `chatId`. Captures both the visual
 * position (`bottomVisibleMessageId`) and the freshness marker
 * (`latestKnownMessageId`, the chat tip at the moment of this
 * snapshot).
 *
 * Fire-and-forget at call sites: the write is best-effort, must
 * never delay rendering, and silently no-ops if IndexedDB is
 * unavailable.
 */
export async function setReadState(
  chatId: string,
  bottomVisibleMessageId: string,
  latestKnownMessageId: string,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(READ_STATE_STORE, "readwrite");
    const store = tx.objectStore(READ_STATE_STORE);
    const entry: ReadState = {
      chatId,
      bottomVisibleMessageId,
      latestKnownMessageId,
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
