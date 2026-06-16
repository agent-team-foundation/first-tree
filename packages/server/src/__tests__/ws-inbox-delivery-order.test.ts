import type { InboxDeliverFrame } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createAdminContext, createTestApp } from "./helpers.js";

describe("Agent WS — inbox delivery ordering", () => {
  let app: FastifyInstance;
  let wsUrl: string;

  function waitForFrame(ws: WebSocket, match: (m: unknown) => boolean, timeoutMs = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error(`timeout waiting for frame (${timeoutMs}ms)`));
      }, timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (match(msg)) {
            clearTimeout(timer);
            ws.off("message", onMessage);
            resolve(msg);
          }
        } catch {
          // ignore non-JSON frames
        }
      };
      ws.on("message", onMessage);
    });
  }

  async function sendHeartbeat(ws: WebSocket): Promise<void> {
    const ackPromise = waitForFrame(ws, (m) => (m as { type?: string }).type === "heartbeat:ack");
    ws.send(JSON.stringify({ type: "heartbeat" }));
    await ackPromise;
  }

  function expectNoDeliverFrame(ws: WebSocket, timeoutMs = 250): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        resolve();
      }, timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString()) as Partial<InboxDeliverFrame> & { type?: string };
          if (msg.type !== "inbox:deliver") return;
          clearTimeout(timer);
          ws.off("message", onMessage);
          reject(new Error(`unexpected duplicate inbox:deliver frame for entry ${msg.entryId ?? "unknown"}`));
        } catch {
          // ignore non-JSON frames
        }
      };
      ws.on("message", onMessage);
    });
  }

  async function loadNotifyRow(inboxId: string, messageId: string) {
    const [row] = await app.db
      .select({
        id: inboxEntries.id,
        status: inboxEntries.status,
        deliveredAt: inboxEntries.deliveredAt,
      })
      .from(inboxEntries)
      .where(
        and(eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.messageId, messageId), eq(inboxEntries.notify, true)),
      )
      .limit(1);
    return row;
  }

  function collectDeliverFrames(ws: WebSocket, count: number, timeoutMs = 5000): Promise<InboxDeliverFrame[]> {
    return new Promise((resolve, reject) => {
      const frames: InboxDeliverFrame[] = [];
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error(`timeout waiting for ${count} inbox:deliver frames (${timeoutMs}ms)`));
      }, timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString()) as Partial<InboxDeliverFrame> & { type?: string };
          if (msg.type !== "inbox:deliver") return;
          frames.push(msg as InboxDeliverFrame);
          if (frames.length === count) {
            clearTimeout(timer);
            ws.off("message", onMessage);
            resolve(frames);
          }
        } catch {
          // ignore non-JSON frames
        }
      };
      ws.on("message", onMessage);
    });
  }

  async function openBoundSocket(seed: {
    accessToken: string;
    clientId: string;
    agentId: string;
    runtimeProvider: string;
  }): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.send(JSON.stringify({ type: "auth", token: seed.accessToken }));
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:ok");

    ws.send(JSON.stringify({ type: "client:register", clientId: seed.clientId }));
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "client:registered");

    ws.send(
      JSON.stringify({
        type: "agent:bind",
        agentId: seed.agentId,
        ref: "bind-order",
        runtimeType: seed.runtimeProvider,
        runtimeVersion: "0.0.0",
      }),
    );
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "agent:bound");
    return ws;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("test server has no address");
    wsUrl = `ws://127.0.0.1:${addr.port}/api/v1/agent/ws/client`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("treats NOTIFY messageId as a wake hint and delivers older same-chat pending entries first", async () => {
    const admin = await createAdminContext(app, { username: `ws-order-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `ws-order-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
      organizationId: admin.organizationId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [agent.uuid],
    });
    const ws = await openBoundSocket({
      accessToken: admin.accessToken,
      clientId: admin.clientId,
      agentId: agent.uuid,
      runtimeProvider: agent.runtimeProvider,
    });

    try {
      const first = await sendMessage(app.db, chat.id, admin.humanAgentUuid, {
        source: "api",
        format: "text",
        content: "A1",
        metadata: { mentions: [agent.uuid] },
      });
      const second = await sendMessage(app.db, chat.id, admin.humanAgentUuid, {
        source: "api",
        format: "text",
        content: "A2",
        metadata: { mentions: [agent.uuid] },
      });

      const framesPromise = collectDeliverFrames(ws, 2);
      await app.notifier.notify(agent.inboxId, second.message.id);
      const frames = await framesPromise;

      expect(frames.map((frame) => frame.message.id)).toEqual([first.message.id, second.message.id]);
      expect(frames.map((frame) => frame.message.content)).toEqual(["A1", "A2"]);
    } finally {
      ws.close();
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    }
  }, 15000);

  it("repairs a pending notify row on heartbeat when PG NOTIFY was missed", async () => {
    const admin = await createAdminContext(app, { username: `ws-repair-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `ws-repair-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
      organizationId: admin.organizationId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [agent.uuid],
    });
    const ws = await openBoundSocket({
      accessToken: admin.accessToken,
      clientId: admin.clientId,
      agentId: agent.uuid,
      runtimeProvider: agent.runtimeProvider,
    });

    try {
      const sent = await sendMessage(app.db, chat.id, admin.humanAgentUuid, {
        source: "api",
        format: "text",
        content: "lost notify repair",
        metadata: { mentions: [agent.uuid] },
      });
      expect((await loadNotifyRow(agent.inboxId, sent.message.id))?.status).toBe("pending");

      const framesPromise = collectDeliverFrames(ws, 1);
      await sendHeartbeat(ws);
      const [frame] = await framesPromise;

      expect(frame?.message.id).toBe(sent.message.id);
      const row = await loadNotifyRow(agent.inboxId, sent.message.id);
      expect(row?.id).toBe(frame?.entryId);
      expect(row?.status).toBe("delivered");
      expect(row?.deliveredAt).toBeInstanceOf(Date);
    } finally {
      ws.close();
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    }
  }, 15000);

  it("does not duplicate delivery when NOTIFY drain races heartbeat repair", async () => {
    const admin = await createAdminContext(app, { username: `ws-repair-dupe-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `ws-repair-dupe-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
      organizationId: admin.organizationId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [agent.uuid],
    });
    const ws = await openBoundSocket({
      accessToken: admin.accessToken,
      clientId: admin.clientId,
      agentId: agent.uuid,
      runtimeProvider: agent.runtimeProvider,
    });

    try {
      const sent = await sendMessage(app.db, chat.id, admin.humanAgentUuid, {
        source: "api",
        format: "text",
        content: "notify repair race",
        metadata: { mentions: [agent.uuid] },
      });

      const framesPromise = collectDeliverFrames(ws, 1);
      await Promise.all([app.notifier.notify(agent.inboxId, sent.message.id), sendHeartbeat(ws)]);
      const [frame] = await framesPromise;
      expect(frame?.message.id).toBe(sent.message.id);
      await expectNoDeliverFrame(ws);

      const row = await loadNotifyRow(agent.inboxId, sent.message.id);
      expect(row?.id).toBe(frame?.entryId);
      expect(row?.status).toBe("delivered");
    } finally {
      ws.close();
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    }
  }, 15000);

  it("uses repair drains without letting one full chat block other chats", async () => {
    const admin = await createAdminContext(app, { username: `ws-repair-fair-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `ws-repair-fair-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
      organizationId: admin.organizationId,
    });
    const chatA = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [agent.uuid],
    });
    const chatB = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [agent.uuid],
    });
    const ws = await openBoundSocket({
      accessToken: admin.accessToken,
      clientId: admin.clientId,
      agentId: agent.uuid,
      runtimeProvider: agent.runtimeProvider,
    });

    try {
      const chatAMessageIds: string[] = [];
      for (let i = 0; i < 9; i++) {
        const sent = await sendMessage(app.db, chatA.id, admin.humanAgentUuid, {
          source: "api",
          format: "text",
          content: `repair A${i + 1}`,
          metadata: { mentions: [agent.uuid] },
        });
        chatAMessageIds.push(sent.message.id);
      }
      const chatBMessage = await sendMessage(app.db, chatB.id, admin.humanAgentUuid, {
        source: "api",
        format: "text",
        content: "repair B1",
        metadata: { mentions: [agent.uuid] },
      });

      const framesPromise = collectDeliverFrames(ws, 9);
      await sendHeartbeat(ws);
      const frames = await framesPromise;
      const contents = frames.map((frame) => String(frame.message.content));

      expect(contents.filter((content) => content.startsWith("repair A"))).toHaveLength(8);
      expect(contents).toContain("repair B1");
      expect(contents).not.toContain("repair A9");
      expect((await loadNotifyRow(agent.inboxId, chatBMessage.message.id))?.status).toBe("delivered");

      const lastChatAMessageId = chatAMessageIds.at(-1);
      if (!lastChatAMessageId) throw new Error("expected chat A messages");
      expect((await loadNotifyRow(agent.inboxId, lastChatAMessageId))?.status).toBe("pending");

      const topUpPromise = collectDeliverFrames(ws, 1);
      const firstChatAFrame = frames.find((frame) => frame.message.content === "repair A1");
      if (!firstChatAFrame) throw new Error("expected repair A1 delivery");
      ws.send(JSON.stringify({ type: "inbox:ack", entryId: firstChatAFrame.entryId, ref: "ack-repair-a1" }));
      const [topUp] = await topUpPromise;

      expect(topUp?.message.id).toBe(lastChatAMessageId);
      expect(topUp?.message.content).toBe("repair A9");
    } finally {
      ws.close();
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    }
  }, 15000);

  it("keeps other chats moving when one chat fills its per-chat in-flight window", async () => {
    const admin = await createAdminContext(app, { username: `ws-fair-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `ws-fair-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
      organizationId: admin.organizationId,
    });
    const chatA = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [agent.uuid],
    });
    const chatB = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [agent.uuid],
    });
    const ws = await openBoundSocket({
      accessToken: admin.accessToken,
      clientId: admin.clientId,
      agentId: agent.uuid,
      runtimeProvider: agent.runtimeProvider,
    });

    try {
      const chatAMessageIds: string[] = [];
      for (let i = 0; i < 9; i++) {
        const sent = await sendMessage(app.db, chatA.id, admin.humanAgentUuid, {
          source: "api",
          format: "text",
          content: `A${i + 1}`,
          metadata: { mentions: [agent.uuid] },
        });
        chatAMessageIds.push(sent.message.id);
      }

      const initialFramesPromise = collectDeliverFrames(ws, 8);
      const lastChatAMessageId = chatAMessageIds.at(-1);
      if (!lastChatAMessageId) throw new Error("expected chat A messages");
      await app.notifier.notify(agent.inboxId, lastChatAMessageId);
      const initialFrames = await initialFramesPromise;
      expect(initialFrames.map((frame) => frame.message.content)).toEqual([
        "A1",
        "A2",
        "A3",
        "A4",
        "A5",
        "A6",
        "A7",
        "A8",
      ]);

      const b1 = await sendMessage(app.db, chatB.id, admin.humanAgentUuid, {
        source: "api",
        format: "text",
        content: "B1",
        metadata: { mentions: [agent.uuid] },
      });
      const b1FramePromise = collectDeliverFrames(ws, 1);
      await app.notifier.notify(agent.inboxId, b1.message.id);
      const [b1Frame] = await b1FramePromise;
      expect(b1Frame?.message.content).toBe("B1");

      const b2 = await sendMessage(app.db, chatB.id, admin.humanAgentUuid, {
        source: "api",
        format: "text",
        content: "B2",
        metadata: { mentions: [agent.uuid] },
      });

      const postAckFramesPromise = collectDeliverFrames(ws, 2);
      const firstChatAFrame = initialFrames[0];
      if (!firstChatAFrame) throw new Error("expected initial chat A delivery");
      ws.send(JSON.stringify({ type: "inbox:ack", entryId: firstChatAFrame.entryId, ref: "ack-a1" }));
      const postAckFrames = await postAckFramesPromise;

      expect(postAckFrames.map((frame) => frame.message.id).sort()).toEqual([lastChatAMessageId, b2.message.id].sort());
      expect(postAckFrames.map((frame) => frame.message.content).sort()).toEqual(["A9", "B2"]);
    } finally {
      ws.close();
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    }
  }, 15000);
});
