import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ClientConnection } from "../client-connection.js";
import { AgentSlot } from "../runtime/agent-slot.js";
import type { AgentHandler, HandlerFactory } from "../runtime/handler.js";
import type { RegisterResult } from "../sdk.js";

function createMockHandler(): AgentHandler {
  return {
    start: vi.fn().mockResolvedValue("session-id"),
    resume: vi.fn().mockResolvedValue("session-id"),
    inject: vi.fn(),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

/** Create a mock ClientConnection that resolves bindAgent with the given register result. */
function createMockClientConnection(registerResult: RegisterResult) {
  const mockSdk = {
    register: vi.fn().mockResolvedValue(registerResult),
    pull: vi.fn().mockResolvedValue({ entries: [] }),
    ack: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(),
    sendToAgent: vi.fn(),
    renew: vi.fn(),
    serverUrl: "http://localhost:8000",
    agentToken: "test-token",
  };

  const emitter = new EventEmitter();
  const conn = Object.assign(emitter, {
    clientId: "test-client",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    bindAgent: vi.fn().mockResolvedValue({
      agentId: registerResult.agentId,
      sdk: mockSdk,
    }),
    unbindAgent: vi.fn().mockResolvedValue(undefined),
    reportSessionState: vi.fn(),
    reportRuntimeState: vi.fn(),
    reportSessionOutput: vi.fn(),
    removeListener: vi.fn(),
  }) as unknown as ClientConnection;

  return { conn, mockSdk };
}

describe("AgentSlot human agent guard", () => {
  it("skips SessionManager and event listeners when server reports type=human", async () => {
    const humanResult: RegisterResult = {
      agentId: "agent-human-1",
      inboxId: "inbox-1",
      status: "active",
      displayName: "Human User",
      type: "human",
      delegateMention: null,
      profile: null,
      metadata: {},
    };

    const { conn, mockSdk } = createMockClientConnection(humanResult);
    const handler = createMockHandler();
    const handlerFactory: HandlerFactory = () => handler;

    const slot = new AgentSlot({
      name: "test-human",
      serverUrl: "http://localhost:8000",
      token: "test-token",
      type: "claude-code",
      handlerFactory,
      session: { idle_timeout: 300, max_sessions: 10 },
      concurrency: 5,
      clientConnection: conn,
    });

    const result = await slot.start();

    // Should return the register result
    expect(result.agentId).toBe("agent-human-1");
    expect(result.type).toBe("human");

    // Handler should NOT have been called — no SessionManager created
    expect(handler.start).not.toHaveBeenCalled();

    // No event listeners should be registered on the connection
    // (agent:message, agent:bound are registered AFTER the human check)
    expect(conn.listenerCount("agent:message")).toBe(0);
    expect(conn.listenerCount("agent:bound")).toBe(0);

    // SDK pull should NOT have been called (no polling started)
    expect(mockSdk.pull).not.toHaveBeenCalled();

    await slot.stop();
  });

  it("initializes SessionManager and listeners for non-human agents", async () => {
    const assistantResult: RegisterResult = {
      agentId: "agent-assistant-1",
      inboxId: "inbox-1",
      status: "active",
      displayName: "Assistant",
      type: "personal_assistant",
      delegateMention: null,
      profile: null,
      metadata: {},
    };

    const { conn } = createMockClientConnection(assistantResult);
    const handler = createMockHandler();
    const handlerFactory: HandlerFactory = () => handler;

    const slot = new AgentSlot({
      name: "test-assistant",
      serverUrl: "http://localhost:8000",
      token: "test-token",
      type: "claude-code",
      handlerFactory,
      session: { idle_timeout: 300, max_sessions: 10 },
      concurrency: 5,
      clientConnection: conn,
    });

    const result = await slot.start();

    expect(result.type).toBe("personal_assistant");

    // Event listeners SHOULD be registered for non-human agents
    expect(conn.listenerCount("agent:message")).toBeGreaterThan(0);
    expect(conn.listenerCount("agent:bound")).toBeGreaterThan(0);

    await slot.stop();
  });
});
