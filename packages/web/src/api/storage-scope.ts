/**
 * Account+server namespacing and logout purge for per-browser session data
 * (SEC-042 / issue 1647).
 *
 * Every persistent client-side store that can hold chat content is scoped to a
 * namespace of `<origin>#<userId>` so a shared browser profile can never leak
 * one account's data into another account's view — not even into another
 * deployment served from a different origin. The namespace is module-level
 * state (mirroring `setApiSelectedOrganizationId` in `api/client.ts`), set by
 * the auth context, so read/write call sites keep their existing signatures:
 *
 *  - `setStorageNamespace(user.id)` runs inside `fetchMe` before `meLoaded`
 *    flips, so no store write can land in the wrong namespace.
 *  - `setStorageNamespace(null)` runs on logout; the anonymous namespace has
 *    no legitimate writer and is purged + write-blocked by every logout.
 *
 * Invariant: once `/me` has resolved, the namespace set from `user.id` equals
 * the one derivable from the access token's `sub` claim (org keying already
 * relies on this equivalence) — the token is only a purge fallback for
 * sessions where `/me` never succeeded.
 *
 * Logout purge contract (`purgeAccountLocalData`):
 *  1. Synchronously mark the target namespaces purged, so in-flight or later
 *     writes re-open no deleted database — store `openDb` entry points check
 *     the purged set and resolve `null`, which the stores' existing
 *     degradation contracts already cover (reads return empty, writes no-op).
 *  2. Run the registered close hooks so this tab's cached connections do not
 *     block `deleteDatabase` (other tabs close via their `onversionchange`
 *     handlers; multi-tab converges eventually).
 *  3. Asynchronously delete the namespaced IndexedDBs, clear the account's
 *     drafts (both legacy and current scope formats), and drop the legacy
 *     pre-namespacing global DBs. Never rejects — purge is fire-and-forget.
 */

import { clearDraftsForUser } from "../lib/draft-store.js";

/** Base names of the scoped IndexedDBs, before the `@<namespace>` suffix. */
const CHAT_CACHE_DB_BASE = "first-tree-chat-cache";
const IMAGES_DB_BASE = "first-tree-images";
const SCOPED_DB_BASES = [CHAT_CACHE_DB_BASE, IMAGES_DB_BASE] as const;

/**
 * Pre-namespacing builds stored the same caches under these global names.
 * Their content is unrecoverable-by-account (no user dimension), cache-only
 * (the server re-hydrates), and readable by any later account on the profile —
 * so the safe disposition is deletion on startup and on every logout.
 */
const LEGACY_UNSCOPED_DBS = [...SCOPED_DB_BASES];

/**
 * Server identity for scoping. The web app is same-origin with its API
 * (`BASE_URL = "/api/v1"`), so `window.location.origin` IS the server
 * identity. SSR / non-DOM test environments fall back to a fixed placeholder.
 */
function currentOrigin(): string {
  if (typeof window === "undefined" || !window.location?.origin) return "unknown-origin";
  return window.location.origin;
}

/** Namespace for an account on this server, e.g. `https://app.example#user-1`. */
export function namespaceForUser(userId: string | null): string {
  return `${currentOrigin()}#${userId ?? "anon"}`;
}

/** IndexedDB name for `base` under `namespace`, e.g. `first-tree-images@https://app.example#user-1`. */
export function scopedDbName(base: string, namespace: string): string {
  return `${base}@${namespace}`;
}

let currentUserId: string | null = null;
let currentNamespace = namespaceForUser(null);

/**
 * Namespaces whose session data has been purged by a logout. Stores refuse to
 * open a database under a purged namespace, which cuts the "purge completes,
 * then an in-flight `cacheMessages`/`putImage` re-opens and rebuilds the DB"
 * path. A namespace leaves the set only via `setStorageNamespace(userId)` —
 * an explicit sign-in of that account re-enables caching. The anonymous
 * namespace never leaves: anonymous state has no legitimate persistent writer.
 */
const purgedNamespaces = new Set<string>();

