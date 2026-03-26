import { describe, expect, it } from "vitest";
import { registerBuiltinHandlers } from "../handlers/index.js";
import { getHandlerFactory } from "../runtime/handler.js";

describe("Built-in Handlers", () => {
  it("registers claude-code handler", () => {
    registerBuiltinHandlers();

    const factory = getHandlerFactory("claude-code");
    expect(factory).toBeDefined();
    expect(typeof factory).toBe("function");
  });

  it("claude-code factory returns a valid session-oriented handler", () => {
    registerBuiltinHandlers();

    const factory = getHandlerFactory("claude-code");
    const handler = factory({ cwd: "/tmp/test" });
    expect(handler).toBeDefined();
    expect(typeof handler.start).toBe("function");
    expect(typeof handler.resume).toBe("function");
    expect(typeof handler.inject).toBe("function");
    expect(typeof handler.suspend).toBe("function");
    expect(typeof handler.shutdown).toBe("function");
  });
});
