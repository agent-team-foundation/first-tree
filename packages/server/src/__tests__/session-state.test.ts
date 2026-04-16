import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { chats } from "../db/schema/chats.js";
import * as activityService from "../services/activity.js";
import * as presenceService from "../services/presence.js";
import { createTestAgent, createTestApp } from "./helpers.js";

/**
 * Integration tests for session-level state reporting:
 *
 * 1. upsertSessionState — upsert + aggregate + presence update
 * 2. WS session:state — end-to-end through WebSocket handler
 */

/** Create a chat row in the DB for FK satisfaction. */
async function createTestChat(app: Awaited<ReturnType<typeof createTestApp>>, chatId: string, organizationId: string) {
  await app.db.insert(chats).values({ id: chatId, organizationId, type: "direct" }).onConflictDoNothing();
}

// -- Integration: upsertSessionState ------------------------------------------

describe("upsertSessionState", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  it("creates session row and updates presence aggregates", async () => {
    const app = await appPromise;
    const { agent } = await createTestAgent(app, { name: "state-a1" });
    await presenceService.setOnline(app.db, agent.uuid, "test-instance");
    await createTestChat(app, "chat-s1", agent.organizationId);

    await activityService.upsertSessionState(app.db, agent.uuid, "chat-s1", "active");

    // Verify agent_chat_sessions row
    const [session] = await app.db.select().from(agentChatSessions).where(eq(agentChatSessions.agentId, agent.uuid));
    expect(session).toBeDefined();
    expect(session?.chatId).toBe("chat-s1");
    expect(session?.state).toBe("active");

    // Verify presence session counts (runtimeState is set separately via runtime:state WS message)
    const presence = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence?.activeSessions).toBe(1);
    expect(presence?.totalSessions).toBe(1);
  });

  it("updates existing session state on conflict", async () => {
    const app = await appPromise;
    const { agent } = await createTestAgent(app, { name: "state-a2" });
    await presenceService.setOnline(app.db, agent.uuid, "test-instance");
    await createTestChat(app, "chat-s2", agent.organizationId);

    await activityService.upsertSessionState(app.db, agent.uuid, "chat-s2", "active");
    await activityService.upsertSessionState(app.db, agent.uuid, "chat-s2", "suspended");

    const [session] = await app.db.select().from(agentChatSessions).where(eq(agentChatSessions.agentId, agent.uuid));
    expect(session?.state).toBe("suspended");

    const presence = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence?.activeSessions).toBe(0);
    expect(presence?.totalSessions).toBe(1);
  });

  it("correctly aggregates multiple sessions", async () => {
    const app = await appPromise;
    const { agent } = await createTestAgent(app, { name: "state-a3" });
    await presenceService.setOnline(app.db, agent.uuid, "test-instance");
    await createTestChat(app, "chat-s3a", agent.organizationId);
    await createTestChat(app, "chat-s3b", agent.organizationId);
    await createTestChat(app, "chat-s3c", agent.organizationId);

    await activityService.upsertSessionState(app.db, agent.uuid, "chat-s3a", "active");
    await activityService.upsertSessionState(app.db, agent.uuid, "chat-s3b", "active");
    await activityService.upsertSessionState(app.db, agent.uuid, "chat-s3c", "suspended");

    const presence = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence?.activeSessions).toBe(2);
    expect(presence?.totalSessions).toBe(3);

    // Suspend one active
    await activityService.upsertSessionState(app.db, agent.uuid, "chat-s3a", "suspended");
    const presence2 = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence2?.activeSessions).toBe(1);
    expect(presence2?.totalSessions).toBe(3);

    // Suspend the last active
    await activityService.upsertSessionState(app.db, agent.uuid, "chat-s3b", "suspended");
    const presence3 = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence3?.activeSessions).toBe(0);
  });

  it("handles evicted state", async () => {
    const app = await appPromise;
    const { agent } = await createTestAgent(app, { name: "state-a4" });
    await presenceService.setOnline(app.db, agent.uuid, "test-instance");
    await createTestChat(app, "chat-s4", agent.organizationId);

    await activityService.upsertSessionState(app.db, agent.uuid, "chat-s4", "active");
    await activityService.upsertSessionState(app.db, agent.uuid, "chat-s4", "evicted");

    const [session] = await app.db.select().from(agentChatSessions).where(eq(agentChatSessions.agentId, agent.uuid));
    expect(session?.state).toBe("evicted");

    const presence = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence?.activeSessions).toBe(0);
  });
});

// -- E2E: WS session:state ---------------------------------------------------

