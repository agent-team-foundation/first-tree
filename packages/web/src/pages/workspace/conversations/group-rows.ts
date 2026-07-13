import type { MeChatRow } from "@first-tree/shared";

export type GroupMode = "recency" | "source";

/** Default grouping when neither the URL nor the stored preference says otherwise. */
export const DEFAULT_GROUP_MODE: GroupMode = "recency";

const GROUP_MODE_STORAGE_KEY = "first-tree:chat-list-group";

/**
 * Parse a raw `?group=` URL (or storage) value into a `GroupMode`.
 * Returns `null` for unknown / missing values so the caller can fall
 * back to the remembered preference (`readStoredGroupMode`). Exported
 * so the URL-state side (`WorkspacePage`) and tests share one
 * canonical parser.
 */
export function parseGroupMode(raw: string | null): GroupMode | null {
  if (raw === "recency" || raw === "source") return raw;
  return null;
}

/**
 * Read the remembered `Group by` choice. The selection is a per-device
 * view preference, so it lives in `localStorage` (same pattern as the
 * doc-preview drawer width) rather than in server-side user settings.
 */
export function readStoredGroupMode(): GroupMode {
  try {
    return parseGroupMode(window.localStorage.getItem(GROUP_MODE_STORAGE_KEY)) ?? DEFAULT_GROUP_MODE;
  } catch {
    // localStorage may be unavailable (private mode, sandboxed iframe);
    // fall back to the default rather than breaking the rail.
    return DEFAULT_GROUP_MODE;
  }
}

/** Persist the `Group by` choice so the next visit restores it. */
export function storeGroupMode(mode: GroupMode): void {
  try {
    window.localStorage.setItem(GROUP_MODE_STORAGE_KEY, mode);
  } catch {
    // Best-effort persistence — losing the preference is acceptable.
  }
}

export type GroupBucket = {
  key: string;
  /** `null` = no header rendered (used only by the empty-list fallback). */
  label: string | null;
  rows: ReadonlyArray<MeChatRow>;
  defaultCollapsed: boolean;
};

/**
 * Partition rows into header-prefixed buckets per the user's chosen
 * `Group by` mode. Pure function — the caller is expected to memo with
 * the rows array as the input.
 *
 * Empty input returns a single label-less bucket so the render path stays
 * uniform while the empty state owns the visible copy.
 */
export function groupRows(
  rows: ReadonlyArray<MeChatRow>,
  mode: GroupMode,
  now: Date = new Date(),
): ReadonlyArray<GroupBucket> {
  if (rows.length === 0) {
    return [{ key: "all", label: null, rows, defaultCollapsed: false }];
  }
  if (mode === "recency") {
    return groupByRecency(rows, now);
  }
  return groupBySource(rows);
}

// ---------------------------------------------------------------------------
// Recency
// ---------------------------------------------------------------------------

const RECENCY_BUCKETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this-week", label: "Earlier this week" },
  { key: "older", label: "Older" },
] as const;

type RecencyBucketKey = (typeof RECENCY_BUCKETS)[number]["key"];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfWeekFor(d: Date): Date {
  // Monday-start. `getDay()` returns Sun=0..Sat=6 → distance back to Monday.
  const day = d.getDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const start = startOfDay(d);
  return new Date(start.getTime() - daysSinceMonday * 24 * 60 * 60_000);
}

function bucketForRecency(iso: string | null, now: Date): RecencyBucketKey {
  // Missing timestamp → sink to the bottom bucket. A chat without
  // last_message_at is most likely a brand-new empty room; it'd be
  // confusing to either drop it or place it ahead of dated rows.
  if (!iso) return "older";
  const d = new Date(iso);
  const today = startOfDay(now).getTime();
  const yesterday = today - 24 * 60 * 60_000;
  const week = startOfWeekFor(now).getTime();
  const t = d.getTime();
  if (t >= today) return "today";
  if (t >= yesterday) return "yesterday";
  if (t >= week) return "this-week";
  return "older";
}

/**
 * The row's "recent activity" instant — `activity_at` (GREATEST of last message,
 * a genuine description change, and creation), the same key the server orders
 * ordinary rows by. Falling back to `last_message_at` keeps an old server (or an
 * unparsed row) without `activity_at` from sinking every chat to the bottom.
 * Using it for BOTH the recency bucket and the displayed time keeps the client
 * grouping/label consistent with the server order — otherwise a chat whose
 * description changed today (new activity, old last message) would sort to the
 * top server-side yet land under a collapsed "Older" bucket here.
 */
export function rowActivityInstant(r: MeChatRow): string | null {
  return r.activityAt ?? r.lastMessageAt;
}

