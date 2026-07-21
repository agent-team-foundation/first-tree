import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageWithDelivery } from "../chats.js";

function msg(id: string, createdAt: string, overrides: Partial<MessageWithDelivery> = {}): MessageWithDelivery {
  return {
    id,
    chatId: "chat-1",
    senderId: "user-1",
    format: "text",
    content: { text: id },
    metadata: {},
    inReplyTo: null,
    source: "web",
    createdAt,
    ...overrides,
  };
}

const T = (s: number) => new Date(2026, 0, 1, 0, 0, s).toISOString();

// `message-store` caches its DB open across calls (module-scoped
// `dbPromise`). Reset the module + give each test a fresh fake IDB so the
// cache-from-prior-test does not leak into the next.
async function loadStore() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  return import("../message-store.js");
}

describe("message-store / getCachedMessages", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("returns [] on cold cache", async () => {
    const { getCachedMessages } = await loadStore();
    expect(await getCachedMessages("chat-1")).toEqual([]);
  });

  it("returns [] when IndexedDB is unavailable", async () => {
    vi.resetModules();
    // Simulate a browser without IndexedDB — `typeof indexedDB === "undefined"`.
    // Use `delete` rather than assigning `undefined` so the typeof check fires.
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    const { getCachedMessages, cacheMessages } = await import("../message-store.js");
    await cacheMessages("chat-1", [msg("a", T(1))]);
    expect(await getCachedMessages("chat-1")).toEqual([]);
  });

  it("returns rows ordered ascending by createdAt regardless of insert order", async () => {
    const { cacheMessages, getCachedMessages } = await loadStore();
    await cacheMessages("chat-1", [msg("c", T(3)), msg("a", T(1)), msg("b", T(2))]);
    const rows = await getCachedMessages("chat-1");
    expect(rows.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("scopes results to the requested chatId", async () => {
    const { cacheMessages, getCachedMessages } = await loadStore();
    await cacheMessages("chat-1", [msg("a", T(1))]);
    await cacheMessages("chat-2", [msg("b", T(2), { chatId: "chat-2" })]);
    expect((await getCachedMessages("chat-1")).map((m) => m.id)).toEqual(["a"]);
    expect((await getCachedMessages("chat-2")).map((m) => m.id)).toEqual(["b"]);
  });
});

describe("message-store / cacheMessages", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("is a no-op on empty input", async () => {
    const { cacheMessages, getCachedMessages } = await loadStore();
    await cacheMessages("chat-1", []);
    expect(await getCachedMessages("chat-1")).toEqual([]);
  });

  it("upserts idempotently — repeated writes overwrite", async () => {
    const { cacheMessages, getCachedMessages } = await loadStore();
    await cacheMessages("chat-1", [msg("a", T(1), { content: { text: "v1" } })]);
    await cacheMessages("chat-1", [msg("a", T(1), { content: { text: "v2" } })]);
    const rows = await getCachedMessages("chat-1");
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toBeDefined();
    expect((row?.content as { text: string }).text).toBe("v2");
  });

  it("defensively skips messages whose chatId doesn't match the call's chatId", async () => {
    const { cacheMessages, getCachedMessages } = await loadStore();
    await cacheMessages("chat-1", [msg("a", T(1)), msg("rogue", T(2), { chatId: "chat-other" })]);
    const rows = await getCachedMessages("chat-1");
    expect(rows.map((m) => m.id)).toEqual(["a"]);
    expect(await getCachedMessages("chat-other")).toEqual([]);
  });
});

describe("message-store / clearChatCache", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("removes only the targeted chat's rows", async () => {
    const { cacheMessages, clearChatCache, getCachedMessages } = await loadStore();
    await cacheMessages("chat-1", [msg("a", T(1)), msg("b", T(2))]);
    await cacheMessages("chat-2", [msg("c", T(3), { chatId: "chat-2" })]);
    await clearChatCache("chat-1");
    expect(await getCachedMessages("chat-1")).toEqual([]);
    expect((await getCachedMessages("chat-2")).map((m) => m.id)).toEqual(["c"]);
  });

  it("is a no-op when the chat has no cached rows", async () => {
    const { clearChatCache, getCachedMessages } = await loadStore();
    await clearChatCache("chat-1");
    expect(await getCachedMessages("chat-1")).toEqual([]);
  });
});

describe("message-store / storage namespace (SEC-042)", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  async function loadStoreWithScope() {
    vi.resetModules();
    globalThis.indexedDB = new IDBFactory();
    const scope = await import("../storage-scope.js");
    const store = await import("../message-store.js");
    return { scope, store };
  }

  it("isolates cached messages between account namespaces", async () => {
    const { scope, store } = await loadStoreWithScope();
    scope.setStorageNamespace("user-a");
    await store.cacheMessages("chat-1", [msg("a-1", T(1))]);

    // A different account on the same browser sees none of user-a's rows.
    scope.setStorageNamespace("user-b");
    expect(await store.getCachedMessages("chat-1")).toEqual([]);
    await store.cacheMessages("chat-1", [msg("b-1", T(2))]);

    // ...and switching back and forth keeps each account's cache intact.
    scope.setStorageNamespace("user-a");
    expect((await store.getCachedMessages("chat-1")).map((m) => m.id)).toEqual(["a-1"]);
    scope.setStorageNamespace("user-b");
    expect((await store.getCachedMessages("chat-1")).map((m) => m.id)).toEqual(["b-1"]);
  });

  it("drops writes and empties reads once the namespace is purged", async () => {
    const { scope, store } = await loadStoreWithScope();
    scope.setStorageNamespace("user-a");
    await store.cacheMessages("chat-1", [msg("a-1", T(1))]);

    await scope.purgeAccountLocalData("user-a");

    // Late in-flight writes under the purged namespace are dropped, and
    // reads degrade to empty without throwing.
    await store.cacheMessages("chat-1", [msg("a-late", T(2))]);
    expect(await store.getCachedMessages("chat-1")).toEqual([]);
  });
});
