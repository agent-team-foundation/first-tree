import type { ListMeChatsResponse, MeChatRow } from "@first-tree/shared";
import type { InfiniteData } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyOptimisticPin } from "../optimistic-pin.js";

const NOW = "2026-07-13T00:00:00.000Z";
const EARLIER = "2026-07-01T00:00:00.000Z";

function row(overrides: Partial<MeChatRow> & { chatId: string }): MeChatRow {
  return {
    type: "group",
    membershipKind: "participant",
    createdByMe: false,
    source: "manual",
    entityType: null,
    title: overrides.chatId,
    topic: null,
    description: null,
    participants: [],
    participantCount: 0,
    lastMessageAt: "2026-05-28T11:59:00.000Z",
    lastMessagePreview: null,
    unreadMentionCount: 0,
    openRequestCount: 0,
    canReply: true,
    engagementStatus: "active",
    liveActivity: null,
    failedAgentIds: [],
    busyAgentIds: [],
    chatHasExplicitMentionToMe: false,
    pinnedAt: null,
    activityAt: null,
    ...overrides,
  };
}

function page(over: Partial<ListMeChatsResponse> = {}): ListMeChatsResponse {
  return {
    priorityRows: over.priorityRows ?? { attention: [], pinned: [] },
    rows: over.rows ?? [],
    nextCursor: over.nextCursor ?? null,
  };
}

function infinite(pages: ListMeChatsResponse[]): InfiniteData<ListMeChatsResponse> {
  return { pages, pageParams: pages.map(() => undefined) };
}

// Guarded index access — the web tsconfig has `noUncheckedIndexedAccess`, so a
// bare `data.pages[i]` is `T | undefined`; throw instead of littering `?.`.
function pageAt(data: InfiniteData<ListMeChatsResponse>, index: number): ListMeChatsResponse {
  const p = data.pages[index];
  if (!p) throw new Error(`no page at ${index}`);
  return p;
}

describe("applyOptimisticPin", () => {
  it("promotes a recency row into the Pinned group and flips pinnedAt", () => {
    const data = infinite([page({ rows: [row({ chatId: "a" }), row({ chatId: "b" })] })]);
    const next = applyOptimisticPin(data, "b", true, NOW);
    const pinned = pageAt(next, 0).priorityRows.pinned;
    expect(pinned.map((r) => r.chatId)).toEqual(["b"]);
    expect(pinned[0]?.pinnedAt).toBe(NOW);
    // The rows copy is flipped too — dropping it from the recency stream is the
    // list dedup's job (index.tsx), not this helper's.
    expect(pageAt(next, 0).rows.find((r) => r.chatId === "b")?.pinnedAt).toBe(NOW);
  });

  it("prepends the newest pin ahead of existing pins (pinnedAt DESC)", () => {
    const data = infinite([
      page({
        priorityRows: { attention: [], pinned: [row({ chatId: "y", pinnedAt: EARLIER })] },
        rows: [row({ chatId: "x" })],
      }),
    ]);
    const next = applyOptimisticPin(data, "x", true, NOW);
    expect(pageAt(next, 0).priorityRows.pinned.map((r) => r.chatId)).toEqual(["x", "y"]);
  });

  it("removes a chat from the Pinned group on unpin and clears pinnedAt everywhere", () => {
    const data = infinite([
      page({
        priorityRows: { attention: [], pinned: [row({ chatId: "p", pinnedAt: EARLIER })] },
        rows: [row({ chatId: "p", pinnedAt: EARLIER }), row({ chatId: "q" })],
      }),
    ]);
    const next = applyOptimisticPin(data, "p", false, NOW);
    expect(pageAt(next, 0).priorityRows.pinned).toHaveLength(0);
    expect(pageAt(next, 0).rows.find((r) => r.chatId === "p")?.pinnedAt).toBeNull();
  });

  it("keeps an attention chat in attention when pinned (attention wins) and only flips pinnedAt", () => {
    const data = infinite([
      page({ priorityRows: { attention: [row({ chatId: "f" })], pinned: [] }, rows: [row({ chatId: "g" })] }),
    ]);
    const next = applyOptimisticPin(data, "f", true, NOW);
    expect(pageAt(next, 0).priorityRows.pinned).toHaveLength(0);
    expect(pageAt(next, 0).priorityRows.attention[0]?.pinnedAt).toBe(NOW);
  });

  it("is idempotent — re-pinning an already-pinned chat does not duplicate it", () => {
    const data = infinite([
      page({ priorityRows: { attention: [], pinned: [row({ chatId: "p", pinnedAt: EARLIER })] } }),
    ]);
    const next = applyOptimisticPin(data, "p", true, NOW);
    expect(pageAt(next, 0).priorityRows.pinned.map((r) => r.chatId)).toEqual(["p"]);
    expect(pageAt(next, 0).priorityRows.pinned[0]?.pinnedAt).toBe(NOW);
  });

  it("flips pinnedAt on a later-page occurrence and pins from it", () => {
    const data = infinite([
      page({ rows: [row({ chatId: "a" })], nextCursor: "c1" }),
      page({ rows: [row({ chatId: "z" })] }),
    ]);
    const next = applyOptimisticPin(data, "z", true, NOW);
    expect(pageAt(next, 1).rows[0]?.pinnedAt).toBe(NOW);
    // Only page 0 carries the Pinned projection.
    expect(pageAt(next, 0).priorityRows.pinned.map((r) => r.chatId)).toEqual(["z"]);
  });

  it("does not mutate its input", () => {
    const data = infinite([page({ rows: [row({ chatId: "a" })] })]);
    const snapshot = JSON.stringify(data);
    applyOptimisticPin(data, "a", true, NOW);
    expect(JSON.stringify(data)).toBe(snapshot);
  });

  it("leaves a list that does not contain the chat untouched", () => {
    const data = infinite([page({ rows: [row({ chatId: "a" })] })]);
    const next = applyOptimisticPin(data, "missing", true, NOW);
    expect(pageAt(next, 0).priorityRows.pinned).toHaveLength(0);
    expect(pageAt(next, 0).rows.map((r) => r.chatId)).toEqual(["a"]);
  });
});
