import type { InboxDeliverFrame } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
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
});
