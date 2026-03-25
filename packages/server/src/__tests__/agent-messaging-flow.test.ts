import { afterAll, describe, expect, it } from "vitest";
import { createTestAgent, createTestApp } from "./helpers.js";

describe("Agent Messaging Flow (send → chats → history)", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  it("full flow: send to agent, list chats, view history", async () => {
    const app = await appPromise;
    const { agent: sender, token: senderToken } = await createTestAgent(app, { id: "flow-sender" });
    const { agent: receiver, token: receiverToken } = await createTestAgent(app, { id: "flow-receiver" });

    // 1. Send a direct message to another agent
    const sendRes = await app.inject({
      method: "POST",
      url: `/api/v1/agent/agents/${receiver.id}/messages`,
      headers: { authorization: `Bearer ${senderToken}` },
      payload: { format: "text", content: "Hello from sender" },
    });
    expect(sendRes.statusCode).toBe(201);
    const sentMessage = sendRes.json();
    expect(sentMessage.senderId).toBe(sender.id);
    expect(sentMessage.content).toBe("Hello from sender");
    expect(sentMessage.chatId).toBeDefined();

    const chatId = sentMessage.chatId as string;

    // 2. Sender lists their chats — should include the new direct chat
    const senderChatsRes = await app.inject({
      method: "GET",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${senderToken}` },
    });
    expect(senderChatsRes.statusCode).toBe(200);
    const senderChats = senderChatsRes.json();
    expect(senderChats.items.some((c: { id: string }) => c.id === chatId)).toBe(true);

    // 3. Receiver lists their chats — should also include it
    const receiverChatsRes = await app.inject({
      method: "GET",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${receiverToken}` },
    });
    expect(receiverChatsRes.statusCode).toBe(200);
    const receiverChats = receiverChatsRes.json();
    expect(receiverChats.items.some((c: { id: string }) => c.id === chatId)).toBe(true);

    // 4. View message history in the chat
    const historyRes = await app.inject({
      method: "GET",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${senderToken}` },
    });
    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json();
    expect(history.items).toHaveLength(1);
    expect(history.items[0].content).toBe("Hello from sender");
    expect(history.items[0].senderId).toBe(sender.id);

    // 5. Receiver replies in the same chat
    const replyRes = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${receiverToken}` },
      payload: { format: "text", content: "Hello back!" },
    });
    expect(replyRes.statusCode).toBe(201);
    expect(replyRes.json().senderId).toBe(receiver.id);

    // 6. History now has 2 messages
    const historyRes2 = await app.inject({
      method: "GET",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${senderToken}` },
    });
    expect(historyRes2.statusCode).toBe(200);
    expect(historyRes2.json().items).toHaveLength(2);
  });

  it("chats list respects pagination", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, { id: "page-a1" });
    const { agent: a2 } = await createTestAgent(app, { id: "page-a2" });
    const { agent: a3 } = await createTestAgent(app, { id: "page-a3" });
    const { agent: a4 } = await createTestAgent(app, { id: "page-a4" });

    // Create 3 chats
    for (const target of [a2, a3, a4]) {
      await app.inject({
        method: "POST",
        url: `/api/v1/agent/agents/${target.id}/messages`,
        headers: { authorization: `Bearer ${t1}` },
        payload: { format: "text", content: `hi ${target.id}` },
      });
    }

    // Page 1: limit=2
    const page1 = await app.inject({
      method: "GET",
      url: "/api/v1/agent/chats?limit=2",
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();

    // Page 2: use cursor
    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/agent/chats?limit=2&cursor=${p1.nextCursor}`,
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(page2.statusCode).toBe(200);
    const p2 = page2.json();
    expect(p2.items.length).toBeGreaterThanOrEqual(1);
  });

  it("message history respects pagination", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, { id: "msghist-a1" });
    const { agent: a2 } = await createTestAgent(app, { id: "msghist-a2" });

    // Send first message to create chat
    const firstMsg = await app.inject({
      method: "POST",
      url: `/api/v1/agent/agents/${a2.id}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { format: "text", content: "msg-1" },
    });
    const chatId = firstMsg.json().chatId as string;

    // Send 2 more messages
    for (const text of ["msg-2", "msg-3"]) {
      await app.inject({
        method: "POST",
        url: `/api/v1/agent/chats/${chatId}/messages`,
        headers: { authorization: `Bearer ${t1}` },
        payload: { format: "text", content: text },
      });
    }

    // Page 1: limit=2
    const page1 = await app.inject({
      method: "GET",
      url: `/api/v1/agent/chats/${chatId}/messages?limit=2`,
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();

    // Page 2
    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/agent/chats/${chatId}/messages?limit=2&cursor=${p1.nextCursor}`,
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().items).toHaveLength(1);
  });

  it("non-participant cannot view history", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, { id: "noaccess-a1" });
    const { agent: a2 } = await createTestAgent(app, { id: "noaccess-a2" });
    const { token: t3 } = await createTestAgent(app, { id: "noaccess-a3" });

    // a1 sends to a2 → creates direct chat
    const sendRes = await app.inject({
      method: "POST",
      url: `/api/v1/agent/agents/${a2.id}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { format: "text", content: "private" },
    });
    const chatId = sendRes.json().chatId as string;

    // a3 tries to read history → 403
    const historyRes = await app.inject({
      method: "GET",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${t3}` },
    });
    expect(historyRes.statusCode).toBe(403);
  });

  it("send with markdown format", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, { id: "md-sender" });
    const { agent: a2 } = await createTestAgent(app, { id: "md-receiver" });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agent/agents/${a2.id}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { format: "markdown", content: "## Hello\n\nThis is **bold**" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().format).toBe("markdown");
    expect(res.json().content).toBe("## Hello\n\nThis is **bold**");
  });

  it("send with metadata", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, { id: "meta-sender" });
    const { agent: a2 } = await createTestAgent(app, { id: "meta-receiver" });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agent/agents/${a2.id}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: {
        format: "text",
        content: "approval needed",
        metadata: { intent: "approval", urgency: "high" },
      },
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg.metadata.intent).toBe("approval");
    expect(msg.metadata.urgency).toBe("high");
  });
});
