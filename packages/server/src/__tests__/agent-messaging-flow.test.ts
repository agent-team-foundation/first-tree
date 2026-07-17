import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { messages } from "../db/schema/messages.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * End-to-end agent messaging flow against the canonical
 * `POST /api/v1/agent/chats/:chatId/messages` path. First Tree keeps a single
 * group-chat model (see first-tree-context PR #281) and the by-name
 * `sendToAgent` primitive has been retired — these tests exercise the
 * `create chat → send → list → history` flow without relying on it.
 */
describe("Agent Messaging Flow (create → send → chats → history)", () => {
  const getApp = useTestApp();

  it("full flow: create chat with peer, send, list chats, view history", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: "flow-sender" });
    const receiver = await createTestAgent(app, { name: "flow-receiver" });

    const chatRes = await sender.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [receiver.agent.uuid],
    });
    expect(chatRes.statusCode).toBe(201);
    const chatId = chatRes.json().id as string;

    const sendRes = await sender.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: `@${receiver.agent.name} Hello from sender`,
      receiverNames: [receiver.agent.name],
    });
    expect(sendRes.statusCode).toBe(201);
    const sentMessage = sendRes.json();
    expect(sentMessage.senderId).toBe(sender.agent.uuid);
    expect(sentMessage.content).toBe(`@${receiver.agent.name} Hello from sender`);
    expect(sentMessage.chatId).toBe(chatId);

    const senderChatsRes = await sender.request("GET", "/api/v1/agent/chats");
    expect(senderChatsRes.statusCode).toBe(200);
    const senderChats = senderChatsRes.json();
    expect(senderChats.items.some((c: { id: string }) => c.id === chatId)).toBe(true);

    const receiverChatsRes = await receiver.request("GET", "/api/v1/agent/chats");
    expect(receiverChatsRes.statusCode).toBe(200);
    const receiverChats = receiverChatsRes.json();
    expect(receiverChats.items.some((c: { id: string }) => c.id === chatId)).toBe(true);

    const historyRes = await sender.request("GET", `/api/v1/agent/chats/${chatId}/messages`);
    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json();
    expect(history.items).toHaveLength(1);
    expect(history.items[0].content).toBe(`@${receiver.agent.name} Hello from sender`);
    expect(history.items[0].senderId).toBe(sender.agent.uuid);

    const replyRes = await receiver.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: `@${sender.agent.name} Hello back!`,
      receiverNames: [sender.agent.name],
    });
    expect(replyRes.statusCode).toBe(201);
    expect(replyRes.json().senderId).toBe(receiver.agent.uuid);

    const historyRes2 = await sender.request("GET", `/api/v1/agent/chats/${chatId}/messages`);
    expect(historyRes2.statusCode).toBe(200);
    expect(historyRes2.json().items).toHaveLength(2);
  });

  it("chats list respects pagination", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "page-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "page-a2" });
    const { agent: a3 } = await createTestAgent(app, { name: "page-a3" });
    const { agent: a4 } = await createTestAgent(app, { name: "page-a4" });

    for (const target of [a2, a3, a4]) {
      const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [target.uuid],
      });
      const chatId = chatRes.json().id as string;
      if (!target.name) throw new Error("target name missing");
      await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
        format: "text",
        content: `@${target.name} hi`,
        receiverNames: [target.name],
      });
    }

    const page1 = await a1.request("GET", "/api/v1/agent/chats?limit=2");
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();

    const page2 = await a1.request("GET", `/api/v1/agent/chats?limit=2&cursor=${p1.nextCursor}`);
    expect(page2.statusCode).toBe(200);
    const p2 = page2.json();
    expect(p2.items.length).toBeGreaterThanOrEqual(1);
  });

  it("message history respects pagination", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "msghist-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "msghist-a2" });

    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.uuid],
    });
    const chatId = chatRes.json().id as string;

    if (!a2.name) throw new Error("a2 name missing");
    const messageIds: string[] = [];
    for (const text of ["msg-1", "msg-2", "msg-3"]) {
      const sent = await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
        format: "text",
        content: `@${a2.name} ${text}`,
        receiverNames: [a2.name],
      });
      messageIds.push(sent.json().id);
    }
    for (const [index, id] of messageIds.entries()) {
      const timestamp = `2026-07-17T09:00:00.123${9 - index}00Z`;
      await app.db
        .update(messages)
        .set({ createdAt: sql`${timestamp}::timestamptz` })
        .where(eq(messages.id, id));
    }

    const page1 = await a1.request("GET", `/api/v1/agent/chats/${chatId}/messages?limit=2`);
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    expect(p1.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const page2 = await a1.request("GET", `/api/v1/agent/chats/${chatId}/messages?limit=2&cursor=${p1.nextCursor}`);
    expect(page2.statusCode).toBe(200);
    const p2 = page2.json();
    expect(p2.items).toHaveLength(1);
    const ids = [...p1.items, ...p2.items].map((message: { id: string }) => message.id);
    expect(new Set(ids).size).toBe(3);

    const invalidCursor = await a1.request(
      "GET",
      `/api/v1/agent/chats/${chatId}/messages?limit=2&cursor=${encodeURIComponent("2026-07-17T09:00:00.123Z")}`,
    );
    expect(invalidCursor.statusCode).toBe(400);
  });

  it("non-participant cannot view history", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "noaccess-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "noaccess-a2" });
    const a3 = await createTestAgent(app, { name: "noaccess-a3" });

    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.uuid],
    });
    const chatId = chatRes.json().id as string;
    if (!a2.name) throw new Error("a2 name missing");
    await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: `@${a2.name} private`,
      receiverNames: [a2.name],
    });

    const historyRes = await a3.request("GET", `/api/v1/agent/chats/${chatId}/messages`);
    expect(historyRes.statusCode).toBe(403);
  });

  it("send with markdown format", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "md-sender" });
    const { agent: a2 } = await createTestAgent(app, { name: "md-receiver" });

    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.uuid],
    });
    const chatId = chatRes.json().id as string;

    if (!a2.name) throw new Error("a2 name missing");
    const res = await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "markdown",
      content: `@${a2.name} ## Hello\n\nThis is **bold**`,
      receiverNames: [a2.name],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().format).toBe("markdown");
    expect(res.json().content).toBe(`@${a2.name} ## Hello\n\nThis is **bold**`);
  });

  it("send with metadata", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "meta-sender" });
    const { agent: a2 } = await createTestAgent(app, { name: "meta-receiver" });

    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.uuid],
    });
    const chatId = chatRes.json().id as string;

    if (!a2.name) throw new Error("a2 name missing");
    const res = await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: `@${a2.name} approval needed`,
      metadata: { intent: "approval", urgency: "high" },
      receiverNames: [a2.name],
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg.metadata.intent).toBe("approval");
    expect(msg.metadata.urgency).toBe("high");
  });
});
