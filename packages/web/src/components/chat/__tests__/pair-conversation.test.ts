import type { Message } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { historyContainsThirdParty, isPairConversationMessage, listConversedAgentIds } from "../pair-conversation.js";

function message(overrides: Partial<Message> & Pick<Message, "id" | "senderId" | "createdAt">): Message {
  return {
    id: overrides.id,
    chatId: overrides.chatId ?? "chat-1",
    senderId: overrides.senderId,
    format: overrides.format ?? "markdown",
    content: overrides.content ?? overrides.id,
    metadata: overrides.metadata ?? {},
    inReplyTo: overrides.inReplyTo ?? null,
    source: overrides.source ?? "web",
    createdAt: overrides.createdAt,
  };
}

function pairFilter(messages: readonly Message[], directChat: boolean): string[] {
  const senderById = new Map(messages.map((m) => [m.id, m.senderId]));
  return messages
    .filter((m) =>
      isPairConversationMessage({
        message: m,
        humanAgentId: "human",
        otherAgentId: "asker",
        directChat,
        senderById,
      }),
    )
    .map((m) => m.id);
}

describe("isPairConversationMessage", () => {
  const humanToAsker = message({
    id: "human-to-asker",
    senderId: "human",
    createdAt: "2026-07-28T10:01:00.000Z",
    metadata: { mentions: ["asker"] },
  });
  const askerReply = message({
    id: "asker-reply",
    senderId: "asker",
    createdAt: "2026-07-28T10:02:00.000Z",
    inReplyTo: humanToAsker.id,
  });
  const askerToSomeoneElse = message({
    id: "asker-to-other",
    senderId: "asker",
    createdAt: "2026-07-28T10:03:00.000Z",
    metadata: { mentions: ["other-agent"] },
  });
  const thirdParty = message({
    id: "third-party",
    senderId: "other-agent",
    createdAt: "2026-07-28T10:04:00.000Z",
    metadata: { mentions: ["human"] },
  });

  it("keeps group history to messages between the pair that address each other", () => {
    expect(pairFilter([humanToAsker, askerReply, askerToSomeoneElse, thirdParty], false)).toEqual([
      "human-to-asker",
      "asker-reply",
    ]);
  });

  it("keeps every pair-authored message in a direct chat, regardless of addressing", () => {
    expect(pairFilter([humanToAsker, askerReply, askerToSomeoneElse, thirdParty], true)).toEqual([
      "human-to-asker",
      "asker-reply",
      "asker-to-other",
    ]);
  });

  it("keeps a pair message that mentions the counterpart alongside others", () => {
    const broadcast = message({
      id: "broadcast",
      senderId: "asker",
      createdAt: "2026-07-28T10:05:00.000Z",
      metadata: { mentions: ["other-agent", "human"] },
    });
    expect(pairFilter([broadcast], false)).toEqual(["broadcast"]);
  });
});

describe("historyContainsThirdParty", () => {
  const pairArgs = { humanAgentId: "human", otherAgentId: "asker" } as const;

  it("is false for a window that was always pair-only", () => {
    const window = [
      message({ id: "m1", senderId: "human", createdAt: "2026-07-28T10:01:00.000Z" }),
      message({
        id: "m2",
        senderId: "asker",
        createdAt: "2026-07-28T10:02:00.000Z",
        metadata: { mentions: ["human"] },
      }),
    ];
    expect(historyContainsThirdParty({ messages: window, ...pairArgs })).toBe(false);
  });

  it("detects a departed third speaker's authored message", () => {
    const window = [
      message({ id: "m1", senderId: "human", createdAt: "2026-07-28T10:01:00.000Z" }),
      message({ id: "m2", senderId: "agent-b", createdAt: "2026-07-28T10:02:00.000Z" }),
    ];
    expect(historyContainsThirdParty({ messages: window, ...pairArgs })).toBe(true);
  });

  it("detects a pair-authored message addressed outside the pair", () => {
    const window = [
      message({
        id: "m1",
        senderId: "human",
        createdAt: "2026-07-28T10:01:00.000Z",
        metadata: { mentions: ["agent-b"] },
      }),
    ];
    expect(historyContainsThirdParty({ messages: window, ...pairArgs })).toBe(true);
  });
});

describe("listConversedAgentIds", () => {
  it("lists only agents the viewer exchanged addressed messages with, most recent first", () => {
    const humanToA = message({
      id: "human-to-a",
      senderId: "human",
      createdAt: "2026-07-28T10:01:00.000Z",
      metadata: { mentions: ["agent-a"] },
    });
    const bToHuman = message({
      id: "b-to-human",
      senderId: "agent-b",
      createdAt: "2026-07-28T10:02:00.000Z",
      metadata: { mentions: ["human"] },
    });
    const cToOther = message({
      id: "c-to-other",
      senderId: "agent-c",
      createdAt: "2026-07-28T10:03:00.000Z",
      metadata: { mentions: ["agent-a"] },
    });

    expect(listConversedAgentIds({ messages: [humanToA, bToHuman, cToOther], humanAgentId: "human" })).toEqual([
      "agent-b",
      "agent-a",
    ]);
  });

  it("counts reply threading as an exchange in both directions", () => {
    const aPost = message({
      id: "a-post",
      senderId: "agent-a",
      createdAt: "2026-07-28T10:01:00.000Z",
      metadata: { mentions: ["human"] },
    });
    const humanReply = message({
      id: "human-reply",
      senderId: "human",
      createdAt: "2026-07-28T10:02:00.000Z",
      inReplyTo: "a-post",
    });
    const bReplyToHuman = message({
      id: "b-reply",
      senderId: "agent-b",
      createdAt: "2026-07-28T10:03:00.000Z",
      inReplyTo: "human-reply",
    });

    expect(listConversedAgentIds({ messages: [aPost, humanReply, bReplyToHuman], humanAgentId: "human" })).toEqual([
      "agent-b",
      "agent-a",
    ]);
  });

  it("ignores agents that never exchanged with the viewer and excludes the viewer", () => {
    const silentSides = [
      message({
        id: "x-to-y",
        senderId: "agent-x",
        createdAt: "2026-07-28T10:01:00.000Z",
        metadata: { mentions: ["agent-y"] },
      }),
      message({
        id: "human-unaddressed",
        senderId: "human",
        createdAt: "2026-07-28T10:02:00.000Z",
      }),
    ];
    expect(listConversedAgentIds({ messages: silentSides, humanAgentId: "human" })).toEqual([]);
  });
});
