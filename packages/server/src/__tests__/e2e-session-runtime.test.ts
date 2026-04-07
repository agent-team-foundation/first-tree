import type { AgentHandler, HandlerFactory, SessionContext, SessionMessage } from "@first-tree-hub/client";
import { FirstTreeHubSDK, SessionManager } from "@first-tree-hub/client";
import type { InboxEntryWithMessage } from "@first-tree-hub/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAgent, createToken } from "../services/agent.js";

/** Narrow pull entry — asserts existence in tests. */
function entry(arr: InboxEntryWithMessage[], idx: number): InboxEntryWithMessage {
  const e = arr[idx];
  if (!e) throw new Error(`Expected entry at index ${idx}`);
  return e;
}

/**
 * E2E: Session-oriented Runtime — Tests the full pipeline:
 *
 *   Agent A (sender) → Server → Agent B SDK pull → SessionManager dispatch
 *   → Handler lifecycle (start / inject / suspend / resume)
 *
 * Uses local docker-compose PG and a real Fastify server.
 * Handler is a test double (no Claude CLI required).
 */

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://firsttreehub:firsttreehub@localhost:5432/firsttreehub";

// -- Test handler: records all lifecycle calls for assertions ----------------

type LifecycleEvent =
  | { type: "start"; chatId: string; content: string }
  | { type: "resume"; chatId: string; content: string; sessionId: string }
  | { type: "inject"; content: string }
  | { type: "suspend" }
  | { type: "shutdown" };

function createTestHandler(events: LifecycleEvent[]): AgentHandler {
  let sessionId = `test-session-${Date.now()}`;
  return {
    async start(message: SessionMessage, _ctx: SessionContext) {
      events.push({ type: "start", chatId: message.chatId, content: String(message.content) });
      return sessionId;
    },
    async resume(message: SessionMessage, sid: string, _ctx: SessionContext) {
      sessionId = sid;
      events.push({ type: "resume", chatId: message.chatId, content: String(message.content), sessionId: sid });
      return sid;
    },
    inject(message: SessionMessage) {
      events.push({ type: "inject", content: String(message.content) });
    },
    async suspend() {
      events.push({ type: "suspend" });
    },
    async shutdown() {
      events.push({ type: "shutdown" });
    },
  };
}

// -- Helpers -----------------------------------------------------------------

async function createTestAgent(app: Awaited<ReturnType<typeof buildApp>>, opts: { id: string; displayName?: string }) {
  const agent = await createAgent(app.db, {
    id: opts.id,
    type: "autonomous_agent",
    displayName: opts.displayName ?? "Test Agent",
  });
  const tokenResult = await createToken(app.db, agent.id, { name: "test" });
  return { agent, token: tokenResult.token };
}

// -- Test suite --------------------------------------------------------------

