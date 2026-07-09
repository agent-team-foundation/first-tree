import type { MeChatRow } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { countAttentionRows, countUnreadRows, mobileChatSignal, sortMobileChats } from "../data.js";

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
    participants:
      overrides.participants ??
      [
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
  it("ranks answer-needed chats before failed, unread, working, and recent chats", () => {
    const recent = chatRow({ chatId: "recent", lastMessageAt: "2026-07-09T10:05:00.000Z" });
    const working = chatRow({ chatId: "working", busyAgentIds: ["agent-1"] });
    const unread = chatRow({ chatId: "unread", unreadMentionCount: 2 });
    const failed = chatRow({ chatId: "failed", failedAgentIds: ["agent-2"] });
    const question = chatRow({ chatId: "question", openRequestCount: 1 });

    expect(sortMobileChats([recent, working, unread, failed, question]).map((row) => row.chatId)).toEqual([
      "question",
      "failed",
      "unread",
      "working",
      "recent",
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

    expect(countAttentionRows(rows)).toBe(4);
    expect(countUnreadRows(rows)).toBe(1);
    expect(mobileChatSignal(explicitMention).label).toBe("Unread");
  });
});
