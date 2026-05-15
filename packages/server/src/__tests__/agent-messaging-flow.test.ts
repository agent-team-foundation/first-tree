import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Messaging Flow (send → chats → history)", () => {
  const getApp = useTestApp();

  it("full flow: send to agent, list chats, view history", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: "flow-sender" });
    const receiver = await createTestAgent(app, { name: "flow-receiver" });

    // v1 §四 改造 1: opening a side-chat with a non-member needs `direct: true`.
    const sendRes = await sender.request("POST", `/api/v1/agent/agents/${receiver.agent.name}/messages`, {
      format: "text",
      content: "Hello from sender",
      direct: true,
    });
    expect(sendRes.statusCode).toBe(201);
    const sentMessage = sendRes.json();
    expect(sentMessage.senderId).toBe(sender.agent.uuid);
    // Server prepends @<targetName> on agent-to-agent sends — see
    // agent-send-mention-injection.test.ts.
    expect(sentMessage.content).toBe(`@${receiver.agent.name} Hello from sender`);
    expect(sentMessage.chatId).toBeDefined();

    const chatId = sentMessage.chatId as string;

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
      content: "Hello back!",
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
      await a1.request("POST", `/api/v1/agent/agents/${target.name}/messages`, {
        format: "text",
        content: `hi ${target.name}`,
        direct: true,
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

    const firstMsg = await a1.request("POST", `/api/v1/agent/agents/${a2.name}/messages`, {
      format: "text",
      content: "msg-1",
      direct: true,
    });
    const chatId = firstMsg.json().chatId as string;

    for (const text of ["msg-2", "msg-3"]) {
      await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
        format: "text",
        content: text,
      });
    }

    const page1 = await a1.request("GET", `/api/v1/agent/chats/${chatId}/messages?limit=2`);
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();

    const page2 = await a1.request("GET", `/api/v1/agent/chats/${chatId}/messages?limit=2&cursor=${p1.nextCursor}`);
    expect(page2.statusCode).toBe(200);
    expect(page2.json().items).toHaveLength(1);
  });

  it("non-participant cannot view history", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "noaccess-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "noaccess-a2" });
    const a3 = await createTestAgent(app, { name: "noaccess-a3" });

    const sendRes = await a1.request("POST", `/api/v1/agent/agents/${a2.name}/messages`, {
      format: "text",
      content: "private",
      direct: true,
    });
    const chatId = sendRes.json().chatId as string;

    const historyRes = await a3.request("GET", `/api/v1/agent/chats/${chatId}/messages`);
    expect(historyRes.statusCode).toBe(403);
  });

  it("send with markdown format", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "md-sender" });
    const { agent: a2 } = await createTestAgent(app, { name: "md-receiver" });

    const res = await a1.request("POST", `/api/v1/agent/agents/${a2.name}/messages`, {
      format: "markdown",
      content: "## Hello\n\nThis is **bold**",
      direct: true,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().format).toBe("markdown");
    // Server prepends @<targetName> on agent-to-agent sends — see
    // agent-send-mention-injection.test.ts.
    expect(res.json().content).toBe(`@${a2.name} ## Hello\n\nThis is **bold**`);
  });

  it("send with metadata", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "meta-sender" });
    const { agent: a2 } = await createTestAgent(app, { name: "meta-receiver" });

    const res = await a1.request("POST", `/api/v1/agent/agents/${a2.name}/messages`, {
      format: "text",
      content: "approval needed",
      metadata: { intent: "approval", urgency: "high" },
      direct: true,
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg.metadata.intent).toBe("approval");
    expect(msg.metadata.urgency).toBe("high");
  });
});
