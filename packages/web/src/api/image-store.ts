/**
 * Per-browser image cache keyed by imageId, fronting the org attachment store.
 * Renders consult this cache first to avoid re-downloading bytes; on a miss
 * the UI fetches from `GET /attachments/:id` and warms this cache. The
 * authoritative bytes always live server-side, so a cache miss (cross-device,
 * incognito, cleared storage) is recoverable — not a "not available"
 * dead-end like the old IndexedDB-only design.
 */

import { currentUserIdFromToken } from "../lib/current-user-id.js";

// Pre-namespacing database name (SEC-042). Databases are now named per
// account (`first-tree-images:u:<userId>`) so another account on the same
// browser profile cannot open this one's cached image bytes. The legacy
// database is deleted — not migrated — on first namespaced open; see
// message-store.ts for the rationale.
const LEGACY_DB_NAME = "first-tree-images";
const DB_VERSION = 1;
const STORE = "images";

type Stored = {
  imageId: string;
  base64: string;
  mimeType: string;
  createdAt: number;
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
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "imageId" });
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
 * Close this module's connections ahead of a purge's `deleteDatabase` so
 * the delete is not blocked by this tab's own handle.
 */
export function closeDbForPurge(): void {
  for (const promise of dbPromises.values()) {
    void promise.then((db) => db?.close());
  }
  dbPromises.clear();
}

/**
 * Persist image bytes keyed by imageId. Rejects when IndexedDB is unavailable
 * (incognito, disabled, or no signed-in account to namespace the database
 * under) or the write itself fails (quota, aborted). This is a best-effort
 * cache warm: the bytes also live in the server attachment store, so a
 * rejection is non-fatal — callers should swallow it and let the render
 * path re-fetch from the server on the next view.
 */
export async function putImage(params: { imageId: string; base64: string; mimeType: string }): Promise<void> {
  const db = await openDb();
  if (!db) {
    throw new Error("Image storage unavailable (IndexedDB disabled or blocked)");
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const entry: Stored = {
      imageId: params.imageId,
      base64: params.base64,
      mimeType: params.mimeType,
      createdAt: Date.now(),
    };
    store.put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Image storage write failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Image storage write aborted"));
  });
}

export async function getImage(imageId: string): Promise<{ base64: string; mimeType: string } | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readonly");
    } catch {
      // The logout purge (or a versionchange from another context) closed
      // this connection between `openDb()` and here, which makes
      // `transaction()` throw synchronously. The cache is being torn down —
      // report a miss and let the render path re-fetch from the server.
      // `putImage` deliberately has no such guard: rejecting is already part
      // of its contract, and callers swallow the rejection.
      resolve(null);
      return;
    }
    const store = tx.objectStore(STORE);
    const req = store.get(imageId);
    req.onsuccess = () => {
      const row = req.result as Stored | undefined;
      if (!row) {
        resolve(null);
        return;
      }
      resolve({ base64: row.base64, mimeType: row.mimeType });
    };
    req.onerror = () => resolve(null);
  });
}
