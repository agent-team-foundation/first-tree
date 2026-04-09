import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createTestAgent, createTestApp } from "./helpers.js";

describe("WebSocket notification on message send", () => {
  const appPromise = createTestApp();
  let addr: string;

  beforeAll(async () => {
    const app = await appPromise;
    addr = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => (await appPromise).close());

  it("recipient receives WS notification when message is sent via API", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, {
      name: `ntf-a1-${crypto.randomUUID().slice(0, 6)}`,
    });
    const { agent: a2, token: t2 } = await createTestAgent(app, {
      name: `ntf-a2-${crypto.randomUUID().slice(0, 6)}`,
    });

    // Create a chat
    const chatRes = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${t1}` },
      payload: { type: "direct", participantIds: [a2.uuid] },
    });
    const chatId = chatRes.json().id;

    // Connect a2 via WS to receive notifications
    const wsUrl = `${addr.replace(/^http/, "ws")}/api/v1/agent/ws/inbox`;
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${t2}` },
    });

    const wsMessages: unknown[] = [];
    const notificationReceived = new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        wsMessages.push(msg);
        if (msg.type === "new_message") {
          resolve();
        }
      });
    });

    // Wait for WS to open
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    // Send a message from a1 to the chat
    const sendRes = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { format: "text", content: "Hello via WS!" },
    });
    expect(sendRes.statusCode).toBe(201);

    // Wait for the WS notification (with timeout)
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("WS notification timeout")), 5000),
    );
    await Promise.race([notificationReceived, timeout]);

    expect(wsMessages.length).toBeGreaterThanOrEqual(1);
    const notification = wsMessages.find((m) => (m as { type: string }).type === "new_message") as {
      type: string;
      inboxId: string;
      messageId: string;
    };
    expect(notification).toBeDefined();
    expect(notification.type).toBe("new_message");
    expect(notification.inboxId).toBe(a2.inboxId);

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("recipient receives WS notification on sendToAgent", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, {
      name: `ntf-dm1-${crypto.randomUUID().slice(0, 6)}`,
    });
    const { agent: a2, token: t2 } = await createTestAgent(app, {
      name: `ntf-dm2-${crypto.randomUUID().slice(0, 6)}`,
    });

    // Connect a2 via WS
    const wsUrl = `${addr.replace(/^http/, "ws")}/api/v1/agent/ws/inbox`;
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${t2}` },
    });

    const notificationReceived = new Promise<{ type: string; inboxId: string }>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "new_message") {
          resolve(msg);
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    // Send via sendToAgent API
    const sendRes = await app.inject({
      method: "POST",
      url: `/api/v1/agent/agents/${a2.name}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { format: "text", content: "DM via WS!" },
    });
    expect(sendRes.statusCode).toBe(201);

    const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000));
    const notification = await Promise.race([notificationReceived, timeoutPromise]);

    expect(notification.type).toBe("new_message");
    expect(notification.inboxId).toBe(a2.inboxId);

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });
});
