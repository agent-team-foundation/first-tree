/**
 * Best-effort removal of a departing account's browser-local data, run when
 * that account's session ends: explicit logout, 401 auto-logout, or an
 * account switch that bypasses logout (`adoptTokens` / `login` with a
 * different subject). SEC-042: without this sweep, plaintext chat messages,
 * image bytes, and composer drafts persisted in IndexedDB / localStorage
 * survive logout and are readable by the next person on the browser.
 *
 * Contract: `purgeLocalUserData` NEVER rejects and resolves within
 * ~`PURGE_TIMEOUT_MS` even when IndexedDB deletes stay blocked — logout
 * must not hang on storage. Deletes already issued keep running in the
 * browser's IndexedDB backend after the time box resolves, and any residue
 * is unreachable through the app anyway thanks to per-account database
 * namespacing.
 */

import { closeDbForPurge as closeImageDb } from "../api/image-store.js";
import { closeDbForPurge as closeMessageDb } from "../api/message-store.js";
import { closeDbForPurge as closeReadStateDb } from "../api/read-state-store.js";
import { currentUserIdFromToken } from "./current-user-id.js";

/** Upper bound on how long the purge may keep `logout()` waiting. */
const PURGE_TIMEOUT_MS = 2000;

/** Prefix shared by every first-party IndexedDB database name — legacy and
 *  per-account (`…:u:<userId>`) names alike. */
const IDB_NAME_PREFIX = "first-tree-";

/** Pre-namespacing database names, swept unconditionally. Kept in sync with
 *  the LEGACY_DB_NAME constants in message-store / read-state-store /
 *  image-store. */
const LEGACY_DB_NAMES = ["first-tree-chat-cache", "first-tree-images"] as const;

/** The single localStorage key holding every composer draft (all accounts,
 *  entries prefixed `u:<userId|anon>` — see `draft-store.ts`). Deleted
 *  whole: residual entries of OTHER past accounts are the same exposure
 *  surface, so the sweep is deliberately not scoped to the departing user. */
const DRAFTS_KEY = "first-tree:chat-drafts:v1";

/** Low-sensitivity chat/agent metadata keys, removed by prefix scan.
 *  `first-tree:selectedOrganizationId:<userId>` (org UUID only, per-user
 *  key) and pure UI preference keys are intentionally retained — see the
 *  retention comment in auth-context's `logout`. */
const PURGED_KEY_PREFIXES = [
  "first-tree:new-chat-default-agent:",
  "first-tree:chat-summary-expanded:v1:",
  "first-tree:chat-summary-dismissed-version:v1:",
] as const;

/** Synchronous localStorage sweep. Runs BEFORE the async IndexedDB step so
 *  it can never be cut short by a navigation or the purge time box. */
function purgeLocalStorageSync(): void {
  try {
    localStorage.removeItem(DRAFTS_KEY);
  } catch {
    // Unavailable / denied storage — nothing to purge there, then.
  }
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null && PURGED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        doomed.push(key);
      }
    }
    for (const key of doomed) {
      localStorage.removeItem(key);
    }
  } catch {
    // Same: the sweep is best-effort by contract.
  }
}

/** Wrap one `deleteDatabase` call so it always resolves: `blocked` still
 *  completes once the last open connection closes (the stores'
 *  `versionchange` handlers close this tab's own), so treat it as issued
 *  rather than waiting on it. */
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Which databases to delete. Prefers `indexedDB.databases()` enumeration —
 * it also catches OTHER past accounts' namespaced databases — and falls
 * back to a deterministic list (legacy names + the departing account's own)
 * where the API is unavailable (e.g. Firefox < 126).
 *
 * Never returns the CURRENT account's databases: on explicit logout the
 * token is already cleared so nothing is excluded, while on an account
 * switch (`adoptTokens` / `login`) the new token is already stored and the
 * new account's warm caches must survive the departing account's purge.
 */
async function targetDatabaseNames(departingUserId: string | null): Promise<string[]> {
  let names: string[] | null = null;
  if (typeof indexedDB.databases === "function") {
    try {
      const all = await indexedDB.databases();
      names = all
        .map((info) => info.name)
        .filter((name): name is string => typeof name === "string" && name.startsWith(IDB_NAME_PREFIX));
    } catch {
      names = null;
    }
  }
  if (names === null) {
    names = [...LEGACY_DB_NAMES];
    if (departingUserId !== null) {
      for (const legacy of LEGACY_DB_NAMES) {
        names.push(`${legacy}:u:${departingUserId}`);
      }
    }
  }
  const currentUserId = currentUserIdFromToken();
  if (currentUserId === null) return names;
  const keepSuffix = `:u:${currentUserId}`;
  return names.filter((name) => !name.endsWith(keepSuffix));
}

/**
 * Purge the departing account's local data: composer drafts and swept
 * metadata keys (synchronously, first), then every first-party IndexedDB
 * database except the current account's. `departingUserId` seeds the
 * fallback delete list when database enumeration is unavailable; pass what
 * was snapshotted before the tokens were cleared.
 */
export async function purgeLocalUserData(departingUserId: string | null): Promise<void> {
  try {
    // Close this tab's own connections first so the deletes below are not
    // blocked by the very app issuing them. message-store and
    // read-state-store hold separate connections to one shared database —
    // both must close.
    closeMessageDb();
    closeReadStateDb();
    closeImageDb();
  } catch {
    // A close failure only risks a blocked delete, which the time box and
    // the `onblocked → resolve` wrapper below absorb.
  }

  purgeLocalStorageSync();

  try {
    if (typeof indexedDB === "undefined") return;
    const deletes = (async () => {
      const names = await targetDatabaseNames(departingUserId);
      await Promise.allSettled(names.map((name) => deleteDatabase(name)));
    })();
    await Promise.race([
      deletes,
      new Promise<void>((resolve) => {
        setTimeout(resolve, PURGE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Purge is strictly best-effort: logout must complete even when
    // storage APIs misbehave. Residual data stays unreachable through the
    // app because databases are namespaced per account.
  }
}
