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

function groupByRecency(rows: ReadonlyArray<MeChatRow>, now: Date): ReadonlyArray<GroupBucket> {
  const map = new Map<RecencyBucketKey, MeChatRow[]>();
  for (const r of rows) {
    const key = bucketForRecency(r.lastMessageAt, now);
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
  { key: "github", label: "From GitHub", match: (row) => row.source === "github" },
  { key: "agent", label: "Started by agents", match: (row) => row.source === "agent" },
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
// attention pinning (failed + request + mention)
// ---------------------------------------------------------------------------
//
// Chat-granularity predicate — see docs/development/needs-attention-scoping.20260526.md.
// A chat enters the "Needs attention" bucket when ANY of:
//
//   R1. `failedAgentIds.length > 0`
//       — A non-human agent I MANAGE is `failed` in this chat. Server
//         narrows `failedAgentIds` to `agents.manager_id = caller` so a
//         peer's broken agent never pins my row.
//
//   R2. `openRequestCount > 0`
//       — An agent raised a structured question (`format=request`) at me
//         that I have not answered/closed yet. The counter is
//         ANSWER-cleared, not read-cleared (`chat_user_state.
//         open_request_count` only decrements on `--answer` / `--close`
//         or a clean web-UI answer), so merely opening the chat does NOT
//         drop the row out of the attention bucket — the asking agent is
//         still blocked on me until I actually resolve the question.
//
//   R3. `unreadMentionCount > 0 && chatHasExplicitMentionToMe === true`
//       — I have unread, and at least one unread message explicitly
//         `@<me>`-mentions me (server checks `messages.metadata.mentions`
//         in the unread window). Distinguishes explicit `@<me>` from the
//         v1 1-on-1 implicit DM auto-mention (`services/message.ts:282
//         dmAutoProjection`), which still bumps `unreadMentionCount` for
//         the red dot but never writes the recipient into
//         `metadata.mentions` — so an agent's plain `"ack"` to me in a DM
//         correctly stays out of attention. Read-cleared — which is why
//         an open request needs its own rule (R2) instead of riding on
//         this one.
//
// Sort priority: `failed > request > mention`. An open question outranks a
// plain mention because the asker is explicitly blocked waiting on the
// caller; both yield to `failed` (broken agent needs recovery first).
//
// This ladder is INTENTIONALLY separate from the shared agent-status
// `compareMainStatus` (`failed`, `working`, ...). `mention` is a chat-level
// signal, not an agent main status — overloading the shared comparator would
// couple two ladders that should evolve independently.
//
// `=== true` checks (not truthy) on booleans: the web client does NOT run
// rows through `meChatRowSchema.parse`, so the Zod `.default(false)` only
// applies server-side; an older server returning `undefined` would
// silently degrade the rule to "off" under strict equality (safer
// direction).

const ATTENTION_PRIORITY = ["failed", "request", "mention"] as const;
type AttentionReason = (typeof ATTENTION_PRIORITY)[number];

/**
 * Highest-priority attention reason for this row, or `null` when the row is
 * NOT in the attention bucket. Order matters: a row that satisfies multiple
 * rules sorts under its highest tier (e.g. failed + mention → failed).
 */
export function rowAttentionReason(r: MeChatRow): AttentionReason | null {
  if (r.failedAgentIds.length > 0) return "failed";
  // `> 0` is skew-safe without an explicit guard: an older server build
  // that predates `openRequestCount` yields `undefined`, and
  // `undefined > 0` is `false` — the rule degrades to "off", same safe
  // direction as the `=== true` boolean checks above.
  if (r.openRequestCount > 0) return "request";
  if (r.unreadMentionCount > 0 && r.chatHasExplicitMentionToMe === true) {
    return "mention";
  }
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

/**
 * Partition rows into the pinned "Needs attention" set and the rest. Within
 * the attention bucket, sort by `ATTENTION_PRIORITY` (stable within tier,
 * so source order is preserved among rows of the same reason). The caller
 * hoists `attention` into a single pinned bucket at the top and groups
 * `rest` normally, so a chat appears in exactly one place.
 *
 * ⚠️ Operates on the already-loaded rows only: an attention chat outside the
 * loaded page(s) is not pinned (page-local v1; the cross-page pinned query is
 * a follow-up).
 */
export function splitAttentionRows(rows: ReadonlyArray<MeChatRow>): { attention: MeChatRow[]; rest: MeChatRow[] } {
  const attention: MeChatRow[] = [];
  const rest: MeChatRow[] = [];
  for (const r of rows) {
    if (rowAttentionReason(r) !== null) attention.push(r);
    else rest.push(r);
  }
  attention.sort((a, b) => {
    const ra = rowAttentionReason(a);
    const rb = rowAttentionReason(b);
    // Defensive guard — both are non-null by construction (only rows with a
    // reason entered `attention`), but a runtime check is cheaper than a TS
    // `as` cast and respects the repo's "no `as` assertions" rule (CLAUDE.md).
    if (ra === null || rb === null) return 0;
    return ATTENTION_PRIORITY.indexOf(ra) - ATTENTION_PRIORITY.indexOf(rb);
  });
  return { attention, rest };
}
