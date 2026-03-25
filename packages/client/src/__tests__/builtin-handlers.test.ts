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

  it("claude-code factory returns a valid handler", () => {
    registerBuiltinHandlers();

    const factory = getHandlerFactory("claude-code");
    const handler = factory({});
    expect(handler).toBeDefined();
    expect(typeof handler.handle).toBe("function");
    expect(typeof handler.shutdown).toBe("function");
  });
});