function groupByRecency(rows: ReadonlyArray<MeChatRow>, now: Date): ReadonlyArray<GroupBucket> {
  const map = new Map<RecencyBucketKey, MeChatRow[]>();
  for (const r of rows) {
    const key = bucketForRecency(rowActivityInstant(r), now);
    const list = map.get(key);
    if (list) list.push(r);
    else map.set(key, [r]);
  }
  const buckets: GroupBucket[] = [];
  for (const b of RECENCY_BUCKETS) {
    const list = map.get(b.key);
    if (!list || list.length === 0) continue;
    buckets.push({
      key: b.key,
      label: b.label,
      rows: list,
      // Older buckets default to collapsed so the rail's vertical weight
      // stays fixed regardless of total chat count.
      defaultCollapsed: b.key === "this-week" || b.key === "older",
    });
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

// Labels are phrased around "who started this work stream" — the user's
// mental model for this grouping — rather than the creation mechanism
// (the old MINE/MANUAL/GITHUB/AGENT set read as two mixed dimensions).
// Header rendering uppercases via CSS, so labels stay normal case here.
const SOURCE_BUCKETS: ReadonlyArray<{ key: string; label: string; match: (row: MeChatRow) => boolean }> = [
  {
    key: "created-by-me",
    label: "Started by me",
    match: (row) => row.createdByMe === true && (row.source ?? "manual") === "manual",
  },
  {
    key: "manual",
    label: "Started by teammates",
    match: (row) => row.createdByMe !== true && (row.source ?? "manual") === "manual",
  },
  { key: "agent", label: "Started by agents", match: (row) => row.source === "agent" },
  { key: "github", label: "From GitHub", match: (row) => row.source === "github" },
];

function groupBySource(rows: ReadonlyArray<MeChatRow>): ReadonlyArray<GroupBucket> {
  const map = new Map<string, MeChatRow[]>();
  for (const r of rows) {
    const bucket = SOURCE_BUCKETS.find((b) => b.match(r));
    // Same defence as `SourceIcon`: if `r.source` is missing or unfamiliar
    // because an older/newer server build is out of step, treat the row as
    // Manual so it still gets a bucket instead of vanishing.
    const key = bucket?.key ?? "manual";
    const list = map.get(key);
    if (list) list.push(r);
    else map.set(key, [r]);
  }
  const buckets: GroupBucket[] = [];
  for (const b of SOURCE_BUCKETS) {
    const list = map.get(b.key);
    if (!list || list.length === 0) continue;
    buckets.push({ key: b.key, label: b.label, rows: list, defaultCollapsed: false });
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// attention pinning (failed + request)
// ---------------------------------------------------------------------------
//
// Chat-granularity predicate — see docs/development/needs-attention-scoping.20260526.md.
// A chat enters the "Needs attention" bucket when ANY of:
//
//   R1. `failedAgentIds.length > 0`
//       — A non-human agent I MANAGE is `failed` in this chat. Server
//         narrows `failedAgentIds` to `agents.manager_id = caller` so a
//         peer's broken agent never pins my row. A broken agent is stuck
//         until I intervene, so recovery is a legitimate attention signal
//         and it still pins.
//
//   R2. `openRequestCount > 0`
//       — An agent raised a structured question (`format=request`) at me
//         that I have not answered yet. The counter is ANSWER-cleared, not
//         read-cleared (`chat_user_state.open_request_count` only decrements
//         on my clean web-UI answer — an agent cannot resolve), so merely
//         opening the chat does NOT drop the row out of the attention
//         bucket — the asking agent is still blocked on me until I actually
//         answer the question.
//
// Deliberately NOT a pinning rule — a plain unread mention / red dot. An
// `@<me>` mention bumps `unreadMentionCount` (and still renders the red
// dot) but no longer hoists the chat to the top. The chat list is kept as
// stable as possible: only an explicit ask (R2) or a broken agent needing
// recovery (R1) reorders it. A red dot is awareness, not a demand for
// judgment, so it must not churn the ordering. (`chatHasExplicitMentionToMe`
// stays on the row as a precise signal for the red dot / a future
// explicit-@me affordance, but no longer feeds pinning.)
//
// Sort priority: `failed > request`. Both demand action; `failed` outranks
// because a stuck agent needs recovery before its chat can make progress
// at all.
//
// This ladder is INTENTIONALLY separate from the shared agent-status
// `compareMainStatus` (`failed`, `working`, ...) — overloading the shared
// comparator would couple two ladders that should evolve independently.

const ATTENTION_PRIORITY = ["failed", "request"] as const;
type AttentionReason = (typeof ATTENTION_PRIORITY)[number];

/**
 * Highest-priority attention reason for this row, or `null` when the row is
 * NOT in the attention bucket. Order matters: a row that satisfies multiple
 * rules sorts under its highest tier (e.g. failed + request → failed).
 */
export function rowAttentionReason(r: MeChatRow): AttentionReason | null {
  if (r.failedAgentIds.length > 0) return "failed";
  // `> 0` is skew-safe without an explicit guard: an older server build
  // that predates `openRequestCount` yields `undefined`, and
  // `undefined > 0` is `false` — the rule degrades to "off" (safe
  // direction). A plain unread mention is intentionally not a reason here:
  // the red dot must not pin (see the rules block above).
  if (r.openRequestCount > 0) return "request";
  return null;
}

/**
 * The row's "failed" indicator (red `!` / left border). Lights ONLY for
 * caller-managed failed agents — server already narrows `failedAgentIds`.
 * Equivalent to "this row is in the failed tier of the attention bucket".
 */
export function rowIsFailed(r: MeChatRow): boolean {
  return r.failedAgentIds.length > 0;
}
