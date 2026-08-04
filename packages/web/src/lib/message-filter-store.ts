/**
 * Local (browser-only) cache for the per-chat timeline message filter.
 *
 * Persists which participant's conversation the user chose to focus the
 * timeline on, so the choice survives chat switches and page reloads. The
 * filter is a viewer-local display preference — it never reaches the server
 * and does not sync across devices or browsers.
 *
 * All entries live under ONE `localStorage` key as a JSON map keyed by a
 * user-scoped chat scope (same shape as `draft-store.ts`): a single key keeps
 * clearing and the size cap one-object operations, and the per-user prefix
 * means a shared browser never restores another account's filter after a
 * logout/login on the same profile.
 */

const STORAGE_KEY = "first-tree:chat-message-filter:v1";

/** Cap on retained filters; oldest-by-`updatedAt` are pruned past this. */
const MAX_ENTRIES = 200;

type StoredFilter = {
  /** The counterpart agent whose conversation with the viewer stays visible. */
  agentId: string;
  updatedAt: number;
};

type FilterMap = Record<string, StoredFilter>;

function isStoredFilter(v: unknown): v is StoredFilter {
  if (typeof v !== "object" || v === null) return false;
  if (!("agentId" in v) || typeof v.agentId !== "string" || v.agentId.length === 0) return false;
  if (!("updatedAt" in v) || typeof v.updatedAt !== "number") return false;
  return true;
}

function readMap(): FilterMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: FilterMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (isStoredFilter(v)) out[k] = v;
    }
    return out;
  } catch {
    // Corrupt JSON or unavailable storage — start from empty rather than throw.
    return {};
  }
}

function writeMap(map: FilterMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable (private mode) or full; the filter is a
    // best-effort convenience, so a write failure is silently ignored.
  }
}

/** Keep only the newest `MAX_ENTRIES` filters by `updatedAt`. */
function prune(map: FilterMap): FilterMap {
  const entries = Object.entries(map);
  if (entries.length <= MAX_ENTRIES) return map;
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_ENTRIES));
}

/** Storage scope for the timeline filter: per user, per chat. */
export function messageFilterScope(userId: string | null, chatId: string): string {
  return `u:${userId ?? "anon"}:chat:${chatId}`;
}

/** Read the stored filter counterpart for `scope`, or `null` when none. */
export function loadMessageFilter(scope: string): string | null {
  return readMap()[scope]?.agentId ?? null;
}

/**
 * Persist (or clear) the filter for `scope`. `null` restores the default
 * all-messages view and removes the entry.
 */
export function saveMessageFilter(scope: string, agentId: string | null, now: number = Date.now()): void {
  const map = readMap();
  if (agentId === null) {
    if (scope in map) {
      delete map[scope];
      writeMap(map);
    }
    return;
  }
  map[scope] = { agentId, updatedAt: now };
  writeMap(prune(map));
}
