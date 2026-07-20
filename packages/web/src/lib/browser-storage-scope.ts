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

export type BrowserStorageScope = {
  key: string;
  revision: number;
  userId: string | null;
};

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

export function captureBrowserStorageScope(): BrowserStorageScope {
  return { key: getBrowserStorageScope(), revision, userId };
}

export function isBrowserStorageScopeCurrent(scope: BrowserStorageScope): boolean {
  return scope.revision === revision && scope.key === getBrowserStorageScope();
}

export function scopedStorageKey(base: string, scope: BrowserStorageScope = captureBrowserStorageScope()): string {
  return `${base}:${scope.key}`;
}

export function scopedDatabaseName(base: string, scope: BrowserStorageScope = captureBrowserStorageScope()): string {
  const name = `${base}:${scope.key}`;
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
export async function clearPersistentBrowserStorage(scope: BrowserStorageScope): Promise<void> {
  const names = new Set<string>();
  const deletedNames = new Set<string>();
  const scopedSuffix = `:${scope.key}`;
  const legacyDatabaseNames = new Set(["first-tree-chat-cache", "first-tree-images"]);
  const registryNames: string[] = [];
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KNOWN_DATABASES_KEY) : null;
    const known = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(known)) {
      for (const name of known) {
        if (typeof name !== "string") continue;
        registryNames.push(name);
        if (name.endsWith(scopedSuffix) || legacyDatabaseNames.has(name)) names.add(name);
      }
    }
  } catch {
    // Fall through to the known database names below.
  }
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(scopedStorageKey("first-tree:chat-drafts:v1", scope));
      // This legacy key was shared by all accounts and therefore cannot be
      // safely attributed; remove it as an explicitly named legacy store.
      localStorage.removeItem("first-tree:chat-drafts:v1");
      if (scope.userId) localStorage.removeItem(`first-tree:selectedOrganizationId:${scope.userId}`);
    }
  } catch {
    // Storage can be denied in private mode or by browser policy.
  }

  if (typeof indexedDB === "undefined") return;
  try {
    const databases = indexedDB.databases;
    if (typeof databases === "function") {
      for (const database of await databases.call(indexedDB)) {
        if (database.name && (database.name.endsWith(scopedSuffix) || legacyDatabaseNames.has(database.name))) {
          names.add(database.name);
        }
      }
    }
  } catch {
    // Fall through to the known database names below.
  }
  // Older browsers do not expose indexedDB.databases(). These deletes cover
  // only the departing scope and explicitly named legacy databases.
  for (const name of legacyDatabaseNames) names.add(name);
  await Promise.all(
    [...names].map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          try {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => {
              deletedNames.add(name);
              resolve();
            };
            request.onerror = () => reject(request.error ?? new Error(`Failed to delete IndexedDB database ${name}`));
            // A blocked request is still pending. Open connections receive
            // `versionchange` and close; only onsuccess proves deletion.
            request.onblocked = () => undefined;
          } catch {
            reject(new Error(`Failed to delete IndexedDB database ${name}`));
          }
        }),
    ),
  );
  try {
    if (typeof localStorage !== "undefined") {
      const remaining = registryNames.filter((name) => !deletedNames.has(name));
      localStorage.setItem(KNOWN_DATABASES_KEY, JSON.stringify(remaining));
    }
  } catch {
    // Registry maintenance is best-effort after the data deletion succeeds.
  }
}
