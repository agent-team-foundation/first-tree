/**
 * Local (browser-only) cache for unsent composer drafts.
 *
 * Persists what a user has typed but not yet sent so it survives chat
 * switches and page reloads. Scope is per chat for the in-chat composer
 * (keyed by chatId) and one per-(org, seed-participants) scope for the
 * "new chat" composer (see `newChatDraftScope`). Storage is `localStorage`,
 * so drafts are intentionally local to one browser — they do not sync across
 * devices or browsers.
 *
 * All entries live under ONE `localStorage` key as a JSON map. A single key
 * keeps "clear on send" and the size cap one-object operations and avoids
 * scanning every key in the namespace.
 */

const STORAGE_KEY = "first-tree:chat-drafts:v1";

/** Cap on retained drafts; oldest-by-`updatedAt` are pruned past this. Drafts
 *  are small, but ones for chats the user abandoned should not grow
 *  `localStorage` without bound. */
const MAX_ENTRIES = 100;

/** A persisted draft. `participantIds` is only meaningful for the new-chat
 *  composer (the in-chat composer never sets it). */
type StoredDraft = {
  text: string;
  participantIds?: string[];
  updatedAt: number;
};

/** What callers read back: the typed body and (new-chat only) chosen chips. */
export type DraftSnapshot = {
  text: string;
  participantIds: string[];
};

type DraftMap = Record<string, StoredDraft>;

function isStoredDraft(v: unknown): v is StoredDraft {
  if (typeof v !== "object" || v === null) return false;
  if (!("text" in v) || typeof v.text !== "string") return false;
  if ("participantIds" in v && v.participantIds !== undefined && !Array.isArray(v.participantIds)) return false;
  if (!("updatedAt" in v) || typeof v.updatedAt !== "number") return false;
  return true;
}

function readMap(): DraftMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: DraftMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (isStoredDraft(v)) out[k] = v;
    }
    return out;
  } catch {
    // Corrupt JSON or unavailable storage — start from empty rather than throw.
    return {};
  }
}

function writeMap(map: DraftMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable (private mode) or full; drafts are a
    // best-effort convenience, so a write failure is silently ignored.
  }
}

/** Keep only the newest `MAX_ENTRIES` drafts by `updatedAt`. */
function prune(map: DraftMap): DraftMap {
  const entries = Object.entries(map);
  if (entries.length <= MAX_ENTRIES) return map;
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_ENTRIES));
}

/** Per-user prefix so a shared browser never restores another account's draft
 *  after a logout/login on the same profile — `logout()` clears tokens and
 *  query state, not this store. Mirrors the userId-bucketed selected-org
 *  storage in auth-context (`first-tree:selectedOrganizationId:<userId>`). */
function userPrefix(userId: string | null): string {
  return `u:${userId ?? "anon"}`;
}

/** Storage scope for the in-chat composer: per user, per chat. */
export function chatDraftScope(userId: string | null, chatId: string): string {
  return `${userPrefix(userId)}:chat:${chatId}`;
}

/** Storage scope for the "new chat" composer: per user, per (org, seed
 *  participants) — mirroring the center-panel remount key so each distinct
 *  compose context keeps its own draft. */
export function newChatDraftScope(
  userId: string | null,
  organizationId: string | null,
  withIds?: readonly string[],
): string {
  return `${userPrefix(userId)}:new:${organizationId ?? "no-org"}:${(withIds ?? []).join(",")}`;
}

/** Read the stored draft for `scope`, or `null` when none is stored. */
export function loadDraft(scope: string): DraftSnapshot | null {
  const entry = readMap()[scope];
  if (!entry) return null;
  return { text: entry.text, participantIds: entry.participantIds ?? [] };
}

/**
 * Persist (or clear) the draft for `scope`. A draft with no typed body is
 * treated as empty and removes the entry — participant chips are remembered
 * only alongside real text, never on their own (an auto-seeded default chip
 * must not masquerade as an unsent draft).
 */
export function saveDraft(
  scope: string,
  draft: { text: string; participantIds?: readonly string[] },
  now: number = Date.now(),
): void {
  const map = readMap();
  if (draft.text.trim().length === 0) {
    if (scope in map) {
      delete map[scope];
      writeMap(map);
    }
    return;
  }
  const participantIds =
    draft.participantIds && draft.participantIds.length > 0 ? [...draft.participantIds] : undefined;
  map[scope] = { text: draft.text, participantIds, updatedAt: now };
  writeMap(prune(map));
}

/**
 * Remove every stored draft for every user and scope. Called on logout:
 * drafts are plaintext user content, and logout is the "I'm done on this
 * browser" signal, so no unsent text may survive it on a shared profile
 * (SEC-042). All-user removal is intentional — the per-user scope prefix
 * only prevents cross-account *restore*, not devtools inspection of the
 * raw `localStorage` value.
 */
export function clearAllDrafts(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be unavailable (private mode); nothing was persisted
    // there in that case, so there is nothing to purge.
  }
}

/** Remove any stored draft for `scope` (used on successful send). */
export function clearDraft(scope: string): void {
  const map = readMap();
  if (scope in map) {
    delete map[scope];
    writeMap(map);
  }
}

/**
 * Decide where a failed send's unsent text belongs. A send started in chat
 * `sendChatId` can resolve AFTER the user switched to `currentChatId`; the
 * rejected text must never be restored into the current composer then — it
 * belongs to a different chat, and the in-chat draft state is shared across
 * chats. Returns `true` when the user has switched away — the caller must
 * leave the live composer untouched; the rejected text is parked in the
 * originating chat's own cache unless a newer draft already lives there.
 * Returns `false` when the user is still in the originating chat, so the
 * caller restores the text into the live composer as usual.
 */
export function parkFailedDraftIfSwitched(
  userId: string | null,
  sendChatId: string,
  currentChatId: string,
  text: string,
): boolean {
  if (currentChatId === sendChatId) return false;
  const scope = chatDraftScope(userId, sendChatId);
  // Park the rejected text in the originating chat, but never clobber a newer
  // draft the user has since typed there (mirrors the same-chat rollback's
  // "only restore into an empty composer" guard). saveDraft no-ops on empty.
  if (loadDraft(scope) === null) saveDraft(scope, { text });
  return true;
}