describe("E2E: Session-oriented Runtime", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let address: string;

  beforeAll(async () => {
    app = await buildApp({
      database: { url: DATABASE_URL, provider: "external" },
      server: { port: 0, host: "127.0.0.1" },
      secrets: { jwtSecret: "test-jwt-secret-session-e2e", encryptionKey: "0".repeat(64) },
      github: { token: undefined, webhookSecret: "test-secret" },
      rateLimit: { max: 10000, loginMax: 10000, webhookMax: 10000 },
      logger: false,
      instanceId: "e2e-session-test",
    });
    await app.ready();
    address = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(async () => {
    await app.db.execute(sql`
      TRUNCATE TABLE inbox_entries, messages, chat_participants, chats,
        agent_tokens, agent_presence, agents, admin_users, system_configs,
        server_instances CASCADE
    `);
  });

  it("full session lifecycle: start → inject → shutdown", async () => {
    // 1. Create sender and receiver agents
    const sender = await createTestAgent(app, { id: "sender-agent", displayName: "Sender" });
    const receiver = await createTestAgent(app, { id: "receiver-agent", displayName: "Receiver" });

    const senderSdk = new FirstTreeHubSDK({ serverUrl: address, token: sender.token });
    const receiverSdk = new FirstTreeHubSDK({ serverUrl: address, token: receiver.token });

    // Verify both agents are registered
    const senderIdentity = await senderSdk.register();
    const receiverIdentity = await receiverSdk.register();
    expect(senderIdentity.agentId).toBe("sender-agent");
    expect(receiverIdentity.agentId).toBe("receiver-agent");

    // 2. Send first message from sender → receiver (creates chat via sendToAgent)
    const msg1 = await senderSdk.sendToAgent("receiver-agent", {
      format: "text",
      content: "Hello, can you help me with api.md?",
    });
    expect(msg1.id).toBeDefined();
    const chatId = msg1.chatId;

    // 3. Set up receiver's SessionManager with test handler
    const events: LifecycleEvent[] = [];
    const testHandler = createTestHandler(events);
    const factory: HandlerFactory = () => testHandler;

    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/e2e-test" },
      agentIdentity: {
        agentId: receiverIdentity.agentId,
        displayName: receiverIdentity.displayName,
        type: receiverIdentity.type ?? "autonomous_agent",
        delegateMention: receiverIdentity.delegateMention ?? null,
        profile: receiverIdentity.profile ?? null,
        metadata: receiverIdentity.metadata ?? {},
      },
      sdk: receiverSdk,
      log: (msg) => process.stderr.write(`[e2e-receiver] ${msg}\n`),
    });

    // 4. Pull inbox and dispatch to SessionManager (simulating AgentSlot)
    const pull1 = await receiverSdk.pull(10);
    expect(pull1.entries.length).toBe(1);
    expect(pull1.entries[0]?.message.content).toBe("Hello, can you help me with api.md?");

    await sm.dispatch(entry(pull1.entries, 0));

    // Verify: handler.start was called
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "start",
      chatId,
      content: "Hello, can you help me with api.md?",
    });

    // 5. Verify immediate ACK — pull again should return empty
    const pull2 = await receiverSdk.pull(10);
    expect(pull2.entries.length).toBe(0);

    // 6. Send second message to the same chat → should inject into active session
    await senderSdk.sendMessage(chatId, {
      format: "text",
      content: "also add error handling",
    });

    const pull3 = await receiverSdk.pull(10);
    expect(pull3.entries.length).toBe(1);

    await sm.dispatch(entry(pull3.entries, 0));

    // Verify: handler.inject was called (not start — same session)
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "inject",
      content: "also add error handling",
    });

    // 7. Send third message to verify continued injection
    await senderSdk.sendMessage(chatId, {
      format: "text",
      content: "and add tests",
    });

    const pull4 = await receiverSdk.pull(10);
    expect(pull4.entries.length).toBe(1);
    await sm.dispatch(entry(pull4.entries, 0));

    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ type: "inject", content: "and add tests" });

    // 8. Shutdown SessionManager — should call handler.shutdown
    await sm.shutdown();

    expect(events).toHaveLength(4);
    expect(events[3]).toMatchObject({ type: "shutdown" });
  });

  it("separate sessions for different chats", async () => {
    const sender = await createTestAgent(app, { id: "sender-2", displayName: "Sender" });
    const receiver = await createTestAgent(app, { id: "receiver-2", displayName: "Receiver" });
    const otherAgent = await createTestAgent(app, { id: "other-agent", displayName: "Other" });

    const senderSdk = new FirstTreeHubSDK({ serverUrl: address, token: sender.token });
    const otherSdk = new FirstTreeHubSDK({ serverUrl: address, token: otherAgent.token });
    const receiverSdk = new FirstTreeHubSDK({ serverUrl: address, token: receiver.token });

    // Create handlers per session (factory creates new handler each time)
    const allEvents: Array<{ handler: number; event: LifecycleEvent }> = [];
    let handlerCount = 0;

    const factory: HandlerFactory = () => {
      const idx = handlerCount++;
      const events: LifecycleEvent[] = [];
      const handler = createTestHandler(events);

      // Wrap to capture events with handler index
      return {
        async start(msg: SessionMessage, ctx: SessionContext) {
          const result = await handler.start(msg, ctx);
          allEvents.push({ handler: idx, event: events[events.length - 1] as LifecycleEvent });
          return result;
        },
        async resume(msg: SessionMessage, sid: string, ctx: SessionContext) {
          const result = await handler.resume(msg, sid, ctx);
          allEvents.push({ handler: idx, event: events[events.length - 1] as LifecycleEvent });
          return result;
        },
        inject(msg: SessionMessage) {
          handler.inject(msg);
          allEvents.push({ handler: idx, event: events[events.length - 1] as LifecycleEvent });
        },
        async suspend() {
          await handler.suspend();
          allEvents.push({ handler: idx, event: events[events.length - 1] as LifecycleEvent });
        },
        async shutdown() {
          await handler.shutdown();
          allEvents.push({ handler: idx, event: events[events.length - 1] as LifecycleEvent });
        },
      };
    };

    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/e2e-test" },
      agentIdentity: {
        agentId: "receiver-2",
        displayName: "Receiver",
        type: "autonomous_agent",
        delegateMention: null,
        profile: null,
        metadata: {},
      },
      sdk: receiverSdk,
      log: () => {},
    });

    // Send messages from two different agents → two different chats
    await senderSdk.sendToAgent("receiver-2", { format: "text", content: "msg from sender" });
    await otherSdk.sendToAgent("receiver-2", { format: "text", content: "msg from other" });

    const pull = await receiverSdk.pull(10);
    expect(pull.entries.length).toBe(2);

    for (const entry of pull.entries) {
      await sm.dispatch(entry);
    }

    // Two separate handler instances should have been created
    expect(handlerCount).toBe(2);

    // Each handler got a start call
    const startEvents = allEvents.filter((e) => e.event.type === "start");
    expect(startEvents).toHaveLength(2);
    expect(startEvents[0]?.handler).toBe(0);
    expect(startEvents[1]?.handler).toBe(1);

    await sm.shutdown();
  });

  it("deduplicates redelivered messages", async () => {
    const sender = await createTestAgent(app, { id: "sender-3" });
    const receiver = await createTestAgent(app, { id: "receiver-3" });

    const senderSdk = new FirstTreeHubSDK({ serverUrl: address, token: sender.token });
    const receiverSdk = new FirstTreeHubSDK({ serverUrl: address, token: receiver.token });

    const events: LifecycleEvent[] = [];
    const factory: HandlerFactory = () => createTestHandler(events);

    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/e2e-test" },
      agentIdentity: {
        agentId: "receiver-3",
        displayName: null,
        type: "autonomous_agent",
        delegateMention: null,
        profile: null,
        metadata: {},
      },
      sdk: receiverSdk,
      log: () => {},
    });

    await senderSdk.sendToAgent("receiver-3", { format: "text", content: "hello" });

    const pull = await receiverSdk.pull(10);
    expect(pull.entries.length).toBe(1);

    // Dispatch the same entry twice (simulating at-least-once redelivery)
    const firstEntry = entry(pull.entries, 0);
    await sm.dispatch(firstEntry);
    await sm.dispatch(firstEntry);

    // Only one start call — second was deduplicated
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);

    await sm.shutdown();
  });

  it("immediate ACK ensures message is consumed from inbox", async () => {
    const sender = await createTestAgent(app, { id: "sender-4" });
    const receiver = await createTestAgent(app, { id: "receiver-4" });

    const senderSdk = new FirstTreeHubSDK({ serverUrl: address, token: sender.token });
    const receiverSdk = new FirstTreeHubSDK({ serverUrl: address, token: receiver.token });

    const events: LifecycleEvent[] = [];
    const factory: HandlerFactory = () => createTestHandler(events);

    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/e2e-test" },
      agentIdentity: {
        agentId: "receiver-4",
        displayName: null,
        type: "autonomous_agent",
        delegateMention: null,
        profile: null,
        metadata: {},
      },
      sdk: receiverSdk,
      log: () => {},
    });

    // Send 3 messages
    await senderSdk.sendToAgent("receiver-4", { format: "text", content: "msg1" });
    await senderSdk.sendToAgent("receiver-4", { format: "text", content: "msg2" });
    await senderSdk.sendToAgent("receiver-4", { format: "text", content: "msg3" });

    const pull = await receiverSdk.pull(10);
    expect(pull.entries.length).toBe(3);

    // Dispatch all
    for (const entry of pull.entries) {
      await sm.dispatch(entry);
    }

    // All 3 ACKed — pull returns empty
    const pull2 = await receiverSdk.pull(10);
    expect(pull2.entries.length).toBe(0);

    // Handler: 1 start + 2 injects (all same chat from sendToAgent)
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "inject")).toHaveLength(2);

    await sm.shutdown();
  });

  it("idle suspend → resume preserves session identity", async () => {
    const sender = await createTestAgent(app, { id: "sender-6" });
    const receiver = await createTestAgent(app, { id: "receiver-6" });

    const senderSdk = new FirstTreeHubSDK({ serverUrl: address, token: sender.token });
    const receiverSdk = new FirstTreeHubSDK({ serverUrl: address, token: receiver.token });

    const events: LifecycleEvent[] = [];
    const testHandler = createTestHandler(events);
    const factory: HandlerFactory = () => testHandler;

    // Use a very short idle timeout (1 second)
    const sm = new SessionManager({
      session: { idle_timeout: 1, max_sessions: 10 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/e2e-test" },
      agentIdentity: {
        agentId: "receiver-6",
        displayName: null,
        type: "autonomous_agent",
        delegateMention: null,
        profile: null,
        metadata: {},
      },
      sdk: receiverSdk,
      log: () => {},
    });

    // 1. Send first message → start
    await senderSdk.sendToAgent("receiver-6", { format: "text", content: "first message" });
    const pull1 = await receiverSdk.pull(10);
    await sm.dispatch(entry(pull1.entries, 0));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "start", content: "first message" });

    // Capture the sessionId returned by start()
    const startEvent = events[0] as { type: "start"; chatId: string; content: string };
    const chatId = startEvent.chatId;

    // 2. Wait for idle timeout to trigger suspend (1s timeout + 10s check interval)
    // Force idle check by waiting just over the timeout, then dispatching which
    // triggers internal routing. Instead, we wait for the evictIdle timer.
    await new Promise((r) => setTimeout(r, 11_500));

    // Verify suspend was called
    const suspendEvents = events.filter((e) => e.type === "suspend");
    expect(suspendEvents.length).toBeGreaterThanOrEqual(1);

    // 3. Send another message to the same chat → should resume (not start)
    await senderSdk.sendMessage(chatId, { format: "text", content: "after idle" });
    const pull2 = await receiverSdk.pull(10);
    expect(pull2.entries.length).toBe(1);
    await sm.dispatch(entry(pull2.entries, 0));

    // Verify resume was called with the same sessionId
    const resumeEvents = events.filter((e) => e.type === "resume");
    expect(resumeEvents.length).toBe(1);
    const resumeEvent = resumeEvents[0] as { type: "resume"; chatId: string; sessionId: string };
    expect(resumeEvent.chatId).toBe(chatId);
    // sessionId should match the one from start (test handler uses `test-session-<ts>`)
    expect(resumeEvent.sessionId).toBeDefined();

    await sm.shutdown();
  }, 20_000);

  it("concurrency limit suspends oldest idle and drains pending queue", async () => {
    const sender = await createTestAgent(app, { id: "sender-7" });
    const receiver = await createTestAgent(app, { id: "receiver-7" });
    const other1 = await createTestAgent(app, { id: "other-7a" });
    const other2 = await createTestAgent(app, { id: "other-7b" });

    const senderSdk = new FirstTreeHubSDK({ serverUrl: address, token: sender.token });
    const other1Sdk = new FirstTreeHubSDK({ serverUrl: address, token: other1.token });
    const other2Sdk = new FirstTreeHubSDK({ serverUrl: address, token: other2.token });
    const receiverSdk = new FirstTreeHubSDK({ serverUrl: address, token: receiver.token });

    const allEvents: Array<{ handler: number; event: LifecycleEvent }> = [];
    let handlerCount = 0;

    const factory: HandlerFactory = () => {
      const idx = handlerCount++;
      const events: LifecycleEvent[] = [];
      const handler = createTestHandler(events);
      return {
        async start(msg: SessionMessage, ctx: SessionContext) {
          const result = await handler.start(msg, ctx);
          allEvents.push({ handler: idx, event: events[events.length - 1] as LifecycleEvent });
          return result;
        },
        async resume(msg: SessionMessage, sid: string, ctx: SessionContext) {
          const result = await handler.resume(msg, sid, ctx);
          allEvents.push({ handler: idx, event: events[events.length - 1] as LifecycleEvent });
          return result;
        },
        inject(msg: SessionMessage) {
          handler.inject(msg);
          allEvents.push({ handler: idx, event: events[events.length - 1] as LifecycleEvent });
        },
        async suspend() {
          await handler.suspend();
          allEvents.push({ handler: idx, event: events[events.length - 1] as LifecycleEvent });
        },
        async shutdown() {
          await handler.shutdown();
          allEvents.push({ handler: idx, event: events[events.length - 1] as LifecycleEvent });
        },
      };
    };

    // concurrency = 2: only 2 active sessions at a time
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10 },
      concurrency: 2,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/e2e-test" },
      agentIdentity: {
        agentId: "receiver-7",
        displayName: null,
        type: "autonomous_agent",
        delegateMention: null,
        profile: null,
        metadata: {},
      },
      sdk: receiverSdk,
      log: () => {},
    });

    // Send 3 messages from 3 different agents → 3 different chats
    await senderSdk.sendToAgent("receiver-7", { format: "text", content: "msg-from-sender" });
    await other1Sdk.sendToAgent("receiver-7", { format: "text", content: "msg-from-other1" });
    await other2Sdk.sendToAgent("receiver-7", { format: "text", content: "msg-from-other2" });

    const pull = await receiverSdk.pull(10);
    expect(pull.entries.length).toBe(3);

    // Dispatch all 3
    for (const e of pull.entries) {
      await sm.dispatch(e);
    }

    // All 3 should have been started (oldest was preempted for the third)
    const startEvents = allEvents.filter((e) => e.event.type === "start");
    expect(startEvents.length).toBe(3);

    // At least one suspend should have occurred (preemption)
    const suspendEvents = allEvents.filter((e) => e.event.type === "suspend");
    expect(suspendEvents.length).toBeGreaterThanOrEqual(1);

    // Active count should be at most concurrency limit
    expect(sm.activeCount).toBeLessThanOrEqual(2);

    await sm.shutdown();
  });

  it("evicted session resumes (not starts) when new message arrives", async () => {
    const sender = await createTestAgent(app, { id: "sender-8" });
    const receiver = await createTestAgent(app, { id: "receiver-8" });
    const other1 = await createTestAgent(app, { id: "other-8a" });
    const other2 = await createTestAgent(app, { id: "other-8b" });

    const senderSdk = new FirstTreeHubSDK({ serverUrl: address, token: sender.token });
    const other1Sdk = new FirstTreeHubSDK({ serverUrl: address, token: other1.token });
    const other2Sdk = new FirstTreeHubSDK({ serverUrl: address, token: other2.token });
    const receiverSdk = new FirstTreeHubSDK({ serverUrl: address, token: receiver.token });

    const lifecycleCalls: Array<{ type: string; chatId: string; sessionId?: string }> = [];

    const factory: HandlerFactory = () => ({
      async start(msg: SessionMessage, _ctx: SessionContext) {
        const sid = `session-for-${msg.chatId}`;
        lifecycleCalls.push({ type: "start", chatId: msg.chatId });
        return sid;
      },
      async resume(msg: SessionMessage, sessionId: string, _ctx: SessionContext) {
        lifecycleCalls.push({ type: "resume", chatId: msg.chatId, sessionId });
        return sessionId;
      },
      inject(msg: SessionMessage) {
        lifecycleCalls.push({ type: "inject", chatId: msg.chatId });
      },
      async suspend() {
        lifecycleCalls.push({ type: "suspend", chatId: "" });
      },
      async shutdown() {
        lifecycleCalls.push({ type: "shutdown", chatId: "" });
      },
    });

    // max_sessions = 2: third chat will evict the oldest
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 2 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/e2e-test" },
      agentIdentity: {
        agentId: "receiver-8",
        displayName: null,
        type: "autonomous_agent",
        delegateMention: null,
        profile: null,
        metadata: {},
      },
      sdk: receiverSdk,
      log: () => {},
    });

    // 1. Create chat-A (sender → receiver)
    const msgA = await senderSdk.sendToAgent("receiver-8", { format: "text", content: "hello from A" });
    const chatA = msgA.chatId;
    const pullA = await receiverSdk.pull(10);
    await sm.dispatch(entry(pullA.entries, 0));

    // 2. Create chat-B (other1 → receiver)
    await other1Sdk.sendToAgent("receiver-8", { format: "text", content: "hello from B" });
    const pullB = await receiverSdk.pull(10);
    await sm.dispatch(entry(pullB.entries, 0));

    expect(sm.totalCount).toBe(2);

    // 3. Create chat-C (other2 → receiver) — evicts chat-A (LRU)
    await other2Sdk.sendToAgent("receiver-8", { format: "text", content: "hello from C" });
    const pullC = await receiverSdk.pull(10);
    await sm.dispatch(entry(pullC.entries, 0));

    expect(sm.totalCount).toBe(2);

    // 4. Send a new message to evicted chat-A → should resume, not start
    await senderSdk.sendMessage(chatA, { format: "text", content: "are you still there?" });
    const pullResume = await receiverSdk.pull(10);
    expect(pullResume.entries.length).toBe(1);
    await sm.dispatch(entry(pullResume.entries, 0));

    // Debug: dump all lifecycle calls and logs
    const chatAEvents = lifecycleCalls.filter((e) => e.chatId === chatA);
    const chatAStartCount = chatAEvents.filter((e) => e.type === "start").length;
    const chatAResumeCount = chatAEvents.filter((e) => e.type === "resume").length;

    expect(chatAStartCount).toBe(1);
    expect(chatAResumeCount).toBe(1);

    // Verify the resume used the original sessionId
    const resumeEvent = chatAEvents.find((e) => e.type === "resume");
    expect(resumeEvent?.sessionId).toBe(`session-for-${chatA}`);

    await sm.shutdown();
  });

  it("handler receives SessionContext with correct fields", async () => {
    const sender = await createTestAgent(app, { id: "sender-5" });
    const receiver = await createTestAgent(app, { id: "receiver-5" });

    const senderSdk = new FirstTreeHubSDK({ serverUrl: address, token: sender.token });
    const receiverSdk = new FirstTreeHubSDK({ serverUrl: address, token: receiver.token });

    const captured: { ctx: SessionContext | null; message: SessionMessage | null } = {
      ctx: null,
      message: null,
    };

    const factory: HandlerFactory = () => ({
      async start(msg: SessionMessage, ctx: SessionContext) {
        captured.ctx = ctx;
        captured.message = msg;
        return "test-session-id";
      },
      async resume() {
        return "test-session-id";
      },
      inject() {},
      async suspend() {},
      async shutdown() {},
    });

    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/e2e-test" },
      agentIdentity: {
        agentId: "receiver-5",
        displayName: "Receiver Five",
        type: "autonomous_agent",
        delegateMention: null,
        profile: null,
        metadata: {},
      },
      sdk: receiverSdk,
      log: () => {},
    });

    await senderSdk.sendToAgent("receiver-5", { format: "text", content: "context test" });

    const pull = await receiverSdk.pull(10);
    await sm.dispatch(entry(pull.entries, 0));

    // Verify SessionContext
    const ctx = captured.ctx;
    expect(ctx).not.toBeNull();
    expect(ctx?.agent.agentId).toBe("receiver-5");
    expect(ctx?.agent.displayName).toBe("Receiver Five");
    expect(ctx?.chatId).toBeDefined();
    expect(typeof ctx?.touch).toBe("function");
    expect(typeof ctx?.log).toBe("function");
    expect(ctx?.sdk).toBe(receiverSdk);

    // Verify SessionMessage (no inbox entry metadata)
    const msg = captured.message;
    expect(msg).not.toBeNull();
    expect(msg?.content).toBe("context test");
    expect(msg?.format).toBe("text");
    expect(msg?.senderId).toBe("sender-5");
    expect(msg?.chatId).toBeDefined();
    expect(msg?.id).toBeDefined();

    await sm.shutdown();
  });
});
