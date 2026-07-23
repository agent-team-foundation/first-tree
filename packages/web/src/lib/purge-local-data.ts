/**
 * Logout-time purge of persistent, user-content-bearing browser storage
 * (SEC-042).
 *
 * `logout()` clears tokens and the React Query cache, but IndexedDB and
 * `localStorage` outlive it — without this purge, a later account on the
 * same browser profile (or anyone with devtools access) could recover the
 * previous user's plaintext messages, image bytes, and unsent drafts.
 *
 * Covered stores:
 *  - IndexedDB `first-tree-chat-cache` / `messages`   (message-store)
 *  - IndexedDB `first-tree-chat-cache` / `read-state` (read-state-store)
 *  - IndexedDB `first-tree-images` / `images`         (image-store)
 *  - localStorage `first-tree:chat-drafts:v1`         (draft-store)
 *
 * Intentionally NOT covered:
 *  - `first-tree:selectedOrganizationId:<userId>` — a per-user org id
 *    (not content); kept so a returning sign-in lands back in the org the
 *    user left (see the comment inside `logout()` in auth-context).
 *  - Benign UI preferences (theme, panel sizes) — no user content.
 *
 * Object stores are cleared (`store.clear()`) rather than deleting whole
 * databases: the store modules hold cached open connections, and
 * `indexedDB.deleteDatabase` would block until every connection closes.
 */

import { clearAllImages } from "../api/image-store.js";
import { clearAllChatCaches } from "../api/message-store.js";
import { clearAllReadStates } from "../api/read-state-store.js";
import { clearAllDrafts } from "./draft-store.js";

/**
 * Best-effort removal of all locally persisted user content. Never throws
 * and never blocks logout on a slow/broken store — each underlying clear
 * already resolves silently on failure, and `allSettled` guards against
 * future clears that reject.
 */
export async function purgeLocalUserData(): Promise<void> {
  clearAllDrafts();
  await Promise.allSettled([clearAllChatCaches(), clearAllReadStates(), clearAllImages()]);
}