describe("WS session:state message", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let addr: string;

  beforeAll(async () => {
    app = await createTestApp();
    addr = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => app?.close());

  /** Helper: open a client WS and complete registration + bind handshake. */
  async function connectAndBind(token: string): Promise<{
    ws: WebSocket;
    agentId: string;
    clientId: string;
  }> {
    if (!app) {
      app = await createTestApp();
      addr = await app.listen({ port: 0, host: "127.0.0.1" });
    }

    const wsUrl = `${addr.replace(/^http/, "ws")}/api/v1/agent/ws/client`;
    const ws = new WebSocket(wsUrl);
    const clientId = `test-client-${crypto.randomUUID().slice(0, 8)}`;

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    // Register
    ws.send(JSON.stringify({ type: "client:register", clientId }));
    await waitForMessage(ws, "client:registered");

    // Bind
    const ref = crypto.randomUUID().slice(0, 12);
    ws.send(JSON.stringify({ type: "agent:bind", ref, token, runtimeType: "claude-code" }));
    const boundMsg = await waitForMessage(ws, "agent:bound");
    const agentId = (boundMsg as { agentId: string }).agentId;

    return { ws, agentId, clientId };
  }

  /** Wait for a specific WS message type. */
  function waitForMessage(ws: WebSocket, type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
      const handler = (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === type) {
          clearTimeout(timer);
          ws.off("message", handler);
          resolve(msg);
        }
      };
      ws.on("message", handler);
    });
  }

  it("session:state message updates agent_chat_sessions and presence", async () => {
    if (!app) {
      app = await createTestApp();
      addr = await app.listen({ port: 0, host: "127.0.0.1" });
    }

    const { agent, token } = await createTestAgent(app, {
      name: `ws-state-${crypto.randomUUID().slice(0, 6)}`,
    });

    // Create a real chat via the API (sendToAgent creates one)
    const { token: senderToken } = await createTestAgent(app, {
      name: `ws-sender-${crypto.randomUUID().slice(0, 6)}`,
    });

    const { FirstTreeHubSDK } = await import("@first-tree-hub/client");
    const senderSdk = new FirstTreeHubSDK({ serverUrl: addr, token: senderToken });
    const agentName = agent.name ?? agent.uuid;
    const msg = await senderSdk.sendToAgent(agentName, {
      format: "text",
      content: "test message",
    });
    const chatId = msg.chatId;

    // Connect and bind the receiver agent
    const { ws, agentId } = await connectAndBind(token);

    // Send session:state + runtime:state (separate channels by design)
    ws.send(JSON.stringify({ type: "session:state", agentId, chatId, state: "active" }));
    ws.send(JSON.stringify({ type: "runtime:state", agentId, runtimeState: "working" }));

    // Wait for server processing
    await new Promise((r) => setTimeout(r, 500));

    // Verify DB state
    const [session] = await app.db.select().from(agentChatSessions).where(eq(agentChatSessions.agentId, agentId));
    expect(session).toBeDefined();
    expect(session?.chatId).toBe(chatId);
    expect(session?.state).toBe("active");

    // Verify presence updated (session counts from session:state, runtimeState from runtime:state)
    const presence = await presenceService.getPresence(app.db, agentId);
    expect(presence?.runtimeState).toBe("working");
    expect(presence?.activeSessions).toBe(1);

    // Now suspend + set idle
    ws.send(JSON.stringify({ type: "session:state", agentId, chatId, state: "suspended" }));
    ws.send(JSON.stringify({ type: "runtime:state", agentId, runtimeState: "idle" }));
    await new Promise((r) => setTimeout(r, 500));

    const presence2 = await presenceService.getPresence(app.db, agentId);
    expect(presence2?.runtimeState).toBe("idle");
    expect(presence2?.activeSessions).toBe(0);

    ws.close();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("rejects session:state for unbound agent", async () => {
    if (!app) {
      app = await createTestApp();
      addr = await app.listen({ port: 0, host: "127.0.0.1" });
    }

    const { token } = await createTestAgent(app, {
      name: `ws-unbound-${crypto.randomUUID().slice(0, 6)}`,
    });

    const { ws } = await connectAndBind(token);

    // Try to send session:state for a different (unbound) agent
    ws.send(
      JSON.stringify({
        type: "session:state",
        agentId: "nonexistent-agent",
        chatId: "chat-fake",
        state: "active",
      }),
    );

    const errorMsg = await waitForMessage(ws, "error");
    expect(errorMsg.message).toBe("Agent not bound");

    ws.close();
    await new Promise((r) => setTimeout(r, 200));
  });
});
