import { describe, expect, it, vi } from "vitest";
import type { AgentHandler, HandlerFactory } from "../runtime/handler.js";
import { getHandlerFactory, registerHandler } from "../runtime/handler.js";

function createMockHandler(): AgentHandler {
  return {
    start: vi.fn().mockResolvedValue("session-id"),
    resume: vi.fn().mockResolvedValue("session-id"),
    inject: vi.fn(),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Handler Registry", () => {
  const echoFactory: HandlerFactory = () => createMockHandler();

  it("registers and retrieves a handler factory", () => {
    registerHandler("echo", echoFactory);
    const factory = getHandlerFactory("echo");
    expect(factory).toBe(echoFactory);
  });

  it("throws for unknown handler type", () => {
    expect(() => getHandlerFactory("nonexistent-handler-type-xyz")).toThrow(/Unknown handler type/);
  });

  it("creates a handler with the factory", () => {
    registerHandler("test-handler", echoFactory);
    const factory = getHandlerFactory("test-handler");
    const handler = factory({ workspaceRoot: "/tmp" });
    expect(handler).toBeDefined();
    expect(typeof handler.start).toBe("function");
    expect(typeof handler.resume).toBe("function");
    expect(typeof handler.inject).toBe("function");
    expect(typeof handler.suspend).toBe("function");
    expect(typeof handler.shutdown).toBe("function");
  });
});
