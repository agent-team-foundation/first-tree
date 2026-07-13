import type { MeChatRow } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GROUP_MODE,
  groupRows,
  parseGroupMode,
  readStoredGroupMode,
  rowAttentionReason,
  rowIsFailed,
  storeGroupMode,
} from "../conversations/group-rows.js";

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
    createdByMe: overrides.createdByMe ?? false,
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title ?? overrides.id,
    topic: overrides.topic ?? null,
    description: overrides.description ?? null,
    participants: overrides.participants ?? [],
    participantCount: overrides.participantCount ?? 0,
    lastMessageAt: overrides.lastMessageAt,
    lastMessagePreview: overrides.lastMessagePreview ?? null,
    unreadMentionCount: overrides.unreadMentionCount ?? 0,
    openRequestCount: overrides.openRequestCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    liveActivity: overrides.liveActivity ?? null,
    failedAgentIds: overrides.failedAgentIds ?? [],
    busyAgentIds: overrides.busyAgentIds ?? [],
    chatHasExplicitMentionToMe: overrides.chatHasExplicitMentionToMe ?? false,
    pinnedAt: overrides.pinnedAt ?? null,
    activityAt: overrides.activityAt ?? null,
  };
}

// Build an ISO timestamp offset from `NOW` by N hours / days. Negative =
// past. We anchor everything to `NOW` so the local-time wall-clock
// arithmetic inside `groupRows` is exercised with a predictable input.
function offsetIso(hours: number): string {
  return new Date(NOW.getTime() + hours * 60 * 60_000).toISOString();
}

describe("parseGroupMode", () => {
  it("supports only source and recency; unknown values yield null", () => {
    expect(parseGroupMode("source")).toBe("source");
    expect(parseGroupMode("recency")).toBe("recency");
    expect(parseGroupMode("type")).toBeNull();
    expect(parseGroupMode("none")).toBeNull();
    expect(parseGroupMode(null)).toBeNull();
  });

  it("round-trips the stored preference and defaults to recency", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    });
    try {
      expect(readStoredGroupMode()).toBe(DEFAULT_GROUP_MODE);
      storeGroupMode("source");
      expect(readStoredGroupMode()).toBe("source");
      storeGroupMode("recency");
      expect(readStoredGroupMode()).toBe("recency");
      // Corrupt / legacy values fall back to the default.
      store.set("first-tree:chat-list-group", "bogus");
      expect(readStoredGroupMode()).toBe(DEFAULT_GROUP_MODE);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to the default when localStorage is unavailable", () => {
    // Node test env has no `window` at all — the helpers must not throw.
    expect(readStoredGroupMode()).toBe(DEFAULT_GROUP_MODE);
    expect(() => storeGroupMode("source")).not.toThrow();
  });

  it("returns an empty single bucket when there are no rows", () => {
    const buckets = groupRows([], "source", NOW);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.label).toBeNull();
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

  it("buckets by activityAt (recent activity), not lastMessageAt", () => {
    // Description-only update today: last message is 2 weeks old (would sink to
    // "Older") but activityAt is 2h ago → must land in Today, matching the
    // server's activityAt ordering rather than hiding under a collapsed bucket.
    const rows = [row({ id: "desc-today", lastMessageAt: offsetIso(-24 * 14), activityAt: offsetIso(-2) })];
    const buckets = groupRows(rows, "recency", NOW);
    expect(buckets.map((b) => b.key)).toEqual(["today"]);
  });

  it("falls back to lastMessageAt when activityAt is null (version skew)", () => {
    // An old server predating activity_at sends it null → bucket on lastMessageAt
    // so the row isn't wrongly sunk to Older.
    const rows = [row({ id: "skew", lastMessageAt: offsetIso(-2), activityAt: null })];
    const buckets = groupRows(rows, "recency", NOW);
    expect(buckets.map((b) => b.key)).toEqual(["today"]);
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
  it("buckets rows by ownership and ChatSource in canonical order", () => {
    const rows = [
      row({ id: "g1", source: "github", entityType: "issue", lastMessageAt: offsetIso(-1) }),
      row({ id: "m", source: "manual", lastMessageAt: offsetIso(-1) }),
      row({ id: "mine", source: "manual", createdByMe: true, lastMessageAt: offsetIso(-1) }),
      row({ id: "agent", source: "agent", lastMessageAt: offsetIso(-1) }),
      row({ id: "g2", source: "github", entityType: "pull_request", lastMessageAt: offsetIso(-1) }),
    ];
    const buckets = groupRows(rows, "source", NOW);
    // Canonical order is the one declared inside `group-rows.ts`:
    // created-by-me -> manual -> agent -> github.
    expect(buckets.map((b) => b.key)).toEqual(["created-by-me", "manual", "agent", "github"]);
    expect(buckets.map((b) => b.label)).toEqual([
      "Started by me",
      "Started by teammates",
      "Started by agents",
      "From GitHub",
    ]);
    // Both github rows land in the single `github` bucket regardless
    // of inner entityType — the popover collapse is a per-origin axis,
    // not a per-entity one.
    expect(buckets.find((b) => b.key === "github")?.rows.length).toBe(2);
  });

  it("keeps owner-role github rows in GITHUB", () => {
    const rows = [
      row({
        id: "mine-github",
        source: "github",
        entityType: "issue",
        createdByMe: true,
        lastMessageAt: offsetIso(-1),
      }),
    ];
    const buckets = groupRows(rows, "source", NOW);
    expect(buckets.map((b) => b.key)).toEqual(["github"]);
    expect(buckets[0]?.rows.map((r) => r.chatId)).toEqual(["mine-github"]);
  });

  it("omits source buckets with no rows", () => {
    const rows = [row({ id: "m", source: "manual", lastMessageAt: offsetIso(-1) })];
    const buckets = groupRows(rows, "source", NOW);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.key).toBe("manual");
  });
});

