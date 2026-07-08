import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/connection.js";
import {
  getCachedAudience,
  invalidateChatAudience,
  invalidateChatAudienceLocal,
  registerChatAudienceDispatcher,
  resetChatAudienceDispatcher,
} from "../services/chat-audience-cache.js";

const touchedChatIds = new Set<string>();

function remember(chatId: string): string {
  touchedChatIds.add(chatId);
  return chatId;
}

describe("chat-audience-cache cross-replica invalidation", () => {
  afterEach(() => {
    for (const chatId of touchedChatIds) invalidateChatAudienceLocal(chatId);
    touchedChatIds.clear();
    resetChatAudienceDispatcher();
    vi.restoreAllMocks();
  });

  function dbWithRows(rows: Array<{ agent_id: string }>): { db: Database; execute: ReturnType<typeof vi.fn> } {
    const execute = vi.fn().mockResolvedValue(rows);
    return { db: { execute } as unknown as Database, execute };
  }

  it("resolves and caches a chat audience until invalidated", async () => {
    const { db, execute } = dbWithRows([{ agent_id: "agent-1" }, { agent_id: "agent-2" }]);
    const chatId = remember("chat-cache-hit");

    const first = await getCachedAudience(db, chatId);
    const second = await getCachedAudience(db, chatId);

    expect(first).toEqual(new Set(["agent-1", "agent-2"]));
    expect(second).toBe(first);
    expect(execute).toHaveBeenCalledTimes(1);

    invalidateChatAudienceLocal(chatId);
    const third = await getCachedAudience(db, chatId);
    expect(third).toEqual(new Set(["agent-1", "agent-2"]));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("returns null when audience lookup fails", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("db down"));
    const db = { execute } as unknown as Database;

    await expect(getCachedAudience(db, remember("chat-cache-error"))).resolves.toBeNull();
  });

  it("drops expired entries opportunistically after the cache grows past the cap", async () => {
    const execute = vi.fn().mockResolvedValue([{ agent_id: "agent" }]);
    const db = { execute } as unknown as Database;
    const now = vi.spyOn(Date, "now");

    now.mockReturnValue(1_000);
    for (let i = 0; i < 1024; i++) {
      await getCachedAudience(db, remember(`chat-cache-expired-${i}`));
    }

    now.mockReturnValue(10_000);
    const freshChatId = remember("chat-cache-fresh-after-cleanup");
    const fresh = await getCachedAudience(db, freshChatId);
    const cached = await getCachedAudience(db, freshChatId);

    expect(fresh).toEqual(new Set(["agent"]));
    expect(cached).toBe(fresh);
    expect(execute).toHaveBeenCalledTimes(1025);
  });

  it("invalidateChatAudience fans the invalidation out to the registered dispatcher", () => {
    const dispatched: string[] = [];
    registerChatAudienceDispatcher((chatId) => dispatched.push(chatId));
    invalidateChatAudience(remember("chat-1"));
    expect(dispatched).toEqual(["chat-1"]);
  });

  it("invalidateChatAudienceLocal drops locally WITHOUT fanning out (prevents NOTIFY loops)", () => {
    const dispatched: string[] = [];
    registerChatAudienceDispatcher((chatId) => dispatched.push(chatId));
    invalidateChatAudienceLocal(remember("chat-1"));
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
