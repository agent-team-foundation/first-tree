import type { MeChatRow } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { groupRows } from "../conversations/group-rows.js";

// Fixed reference "now" — picked to be mid-week so the
// `startOfWeek` (Monday) maths is exercised non-trivially. UTC noon
// avoids any "midnight in the local zone happens to be in a different
// day in UTC" surprises.
const NOW = new Date("2026-05-13T12:00:00Z"); // Wed local in most TZs

function row(overrides: Partial<MeChatRow> & { id: string; lastMessageAt: string | null }): MeChatRow {
  return {
    chatId: overrides.id,
    type: overrides.type ?? "direct",
    membershipKind: overrides.membershipKind ?? "participant",
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title ?? overrides.id,
    topic: overrides.topic ?? null,
    participants: overrides.participants ?? [],
    participantCount: overrides.participantCount ?? 0,
    lastMessageAt: overrides.lastMessageAt,
    lastMessagePreview: overrides.lastMessagePreview ?? null,
    unreadMentionCount: overrides.unreadMentionCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    engagedAgentIds: overrides.engagedAgentIds ?? [],
    liveActivity: overrides.liveActivity ?? null,
  };
}

// Build an ISO timestamp offset from `NOW` by N hours / days. Negative =
// past. We anchor everything to `NOW` so the local-time wall-clock
// arithmetic inside `groupRows` is exercised with a predictable input.
function offsetIso(hours: number): string {
  return new Date(NOW.getTime() + hours * 60 * 60_000).toISOString();
}

describe("groupRows — none", () => {
  it("returns a single label-less bucket", () => {
    const rows = [row({ id: "a", lastMessageAt: offsetIso(-1) })];
    const buckets = groupRows(rows, "none", NOW);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.label).toBeNull();
    expect(buckets[0]?.rows).toHaveLength(1);
  });

  it("returns an empty single bucket when there are no rows", () => {
    const buckets = groupRows([], "none", NOW);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.rows).toHaveLength(0);
  });
});

describe("groupRows — recency", () => {
  it("buckets a fresh chat into Today", () => {
    const rows = [row({ id: "now-ish", lastMessageAt: offsetIso(-2) })];
    const buckets = groupRows(rows, "recency", NOW);
    expect(buckets.map((b) => b.key)).toEqual(["today"]);
    expect(buckets[0]?.label).toBe("Today");
  });

  it("buckets a chat from 30h ago into Yesterday", () => {
    const rows = [row({ id: "y", lastMessageAt: offsetIso(-30) })];
    const buckets = groupRows(rows, "recency", NOW);
    expect(buckets[0]?.key).toBe("yesterday");
  });

  it("buckets a chat from earlier this week into this-week", () => {
    // NOW is Wed 12:00 — 2 days back is Monday, within the same Monday-start week.
    const rows = [row({ id: "mon", lastMessageAt: offsetIso(-48 - 6) })]; // 54h back ≈ Monday morning
    const buckets = groupRows(rows, "recency", NOW);
    expect(buckets[0]?.key).toBe("this-week");
  });

  it("buckets a chat older than this week into older", () => {
    const rows = [row({ id: "old", lastMessageAt: offsetIso(-24 * 14) })]; // 2 weeks back
    const buckets = groupRows(rows, "recency", NOW);
    expect(buckets[0]?.key).toBe("older");
  });

  it("sinks NULL timestamp rows into older", () => {
    // A chat without `last_message_at` is most likely a brand-new empty
    // room; we'd rather display it at the bottom than drop it or float
    // it above dated rows.
    const rows = [row({ id: "null", lastMessageAt: null })];
    const buckets = groupRows(rows, "recency", NOW);
    expect(buckets[0]?.key).toBe("older");
  });

  it("renders buckets in chronological order (newest first) and omits empty buckets", () => {
    const rows = [
      row({ id: "today-1", lastMessageAt: offsetIso(-3) }),
      row({ id: "old-1", lastMessageAt: offsetIso(-24 * 30) }),
      row({ id: "today-2", lastMessageAt: offsetIso(-1) }),
    ];
    const buckets = groupRows(rows, "recency", NOW);
    expect(buckets.map((b) => b.key)).toEqual(["today", "older"]);
    expect(buckets[0]?.rows).toHaveLength(2);
    expect(buckets[1]?.rows).toHaveLength(1);
  });

  it("defaults the older two buckets to collapsed and the recent two open", () => {
    const rows = [
      row({ id: "t", lastMessageAt: offsetIso(-2) }),
      row({ id: "y", lastMessageAt: offsetIso(-30) }),
      row({ id: "w", lastMessageAt: offsetIso(-54) }),
      row({ id: "o", lastMessageAt: offsetIso(-24 * 14) }),
    ];
    const buckets = groupRows(rows, "recency", NOW);
    const byKey = new Map(buckets.map((b) => [b.key, b.defaultCollapsed]));
    expect(byKey.get("today")).toBe(false);
    expect(byKey.get("yesterday")).toBe(false);
    expect(byKey.get("this-week")).toBe(true);
    expect(byKey.get("older")).toBe(true);
  });
});

