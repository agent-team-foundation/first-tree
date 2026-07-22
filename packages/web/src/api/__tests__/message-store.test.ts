import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageWithDelivery } from "../chats.js";

// The store namespaces its database per account (SEC-042). Tests control the
// identity through this mock rather than seeding real tokens, because this
// suite runs in the node environment where localStorage is process-global
// and would leak identity across tests. The real token → sub decode chain is
// covered by the purge-local-data and auth-context-provider suites.
const identityMock = vi.hoisted(() => ({ userId: "user-1" as string | null }));

vi.mock("../../lib/current-user-id.js", () => ({
  currentUserIdFromToken: () => identityMock.userId,
  lastKnownUserId: () => identityMock.userId,
}));

beforeEach(() => {
  identityMock.userId = "user-1";
});

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

async function listDatabaseNames(): Promise<string[]> {
  const dbs = await indexedDB.databases();
  return dbs
    .map((d) => d.name)
    .filter((n): n is string => typeof n === "string")
    .sort();
}

/** Create (and close) a database so it exists on disk without any open
 *  connection — used to fake a pre-namespacing legacy database. */
function seedDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("rows");
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error ?? new Error("seed open failed"));
  });
}

/** Delete a database, reporting whether the delete had to wait on a blocked
 *  phase before completing. */
function deleteDb(name: string): Promise<"success" | "blocked-then-success"> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    let blocked = false;
    req.onblocked = () => {
      blocked = true;
    };
    req.onsuccess = () => resolve(blocked ? "blocked-then-success" : "success");
    req.onerror = () => reject(req.error ?? new Error("delete failed"));
  });
}

describe("message-store / per-account namespacing (SEC-042)", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("stores rows in a database named for the current account", async () => {
    const { cacheMessages } = await loadStore();
    await cacheMessages("chat-1", [msg("a", T(1))]);
    expect(await listDatabaseNames()).toEqual(["first-tree-chat-cache:u:user-1"]);
  });

  it("isolates accounts — after an in-page identity switch the other account's rows are invisible", async () => {
    const { cacheMessages, getCachedMessages } = await loadStore();
    await cacheMessages("chat-1", [msg("a", T(1))]);

    identityMock.userId = "user-2";
    expect(await getCachedMessages("chat-1")).toEqual([]);

    identityMock.userId = "user-1";
    expect((await getCachedMessages("chat-1")).map((m) => m.id)).toEqual(["a"]);
  });

  it("does not create any database when signed out — writes no-op, reads return empty", async () => {
    const { cacheMessages, getCachedMessages } = await loadStore();
    identityMock.userId = null;
    await cacheMessages("chat-1", [msg("a", T(1))]);
    expect(await getCachedMessages("chat-1")).toEqual([]);
    expect(await listDatabaseNames()).toEqual([]);
  });

  it("requests deletion of the legacy database once per session on first namespaced open", async () => {
    const { cacheMessages } = await loadStore();
    await seedDb("first-tree-chat-cache");
    const spy = vi.spyOn(indexedDB, "deleteDatabase");

    await cacheMessages("chat-1", [msg("a", T(1))]);
    expect(spy.mock.calls.filter(([name]) => name === "first-tree-chat-cache")).toHaveLength(1);

    // Second write in the same session must not request it again.
    await cacheMessages("chat-1", [msg("b", T(2))]);
    expect(spy.mock.calls.filter(([name]) => name === "first-tree-chat-cache")).toHaveLength(1);

    // The fire-and-forget delete eventually lands: only the namespaced
    // database remains.
    for (let i = 0; i < 20 && (await listDatabaseNames()).includes("first-tree-chat-cache"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(await listDatabaseNames()).toEqual(["first-tree-chat-cache:u:user-1"]);
  });

  it("closeDbForPurge closes the connection so a later deleteDatabase completes unblocked", async () => {
    const { cacheMessages, closeDbForPurge } = await loadStore();
    await cacheMessages("chat-1", [msg("a", T(1))]);

    closeDbForPurge();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(deleteDb("first-tree-chat-cache:u:user-1")).resolves.toBe("success");
  });

  it("closes automatically on versionchange when another context deletes the database", async () => {
    const { cacheMessages } = await loadStore();
    await cacheMessages("chat-1", [msg("a", T(1))]);

    // No closeDbForPurge: the module still holds its connection, so the
    // delete below can only complete because the versionchange handler
    // closes it (the multi-tab purge path).
    await expect(deleteDb("first-tree-chat-cache:u:user-1")).resolves.toBe("success");
  });

  it("does not recreate any database when a pending poll write lands after logout", async () => {
    const { cacheMessages, closeDbForPurge } = await loadStore();
    await cacheMessages("chat-1", [msg("a", T(1))]);

    // Simulate logout + purge: tokens cleared (identity now null),
    // connections closed, databases deleted.
    identityMock.userId = null;
    closeDbForPurge();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await deleteDb("first-tree-chat-cache:u:user-1");

    // The 5-second poll's write-through resolves late, after the purge.
    await cacheMessages("chat-1", [msg("b", T(2))]);
    expect(await listDatabaseNames()).toEqual([]);
  });
});
