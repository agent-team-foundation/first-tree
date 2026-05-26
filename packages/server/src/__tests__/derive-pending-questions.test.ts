import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pendingQuestions } from "../db/schema/pending-questions.js";
import { derivePendingQuestions } from "../services/agent-chat-status.js";
import { useTestApp } from "./helpers.js";

// `pending_questions` has no foreign keys (integrity enforced in the service
// layer), so these tests insert rows with synthetic chat/agent ids and unique
// chat ids per case — no chat/agent seeding or cross-test cleanup needed.
describe("derivePendingQuestions", () => {
  const getApp = useTestApp();

  it("returns an empty map for no chatIds", async () => {
    const map = await derivePendingQuestions(getApp().db, []);
    expect(map.size).toBe(0);
  });

  it("groups pending agents by chat; excludes answered/superseded and unqueried chats", async () => {
    const chatA = randomUUID();
    const chatB = randomUUID();
    const otherChat = randomUUID();
    const a1 = randomUUID();
    const a2 = randomUUID();
    await getApp()
      .db.insert(pendingQuestions)
      .values([
        { id: randomUUID(), agentId: a1, chatId: chatA, messageId: randomUUID(), status: "pending" },
        { id: randomUUID(), agentId: a2, chatId: chatA, messageId: randomUUID(), status: "pending" },
        { id: randomUUID(), agentId: a1, chatId: chatA, messageId: randomUUID(), status: "answered" },
        { id: randomUUID(), agentId: a1, chatId: chatB, messageId: randomUUID(), status: "superseded" },
        { id: randomUUID(), agentId: a1, chatId: otherChat, messageId: randomUUID(), status: "pending" },
      ]);

    const map = await derivePendingQuestions(getApp().db, [chatA, chatB]);

    // chatA: two distinct pending agents; the answered row is excluded.
    expect(new Set(map.get(chatA))).toEqual(new Set([a1, a2]));
    // chatB: only a superseded row → absent.
    expect(map.has(chatB)).toBe(false);
    // otherChat: pending but not in the queried set → absent.
    expect(map.has(otherChat)).toBe(false);
  });

  it("dedupes an agent with multiple pending questions in the same chat", async () => {
    const chat = randomUUID();
    const a1 = randomUUID();
    await getApp()
      .db.insert(pendingQuestions)
      .values([
        { id: randomUUID(), agentId: a1, chatId: chat, messageId: randomUUID(), status: "pending" },
        { id: randomUUID(), agentId: a1, chatId: chat, messageId: randomUUID(), status: "pending" },
      ]);

    const map = await derivePendingQuestions(getApp().db, [chat]);

    expect(map.get(chat)).toEqual([a1]); // not [a1, a1]
  });
});