describe("groupRows — source", () => {
  it("buckets rows by ChatSource in canonical order", () => {
    const rows = [
      row({ id: "g1", source: "github", entityType: "issue", lastMessageAt: offsetIso(-1) }),
      row({ id: "m", source: "manual", lastMessageAt: offsetIso(-1) }),
      row({ id: "g2", source: "github", entityType: "pull_request", lastMessageAt: offsetIso(-1) }),
      row({ id: "f", source: "feishu", lastMessageAt: offsetIso(-1) }),
    ];
    const buckets = groupRows(rows, "source", NOW);
    // Canonical order is the one declared inside `group-rows.ts`:
    // manual → github → feishu.
    expect(buckets.map((b) => b.key)).toEqual(["manual", "github", "feishu"]);
    // Both github rows land in the single `github` bucket regardless
    // of inner entityType — the popover collapse is a per-origin axis,
    // not a per-entity one.
    expect(buckets.find((b) => b.key === "github")?.rows.length).toBe(2);
  });

  it("omits source buckets with no rows", () => {
    const rows = [row({ id: "m", source: "manual", lastMessageAt: offsetIso(-1) })];
    const buckets = groupRows(rows, "source", NOW);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.key).toBe("manual");
  });
});

describe("groupRows — type", () => {
  it("buckets direct vs group chats with IM-style labels", () => {
    const rows = [
      row({ id: "d1", type: "direct", lastMessageAt: offsetIso(-1) }),
      row({ id: "g1", type: "group", lastMessageAt: offsetIso(-1) }),
      row({ id: "d2", type: "direct", lastMessageAt: offsetIso(-1) }),
    ];
    const buckets = groupRows(rows, "type", NOW);
    expect(buckets.map((b) => b.key)).toEqual(["direct", "group"]);
    expect(buckets[0]?.label).toBe("1:1");
    expect(buckets[1]?.label).toBe("Team");
    expect(buckets[0]?.rows.length).toBe(2);
    expect(buckets[1]?.rows.length).toBe(1);
  });

  it("omits type buckets with no rows", () => {
    const rows = [row({ id: "d", type: "direct", lastMessageAt: offsetIso(-1) })];
    const buckets = groupRows(rows, "type", NOW);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.key).toBe("direct");
  });

  it("sinks unknown chat type into an Other bucket so the row stays visible", () => {
    const rows = [
      row({ id: "u", type: "future-channel-kind", lastMessageAt: offsetIso(-1) }),
      row({ id: "d", type: "direct", lastMessageAt: offsetIso(-1) }),
    ];
    const buckets = groupRows(rows, "type", NOW);
    expect(buckets.map((b) => b.key)).toEqual(["direct", "other"]);
    expect(buckets[1]?.label).toBe("Other");
  });
});
