/**
 * Per-browser image cache keyed by imageId. Images sent from THIS browser
 * live here so we can render historical messages without refetching bytes
 * from the server — the server-side DB only stores a reference.
 *
 * Cross-device / incognito / a different browser → cache miss → the UI
 * falls back to a "not available on this device" placeholder. This is the
 * accepted trade-off of the image-out-of-messages design (bytes live on
 * the sender's device + on each online agent client, never on the server).
 */

const DB_NAME = "first-tree-hub-images";
const DB_VERSION = 1;
const STORE = "images";

type Stored = {
  imageId: string;
  base64: string;
  mimeType: string;
  createdAt: number;
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
        db.createObjectStore(STORE, { keyPath: "imageId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/**
 * Persist image bytes keyed by imageId. Rejects when IndexedDB is unavailable
 * (incognito, disabled) or the write itself fails (quota, aborted). Since
 * the server stores only a reference to these bytes, callers MUST treat a
 * rejection as a send-blocking error — posting the reference without a local
 * cache entry means the sender's own tab will immediately render the
 * "not available on this device" placeholder for the image it just sent.
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
