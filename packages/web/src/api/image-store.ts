/**
 * Per-browser image cache keyed by imageId, fronting the org attachment store.
 * Renders consult this cache first to avoid re-downloading bytes; on a miss
 * the UI fetches from `GET /attachments/:id` and warms this cache. The
 * authoritative bytes always live server-side, so a cache miss (cross-device,
 * incognito, cleared storage) is recoverable — not a "not available"
 * dead-end like the old IndexedDB-only design.
 */

import { getBrowserStorageRevision, scopedDatabaseName } from "../lib/browser-storage-scope.js";

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
let dbRevision = -1;

function openDb(): Promise<IDBDatabase | null> {
  const revision = getBrowserStorageRevision();
  if (dbPromise && dbRevision === revision) return dbPromise;
  dbRevision = revision;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const req = indexedDB.open(scopedDatabaseName(DB_NAME), DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "imageId" });
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
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
