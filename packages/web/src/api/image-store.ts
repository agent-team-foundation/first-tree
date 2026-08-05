/**
 * Per-browser image cache keyed by imageId, fronting the org attachment store.
 * Renders consult this cache first to avoid re-downloading bytes; on a miss
 * the UI fetches from `GET /attachments/:id` and warms this cache. The
 * authoritative bytes always live server-side, so a cache miss (cross-device,
 * incognito, cleared storage) is recoverable — not a "not available"
 * dead-end like the old IndexedDB-only design.
 * The database lives under the storage-scope namespace
 * (`first-tree-images@<origin>#<userId>`) so accounts sharing a browser
 * profile never see each other's cached images, and logout purges it — see
 * `api/storage-scope.ts` (SEC-042 / issue 1647).
 */

import { activeScopedDbName, isActiveScopedDbName, registerDatabaseCloseHook } from "./storage-scope.js";

const DB_NAME = "first-tree-images";
const DB_VERSION = 1;
const STORE = "images";

type Stored = {
  imageId: string;
  base64: string;
  mimeType: string;
  createdAt: number;
};

let dbPromise: Promise<IDBDatabase | null> | null = null;
let dbConnection: IDBDatabase | null = null;

/**
 * Close the cached connection and forget it. Registered with storage-scope:
 * runs on namespace switch and on logout purge so a stale handle neither
 * serves reads for the wrong account nor blocks `deleteDatabase`.
 */
function resetCachedDb(): void {
  dbConnection?.close();
  dbConnection = null;
  dbPromise = null;
}

registerDatabaseCloseHook(resetCachedDb);

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  // null when the current namespace was purged by logout — callers degrade
  // exactly like the IndexedDB-unavailable path (reads null, writes reject),
  // and nothing is cached so a later sign-in re-checks fresh.
  const name = activeScopedDbName(DB_NAME);
  if (!name) return Promise.resolve(null);
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "imageId" });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // The namespace can switch (or be purged) while this open is in flight;
      // never hand out a connection to the previous account's database.
      if (!isActiveScopedDbName(DB_NAME, name)) {
        db.close();
        resolve(null);
        return;
      }
      dbConnection = db;
      // Multi-tab: when another tab deletes (or upgrades) this database, close
      // so its `deleteDatabase` is not blocked — AND drop the cached promise,
      // otherwise a later `db.transaction()` on the closed connection throws
      // InvalidStateError synchronously, breaking the read contract. The next
      // operation re-opens via `openDb` (or is dropped when the namespace was
      // purged).
      db.onversionchange = () => resetCachedDb();
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/**
 * Persist image bytes keyed by imageId. Rejects when IndexedDB is unavailable
 * (incognito, disabled) or the write itself fails (quota, aborted). This is a
 * best-effort cache warm: the bytes also live in the server attachment store,
 * so a rejection is non-fatal — callers should swallow it and let the render
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
    const tx = db.transaction(STORE, "readonly");
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