// Chat-granularity attention predicate (`rowAttentionReason`, still consumed by
// the mobile rail via `mobile/data.ts`). The list-side splitting + failed-first
// ordering now lives on the server (see `me-chat-priority.test.ts`); these cases
// lock only the front-end PREDICATE: R1 (mine-failed via failedAgentIds), R2
// (open question directed at me via openRequestCount > 0 — ANSWER-cleared, so
// reading the chat does not unpin). A plain unread mention / red dot is
// deliberately NOT a pinning rule. See the rule ladder in group-rows.ts.
describe("rowAttentionReason — predicate", () => {
  it("R1: mine-failed → failed reason", () => {
    const r = row({ id: "r1", lastMessageAt: null, failedAgentIds: ["mine"] });
    expect(rowAttentionReason(r)).toBe("failed");
    expect(rowIsFailed(r)).toBe(true);
  });

  it("R2: open request, no unread → request reason", () => {
    // The core scenario: a `chat ask` (request) chat the human has already READ
    // but not answered. `unreadMentionCount` is 0 (read-cleared), yet the open
    // request keeps the row pinned until the question is answered or closed.
    const r = row({
      id: "r2-open",
      lastMessageAt: null,
      openRequestCount: 1,
      unreadMentionCount: 0,
      chatHasExplicitMentionToMe: false,
      pinnedAt: null,
      activityAt: null,
    });
    expect(rowAttentionReason(r)).toBe("request");
  });

  it("R2 cleared: request answered (count back to 0) → no reason", () => {
    const r = row({ id: "r2-answered", lastMessageAt: null, openRequestCount: 0, unreadMentionCount: 0 });
    expect(rowAttentionReason(r)).toBeNull();
  });

  it("unread + explicit @<me> → no reason (red dot does not pin)", () => {
    // A plain unread mention bumps the red-dot counter but does not hoist the
    // chat: pinning is reserved for an ask (R2) or a broken agent (R1).
    const r = row({
      id: "r2",
      lastMessageAt: null,
      unreadMentionCount: 1,
      chatHasExplicitMentionToMe: true,
      pinnedAt: null,
      activityAt: null,
    });
    expect(rowAttentionReason(r)).toBeNull();
  });

  it("unread 1-on-1 implicit auto-mention → no reason", () => {
    // In a 1v1, agent → human plain "ack" bumps the v1 red-dot counter but
    // `metadata.mentions` is empty (`chatHasExplicitMentionToMe: false`).
    const r = row({
      id: "r2-implicit",
      lastMessageAt: null,
      unreadMentionCount: 1,
      chatHasExplicitMentionToMe: false,
      pinnedAt: null,
      activityAt: null,
    });
    expect(rowAttentionReason(r)).toBeNull();
  });

  it("quiet row → no reason", () => {
    expect(rowAttentionReason(row({ id: "quiet", lastMessageAt: null }))).toBeNull();
  });

  it("failed + request carry a reason; a plain mention does not", () => {
    // Only failed + request earn a reason; a mention-only row does not. The
    // failed-first ORDERING across rows is a server concern (me-chat-priority).
    const mention = row({ id: "m", lastMessageAt: null, unreadMentionCount: 1, chatHasExplicitMentionToMe: true });
    const request = row({ id: "q", lastMessageAt: null, openRequestCount: 1 });
    const failed = row({ id: "f", lastMessageAt: null, failedAgentIds: ["y"] });
    expect(rowAttentionReason(mention)).toBeNull();
    expect(rowAttentionReason(request)).toBe("request");
    expect(rowAttentionReason(failed)).toBe("failed");
  });

  it("request + unread mention on the same row → request", () => {
    // A fresh `chat ask` (request) is typically also an unread explicit
    // mention. The request wins, and it stays `request` after the mention is read.
    const r = row({
      id: "qm",
      lastMessageAt: null,
      openRequestCount: 1,
      unreadMentionCount: 1,
      chatHasExplicitMentionToMe: true,
      pinnedAt: null,
      activityAt: null,
    });
    expect(rowAttentionReason(r)).toBe("request");
  });

  it("failed + unread mention on the same row → failed", () => {
    const r = row({
      id: "fm",
      lastMessageAt: null,
      failedAgentIds: ["a"],
      unreadMentionCount: 1,
      chatHasExplicitMentionToMe: true,
      pinnedAt: null,
      activityAt: null,
    });
    expect(rowAttentionReason(r)).toBe("failed");
  });

  it("boundary A: my failed agent, caller is watcher → still failed", () => {
    // Server already narrows `failedAgentIds` to mine regardless of membership.
    // The front-end predicate stays membership-agnostic for R1, so the row
    // pins even when membershipKind is "watching" — boundary A locked.
    const r = row({ id: "rA", lastMessageAt: null, failedAgentIds: ["mine"], membershipKind: "watching" });
    expect(rowAttentionReason(r)).toBe("failed");
    expect(rowIsFailed(r)).toBe(true);
  });
});

// Version-skew safety: the web client casts the server response as-is and does
// NOT run rows through `meChatRowSchema.parse`, so the zod `.default(...)` only
// applies server-side. The predicate must therefore tolerate an `undefined`
// field from an old server by degrading that rule to "off" rather than mispinning.
describe("rowAttentionReason — version skew (old server, new web)", () => {
  it("missing openRequestCount (undefined) → R2 disabled", () => {
    // `undefined > 0` is `false` — an old server build that predates the field
    // degrades the request rule to "off" rather than mispinning.
    const stale = { ...row({ id: "stale-r2", lastMessageAt: null }) };
    delete (stale as { openRequestCount?: number }).openRequestCount;
    expect(rowAttentionReason(stale)).toBeNull();
  });

  it("missing field still lets R1 (failedAgentIds) fire", () => {
    const stale = { ...row({ id: "stale-r1", lastMessageAt: null, failedAgentIds: ["mine"] }) };
    delete (stale as { chatHasExplicitMentionToMe?: boolean }).chatHasExplicitMentionToMe;
    expect(rowAttentionReason(stale)).toBe("failed");
  });
});
