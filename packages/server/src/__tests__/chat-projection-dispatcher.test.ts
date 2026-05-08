import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fireChatMessageKick,
  registerChatMessageDispatcher,
  resetChatMessageDispatcher,
} from "../services/chat-projection.js";

describe("chat-projection dispatcher accessor", () => {
  afterEach(() => {
    resetChatMessageDispatcher();
  });

  it("invokes the registered dispatcher with chatId + messageId", () => {
    const fn = vi.fn();
    registerChatMessageDispatcher(fn);
    fireChatMessageKick("chat-1", "msg-1");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("chat-1", "msg-1");
  });

  it("is a no-op when no dispatcher is registered", () => {
    expect(() => fireChatMessageKick("chat-2", "msg-2")).not.toThrow();
  });

  it("swallows dispatcher errors so the message hot path is not poisoned", () => {
    registerChatMessageDispatcher(() => {
      throw new Error("PG NOTIFY failed");
    });
    expect(() => fireChatMessageKick("chat-3", "msg-3")).not.toThrow();
  });
});
