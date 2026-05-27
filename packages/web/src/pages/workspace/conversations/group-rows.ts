import type { ChatSource, MeChatRow } from "@first-tree/shared";

export type GroupMode = "recency" | "source" | "type" | "none";

/**
 * Parse a `?group=` URL value into a `GroupMode`. Unknown / missing
 * values fall back to `source` (the default). Exported so both the
 * URL-state side (`WorkspacePage`) and the headless dropdown
 * (`ConversationList`) share one canonical parser.
 */
export function parseGroupMode(raw: string | null): GroupMode {
  if (raw === "recency" || raw === "type" || raw === "none") return raw;
  return "source";
}

export type GroupBucket = {
  key: string;
  /** `null` = no header rendered (used by `none`). */
  label: string | null;
  rows: ReadonlyArray<MeChatRow>;
  defaultCollapsed: boolean;
};

/**
 * Partition rows into header-prefixed buckets per the user's chosen
 * `Group by` mode. Pure function — the caller is expected to memo with
 * the rows array as the input.
 *
 * `none` returns a single label-less bucket so the render path stays
 * uniform. The list scroll container always renders bucket-by-bucket,
 * never a separate flat code path.
 */
export function groupRows(
  rows: ReadonlyArray<MeChatRow>,
  mode: GroupMode,
  now: Date = new Date(),
): ReadonlyArray<GroupBucket> {
  if (mode === "none" || rows.length === 0) {
    return [{ key: "all", label: null, rows, defaultCollapsed: false }];
  }
  if (mode === "recency") {
    return groupByRecency(rows, now);
  }
  if (mode === "type") {
    return groupByType(rows);
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

const SOURCE_BUCKETS: ReadonlyArray<{ key: ChatSource; label: string }> = [
  { key: "manual", label: "Manual" },
  { key: "github", label: "GitHub" },
  { key: "feishu", label: "Feishu" },
];

function groupBySource(rows: ReadonlyArray<MeChatRow>): ReadonlyArray<GroupBucket> {
  const map = new Map<ChatSource, MeChatRow[]>();
  for (const r of rows) {
    // Same defence as `SourceIcon`: if `r.source` is missing because
    // an older server build hasn't shipped the column yet, treat the
    // row as Manual so it still gets a bucket instead of vanishing.
    const key: ChatSource = r.source ?? "manual";
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
// Type (topology — direct vs group)
// ---------------------------------------------------------------------------
//
// `chats.type` is `direct | group` (set when the chat is created based on
// participant count). The bucket labels read in IM-style shorthand —
// "1:1" / "Team" — because the raw `direct` / `group` values are
// implementation jargon. Anything unknown sinks into the catch-all
// "Other" bucket; in practice we never expect to see one.

const TYPE_BUCKETS: ReadonlyArray<{ key: string; label: string; match: (t: string) => boolean }> = [
  { key: "direct", label: "1:1", match: (t) => t === "direct" },
  { key: "group", label: "Team", match: (t) => t === "group" },
];

function groupByType(rows: ReadonlyArray<MeChatRow>): ReadonlyArray<GroupBucket> {
  const byKey = new Map<string, MeChatRow[]>();
  for (const r of rows) {
    const bucket = TYPE_BUCKETS.find((b) => b.match(r.type));
    const key = bucket?.key ?? "other";
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }
  const buckets: GroupBucket[] = [];
  for (const b of TYPE_BUCKETS) {
    const list = byKey.get(b.key);
    if (!list || list.length === 0) continue;
    buckets.push({ key: b.key, label: b.label, rows: list, defaultCollapsed: false });
  }
  // `other` is a defensive bucket for any unknown topology — surfaced
  // last so users can still see the row instead of having it vanish.
  const other = byKey.get("other");
  if (other && other.length > 0) {
    buckets.push({ key: "other", label: "Other", rows: other, defaultCollapsed: false });
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// attention pinning (failed + mention)
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
//   R2. `unreadMentionCount > 0 && chatHasExplicitMentionToMe === true`
//       — I have unread, and at least one unread message explicitly
//         `@<me>`-mentions me (server checks `messages.metadata.mentions`
//         in the unread window). Distinguishes explicit `@<me>` from the
//         v1 1-on-1 implicit DM auto-mention (`services/message.ts:282
//         dmAutoProjection`), which still bumps `unreadMentionCount` for
//         the red dot but never writes the recipient into
//         `metadata.mentions` — so an agent's plain `"ack"` to me in a DM
//         correctly stays out of attention.
//
// Sort priority: `failed > mention`. The intermediate `needs_you` tier is
// reserved in `ATTENTION_PRIORITY` for a future "open Attention targeting
// me" rule (R3) that will be sourced from the NHA `attentions` table after
// that subsystem stabilises; not yet exposed as a predicate branch.
//
// This ladder is INTENTIONALLY separate from the shared agent-status
// `compareMainStatus` (`failed`, `needs_you`, `working`, ...). `mention` is a
// chat-level signal, not an agent main status — overloading the shared
// comparator would couple two ladders that should evolve independently.
//
// `=== true` checks (not truthy) on booleans: the web client does NOT run
// rows through `meChatRowSchema.parse`, so the Zod `.default(false)` only
// applies server-side; an older server returning `undefined` would
// silently degrade the rule to "off" under strict equality (safer
// direction).

const ATTENTION_PRIORITY = ["failed", "needs_you", "mention"] as const;
type AttentionReason = (typeof ATTENTION_PRIORITY)[number];

/**
 * Highest-priority attention reason for this row, or `null` when the row is
 * NOT in the attention bucket. Order matters: a row that satisfies multiple
 * rules sorts under its highest tier (e.g. failed + mention → failed).
 */
export function rowAttentionReason(r: MeChatRow): AttentionReason | null {
  if (r.failedAgentIds.length > 0) return "failed";
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
 * The row's "needs-you" indicator (orange `?` / left border). No rule in
 * the current predicate emits this tier — it stays dark until the NHA-backed
 * R3 lands (open Attention targeting me). Kept as a function for forward
 * compatibility with `ATTENTION_PRIORITY`'s middle tier.
 */
export function rowNeedsYou(_r: MeChatRow): boolean {
  return false;
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
