/**
 * Identity scope for browser-local application data.
 *
 * Sensitive caches must never be addressable by a chat or image id alone:
 * those ids are server data and can collide across accounts or deployments.
 * The scope is updated by AuthProvider as the authenticated member changes.
 */

let userId: string | null = null;
let revision = 0;
const KNOWN_DATABASES_KEY = "first-tree:browser-databases:v1";

function serverOrigin(): string {
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  if (typeof globalThis.location !== "undefined" && globalThis.location?.origin) return globalThis.location.origin;
  return "unknown-origin";
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_");
}

export function setBrowserStorageUser(user: string | null): void {
  if (userId !== user) revision += 1;
  userId = user;
}

export function getBrowserStorageRevision(): number {
  return revision;
}

export function getBrowserStorageScope(): string {
  return `${encode(serverOrigin())}:${encode(userId ?? "anonymous")}`;
}

export function scopedStorageKey(base: string): string {
  return `${base}:${getBrowserStorageScope()}`;
}

export function scopedDatabaseName(base: string): string {
  const name = `${base}:${getBrowserStorageScope()}`;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KNOWN_DATABASES_KEY) : null;
    const names = raw ? (JSON.parse(raw) as unknown) : [];
    const known = Array.isArray(names) ? names.filter((value): value is string => typeof value === "string") : [];
    if (!known.includes(name) && typeof localStorage !== "undefined") {
      localStorage.setItem(KNOWN_DATABASES_KEY, JSON.stringify([...known, name]));
    }
  } catch {
    // The registry is only a compatibility fallback for browsers without
    // indexedDB.databases(); a storage failure must not block cache access.
  }
  return name;
}

/**
 * Remove all browser-local data owned by the web app. This is deliberately
 * best-effort: logout must complete even when storage is unavailable or a
 * browser does not expose the IndexedDB enumeration API.
 */
export async function clearPersistentBrowserStorage(): Promise<void> {
  const names = new Set<string>();
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KNOWN_DATABASES_KEY) : null;
    const known = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(known)) {
      for (const name of known) {
        if (typeof name === "string" && name.startsWith("first-tree-")) names.add(name);
      }
    }
  } catch {
    // Fall through to the known database names below.
  }
  try {
    if (typeof localStorage !== "undefined") localStorage.clear();
  } catch {
    // Storage can be denied in private mode or by browser policy.
  }
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.clear();
  } catch {
    // Storage can be denied in private mode or by browser policy.
  }

  if (typeof indexedDB === "undefined") return;
  try {
    const databases = indexedDB.databases;
    if (typeof databases === "function") {
      for (const database of await databases.call(indexedDB)) {
        if (database.name?.startsWith("first-tree-")) names.add(database.name);
      }
    }
  } catch {
    // Fall through to the known database names below.
  }
  // Older browsers do not expose indexedDB.databases(). These deletes are
  // harmless when the database does not exist and cover the shipped bases.
  names.add("first-tree-chat-cache");
  names.add("first-tree-images");
  await Promise.all(
    [...names].map(
      (name) =>
        new Promise<void>((resolve) => {
          try {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = request.onerror = request.onblocked = () => resolve();
          } catch {
            resolve();
          }
        }),
    ),
  );
}
