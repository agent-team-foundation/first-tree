import { describe, expect, it } from "vitest";
import type { HandlerFactory } from "../runtime/handler.js";
import { getHandlerFactory, registerHandler } from "../runtime/handler.js";

describe("Handler Registry", () => {
  // We can't "unregister" handlers, but tests for the registry API itself
  const echoFactory: HandlerFactory = () => ({
    async handle(entry, ctx) {
      await ctx.sdk.sendMessage(entry.chatId ?? entry.message.chatId, {
        format: "text",
        content: `echo: ${entry.message.content}`,
      });
      await ctx.sdk.ack(entry.id);
    },
  });

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
    const handler = factory({});
    expect(handler).toBeDefined();
    expect(typeof handler.handle).toBe("function");
  });

  it("handler can have optional shutdown method", () => {
    const factoryWithShutdown: HandlerFactory = () => ({
      async handle() {},
      async shutdown() {},
    });
    registerHandler("with-shutdown", factoryWithShutdown);
    const handler = getHandlerFactory("with-shutdown")({});
    expect(typeof handler.shutdown).toBe("function");
  });

  it("handler shutdown is optional", () => {
    const factoryNoShutdown: HandlerFactory = () => ({
      async handle() {},
    });
    registerHandler("no-shutdown", factoryNoShutdown);
    const handler = getHandlerFactory("no-shutdown")({});
    expect(handler.shutdown).toBeUndefined();
  });
});
