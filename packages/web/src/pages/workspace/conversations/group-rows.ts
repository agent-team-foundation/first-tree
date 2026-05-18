import type { ChatSource, MeChatRow } from "@agent-team-foundation/first-tree-hub-shared";

export type GroupMode = "recency" | "source" | "type" | "none";

/**
 * Parse a `?group=` URL value into a `GroupMode`. Unknown / missing
 * values fall back to `recency` (the default). Exported so both the
 * URL-state side (`WorkspacePage`) and the headless dropdown
 * (`ConversationList`) share one canonical parser.
 */
export function parseGroupMode(raw: string | null): GroupMode {
  if (raw === "source" || raw === "type" || raw === "none") return raw;
  return "recency";
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
