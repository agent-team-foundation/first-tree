import { afterEach, describe, expect, it } from "vitest";
import {
  invalidateChatAudience,
  invalidateChatAudienceLocal,
  registerChatAudienceDispatcher,
  resetChatAudienceDispatcher,
} from "../services/chat-audience-cache.js";

describe("chat-audience-cache cross-replica invalidation", () => {
  afterEach(() => resetChatAudienceDispatcher());

  it("invalidateChatAudience fans the invalidation out to the registered dispatcher", () => {
    const dispatched: string[] = [];
    registerChatAudienceDispatcher((chatId) => dispatched.push(chatId));
    invalidateChatAudience("chat-1");
    expect(dispatched).toEqual(["chat-1"]);
  });

  it("invalidateChatAudienceLocal drops locally WITHOUT fanning out (prevents NOTIFY loops)", () => {
    const dispatched: string[] = [];
    registerChatAudienceDispatcher((chatId) => dispatched.push(chatId));
    invalidateChatAudienceLocal("chat-1");
    expect(dispatched).toEqual([]);
  });

  it("a throwing dispatcher does not propagate (fan-out is best-effort)", () => {
    registerChatAudienceDispatcher(() => {
      throw new Error("notify failed");
    });
    expect(() => invalidateChatAudience("chat-1")).not.toThrow();
  });

  it("is a no-op when no dispatcher is registered (single-process / tests)", () => {
    resetChatAudienceDispatcher();
    expect(() => invalidateChatAudience("chat-1")).not.toThrow();
  });
});