/**
 * Close hooks registered by the IndexedDB store modules (message-store,
 * read-state-store, image-store). Registration (rather than direct imports)
 * keeps the dependency direction one-way: stores import storage-scope, never
 * the reverse. A hook must close the module's cached connection and drop its
 * cached open promise so the next `openDb` re-derives name + purged state.
 */
const databaseCloseHooks = new Set<() => void>();

export function registerDatabaseCloseHook(hook: () => void): void {
  databaseCloseHooks.add(hook);
}

function runCloseHooks(): void {
  for (const hook of databaseCloseHooks) {
    try {
      hook();
    } catch {
      // A misbehaving hook must not block the namespace switch or purge.
    }
  }
}

/** The namespace every store read/write currently lands in. */
export function currentStorageNamespace(): string {
  return currentNamespace;
}

/**
 * Switch the active namespace. Closes every registered cached connection so
 * the stores re-open under the new namespace on their next operation, and —
 * when signing in as a real account — lifts that account's write block.
 */
export function setStorageNamespace(userId: string | null): void {
  const next = namespaceForUser(userId);
  if (userId !== null) purgedNamespaces.delete(next);
  if (next === currentNamespace) {
    currentUserId = userId;
    return;
  }
  currentNamespace = next;
  currentUserId = userId;
  runCloseHooks();
}

/**
 * The IndexedDB name stores should open for `base` right now, or `null` when
 * the current namespace has been purged (post-logout) — callers treat `null`
 * like IndexedDB being unavailable, which their existing fallback paths cover.
 */
export function activeScopedDbName(base: string): string | null {
  if (purgedNamespaces.has(currentNamespace)) return null;
  return scopedDbName(base, currentNamespace);
}

/** `true` when `name` is the database the stores would open right now. */
export function isActiveScopedDbName(base: string, name: string): boolean {
  return activeScopedDbName(base) === name;
}

/** Best-effort `indexedDB.deleteDatabase` — resolves on every outcome, never rejects. */
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve();
      return;
    }
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      // A blocked delete (a connection elsewhere never closes) must not wedge
      // the fire-and-forget purge; namespace isolation still bounds any residue
      // to the account that produced it.
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Delete the legacy global (`first-tree-chat-cache`, `first-tree-images`)
 * databases left behind by pre-namespacing builds. Runs once on AuthProvider
 * mount and again on every logout. Never rejects.
 */
export async function purgeLegacyUnscopedStores(): Promise<void> {
  try {
    for (const base of LEGACY_UNSCOPED_DBS) {
      await deleteDatabase(base);
    }
  } catch {
    // Best-effort cleanup; never surfaces.
  }
}

/**
 * Drop every per-browser trace of an account's session data. Targets the
 * current namespace (set by `fetchMe` from `user.id` — the authoritative
 * source) plus the anonymous namespace, and additionally the namespace derived
 * from `fallbackUserId` (the token's `sub`, captured by logout before tokens
 * are cleared) when it differs — e.g. a session where `/me` never resolved but
 * a previous session's data still sits under that account's namespace.
 *
 * Marks every target purged synchronously (before the first `await`), then
 * deletes asynchronously. Never rejects.
 */
export async function purgeAccountLocalData(fallbackUserId?: string | null): Promise<void> {
  const targetNamespaces = new Set<string>([currentNamespace, namespaceForUser(null)]);
  if (fallbackUserId) targetNamespaces.add(namespaceForUser(fallbackUserId));
  for (const ns of targetNamespaces) purgedNamespaces.add(ns);

  const draftUserIds = new Set<string>();
  if (currentUserId) draftUserIds.add(currentUserId);
  if (fallbackUserId) draftUserIds.add(fallbackUserId);

  try {
    runCloseHooks();
    const deletions: Promise<void>[] = [];
    for (const ns of targetNamespaces) {
      for (const base of SCOPED_DB_BASES) {
        deletions.push(deleteDatabase(scopedDbName(base, ns)));
      }
    }
    for (const userId of draftUserIds) {
      clearDraftsForUser(userId);
    }
    deletions.push(purgeLegacyUnscopedStores());
    await Promise.all(deletions);
  } catch {
    // Purge is best-effort and fire-and-forget; it must never reject.
  }
}
