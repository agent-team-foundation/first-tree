import type { MeChatRow } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  countAttentionRows,
  countUnreadRows,
  isNowFeedRow,
  mobileChatSignal,
  mobileFeedReasonLabel,
  sortMobileChats,
} from "../data.js";

const NOW = "2026-07-09T10:00:00.000Z";

function chatRow(overrides: Partial<MeChatRow> = {}): MeChatRow {
  return {
    chatId: overrides.chatId ?? "chat-1",
    type: overrides.type ?? "group",
    membershipKind: overrides.membershipKind ?? "participant",
    createdByMe: overrides.createdByMe ?? false,
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title ?? "Launch planning",
    topic: overrides.topic ?? "Launch planning",
    description: overrides.description ?? null,
    participants: overrides.participants ?? [
      {
        agentId: "human-agent-self",
        displayName: "Gandy",
        type: "human",
        avatarColorToken: null,
        avatarImageUrl: null,
      },
    ],
    participantCount: overrides.participantCount ?? 1,
    lastMessageAt: overrides.lastMessageAt ?? NOW,
    lastMessagePreview: overrides.lastMessagePreview ?? "Please review the launch checklist.",
    unreadMentionCount: overrides.unreadMentionCount ?? 0,
    openRequestCount: overrides.openRequestCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    liveActivity: overrides.liveActivity ?? null,
    failedAgentIds: overrides.failedAgentIds ?? [],
    busyAgentIds: overrides.busyAgentIds ?? [],
    chatHasExplicitMentionToMe: overrides.chatHasExplicitMentionToMe ?? false,
  };
}

describe("mobile chat projection", () => {
  it("uses canonical attention ordering and leaves unread/working/recent in time order", () => {
    const recent = chatRow({ chatId: "recent", lastMessageAt: "2026-07-09T10:05:00.000Z" });
    const working = chatRow({
      chatId: "working",
      busyAgentIds: ["agent-1"],
      lastMessageAt: "2026-07-09T10:04:00.000Z",
    });
    const unread = chatRow({ chatId: "unread", unreadMentionCount: 2, lastMessageAt: "2026-07-09T10:03:00.000Z" });
    const failed = chatRow({
      chatId: "failed",
      failedAgentIds: ["agent-2"],
      lastMessageAt: "2026-07-09T10:02:00.000Z",
    });
    const question = chatRow({ chatId: "question", openRequestCount: 1, lastMessageAt: "2026-07-09T10:01:00.000Z" });

    expect(sortMobileChats([recent, working, unread, failed, question]).map((row) => row.chatId)).toEqual([
      "failed",
      "question",
      "recent",
      "working",
      "unread",
    ]);
  });

  it("counts attention and unread rows separately for mobile tab badges", () => {
    const explicitMention = chatRow({ chatId: "explicit", chatHasExplicitMentionToMe: true });
    const rows = [
      chatRow({ chatId: "question", openRequestCount: 1 }),
      chatRow({ chatId: "failed", failedAgentIds: ["agent-1"] }),
      explicitMention,
      chatRow({ chatId: "unread", unreadMentionCount: 1 }),
      chatRow({ chatId: "working", busyAgentIds: ["agent-2"] }),
    ];

    expect(countAttentionRows(rows)).toBe(2);
    expect(countUnreadRows(rows)).toBe(1);
    expect(mobileChatSignal(explicitMention).label).toBe("Unread");
    expect(mobileChatSignal(explicitMention).attention).toBe(false);
  });

  it("does not infer the requester from chat participants", () => {
    expect(
      mobileFeedReasonLabel(
        chatRow({
          openRequestCount: 1,
          participants: [
            {
              agentId: "human-agent-self",
              displayName: "Gandy",
              type: "human",
              avatarColorToken: null,
              avatarImageUrl: null,
            },
            {
              agentId: "unrelated-agent",
              displayName: "Unrelated agent",
              type: "agent",
              avatarColorToken: null,
              avatarImageUrl: null,
            },
          ],
        }),
      ),
    ).toBe("Question waiting");
  });
});

describe("isNowFeedRow (needs-attention admission)", () => {
  it("admits chats with an authoritative active signal", () => {
    expect(isNowFeedRow(chatRow({ failedAgentIds: ["agent-1"] }))).toBe(true);
    expect(isNowFeedRow(chatRow({ openRequestCount: 1 }))).toBe(true);
    expect(isNowFeedRow(chatRow({ chatHasExplicitMentionToMe: true }))).toBe(true);
    expect(isNowFeedRow(chatRow({ busyAgentIds: ["agent-1"] }))).toBe(true);
  });

  it("excludes idle and watching-only chats", () => {
    expect(isNowFeedRow(chatRow({}))).toBe(false);
    expect(isNowFeedRow(chatRow({ membershipKind: "watching" }))).toBe(false);
  });

  it("does not admit a liveActivity-only row (description is not busy authority)", () => {
    // A residual/cached liveActivity with no authoritative busyAgentIds must not
    // keep a chat in the needs-attention feed.
    expect(
      isNowFeedRow(
        chatRow({
          busyAgentIds: [],
          liveActivity: { agentId: "agent-1", kind: "tool_call", label: "Using Bash", startedAt: NOW },
        }),
      ),
    ).toBe(false);
  });

  it("does not admit a plain unread 1:1 reply (implicit auto-mention only)", () => {
    // unreadMentionCount also counts the implicit 1:1 DM auto-mention; only an
    // explicit @me qualifies.
    expect(isNowFeedRow(chatRow({ unreadMentionCount: 3, chatHasExplicitMentionToMe: false }))).toBe(false);
  });
});
