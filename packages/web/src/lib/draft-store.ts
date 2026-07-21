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
    // Upgrade pre-SEC-042 `u:<userId>:` scopes to the origin-aware format in
    // place. Idempotent — after the rewrite nothing matches the legacy shape.
    const { map: migratedMap, migrated } = migrateLegacyScopes(out);
    if (migrated) writeMap(migratedMap);
    return migratedMap;
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

/**
 * Server identity for draft scoping — the web app is same-origin with its API,
 * so `window.location.origin` distinguishes drafts written against different
 * deployments in the same browser profile. Computed locally (rather than
 * imported from `api/storage-scope.ts`) to keep this module dependency-free:
 * storage-scope imports THIS module, never the reverse.
 */
function currentOrigin(): string {
  if (typeof window === "undefined" || !window.location?.origin) return "unknown-origin";
  return window.location.origin;
}

/**
 * Per-user, per-server prefix so a shared browser never restores another
 * account's — or another deployment's — draft after a logout/login on the
 * same profile. Mirrors the userId-bucketed selected-org storage in
 * auth-context (`first-tree:selectedOrganizationId:<userId>`).
 *
 * Scope format history: pre-SEC-042 scopes were `u:<userId>:...` (no server
 * dimension). Current scopes are `u:<userId>@<origin>:...`; legacy entries
 * are migrated forward on read (drafts are user data, so they are rewritten
 * rather than dropped) and both formats are removed by `clearDraftsForUser`.
 */
function userPrefix(userId: string | null): string {
  return `u:${userId ?? "anon"}@${currentOrigin()}`;
}

/**
 * Split a map key into its legacy-vs-current shape. Current keys are
 * `u:<userId>@<origin>:<rest>`; legacy keys are `u:<userId>:<rest>`. The `@`
 * before the first `:` is the discriminator — origins always contain a `:`
 * (`https://…`), so a key whose first `:` comes before any `@` is legacy.
 * Returns null for keys not in the `u:` family (defensive; none exist today).
 */
function parseUserScopedKey(key: string): { userId: string; rest: string; legacy: boolean } | null {
  if (!key.startsWith("u:")) return null;
  const body = key.slice(2);
  const at = body.indexOf("@");
  const colon = body.indexOf(":");
  if (colon === -1) return null;
  const legacy = at === -1 || colon < at;
  if (legacy) return { userId: body.slice(0, colon), rest: body.slice(colon + 1), legacy: true };
  // Current format: the scope body starts at the first `:` AFTER the origin
  // (the origin's own `https://` colons come before it).
  const scopeColon = body.indexOf(":", at);
  if (scopeColon === -1) return null;
  return { userId: body.slice(0, at), rest: body.slice(scopeColon + 1), legacy: false };
}

/** Rewrite a legacy `u:<userId>:` map to current `u:<userId>@<origin>:` keys. */
function migrateLegacyScopes(map: DraftMap): { map: DraftMap; migrated: boolean } {
  let migrated = false;
  const out: DraftMap = {};
  for (const [key, value] of Object.entries(map)) {
    const parsed = parseUserScopedKey(key);
    if (parsed?.legacy) {
      const nextKey = `u:${parsed.userId}@${currentOrigin()}:${parsed.rest}`;
      // A current-format entry for the same scope wins — it was written by
      // newer code and is at least as fresh.
      if (!(nextKey in map) && !(nextKey in out)) out[nextKey] = value;
      migrated = true;
    } else {
      out[key] = value;
    }
  }
  return { map: migrated ? out : map, migrated };
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

/** Remove any stored draft for `scope` (used on successful send). */
export function clearDraft(scope: string): void {
  const map = readMap();
  if (scope in map) {
    delete map[scope];
    writeMap(map);
  }
}

/**
 * Remove every draft belonging to `userId` — both the current
 * `u:<userId>@<origin>:` scopes and any not-yet-migrated legacy
 * `u:<userId>:` ones. Called by the logout purge (SEC-042 /
 * `api/storage-scope.ts`); other users' drafts are untouched.
 *
 * Scans the raw stored object rather than the validated map so malformed
 * entries (which `readMap` would skip) are purged too — this is a security
 * path, and skipped entries could still hold the account's plaintext.
 */
export function clearDraftsForUser(userId: string): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return;
    const map = parsed as Record<string, unknown>;
    let changed = false;
    for (const key of Object.keys(map)) {
      if (key.startsWith(`u:${userId}:`) || key.startsWith(`u:${userId}@`)) {
        delete map[key];
        changed = true;
      }
    }
    if (changed) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Unavailable storage or corrupt JSON — best-effort purge, never throws.
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
