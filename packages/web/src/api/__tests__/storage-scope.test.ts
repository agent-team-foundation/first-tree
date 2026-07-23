// @vitest-environment happy-dom

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageWithDelivery } from "../chats.js";

/**
 * storage-scope is the SEC-042 hub: it derives the `<origin>#<userId>`
 * namespace every persistent store lives under, write-blocks purged
 * namespaces, and runs the logout purge. These tests exercise it together
 * with the REAL message/image/draft stores (same module graph, fresh per
 * test via `vi.resetModules`) — the account-switching scenario is the
 * issue 1647 acceptance criterion.
 */

const DRAFTS_STORAGE_KEY = "first-tree:chat-drafts:v1";

function msg(id: string, createdAt: string): MessageWithDelivery {
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
  };
}

const T = (s: number) => new Date(2026, 0, 1, 0, 0, s).toISOString();

async function loadModules() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  const scope = await import("../storage-scope.js");
  const messages = await import("../message-store.js");
  const images = await import("../image-store.js");
  const drafts = await import("../../lib/draft-store.js");
  return { scope, messages, images, drafts };
}

/** Create a legacy (pre-namespacing, global-name) database the way an old build would have. */
async function createLegacyDb(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("legacy");
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

async function databaseNames(): Promise<string[]> {
  const dbs = await indexedDB.databases();
  return dbs.map((d) => d.name ?? "");
}

function readRawDraftMap(): Record<string, unknown> {
  const raw = window.localStorage.getItem(DRAFTS_STORAGE_KEY);
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  window.localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
});

describe("storage-scope / namespace derivation", () => {
  it("derives <origin>#<userId> namespaces and scoped db names", async () => {
    vi.resetModules();
    const { namespaceForUser, scopedDbName, currentStorageNamespace } = await import("../storage-scope.js");
    const origin = window.location.origin;
    expect(namespaceForUser("user-1")).toBe(`${origin}#user-1`);
    expect(namespaceForUser(null)).toBe(`${origin}#anon`);
    expect(scopedDbName("first-tree-images", `${origin}#user-1`)).toBe(`first-tree-images@${origin}#user-1`);
    // The module starts anonymous until fetchMe sets the account.
    expect(currentStorageNamespace()).toBe(`${origin}#anon`);
  });

  it("write-blocks purged namespaces; re-login lifts the block, anon stays blocked", async () => {
    const { scope } = await loadModules();
    const origin = window.location.origin;
    scope.setStorageNamespace("user-a");
    expect(scope.activeScopedDbName("base")).toBe(`base@${origin}#user-a`);

    await scope.purgeAccountLocalData();
    // Current (user-a) namespace is now purged: stores get no name to open.
    expect(scope.activeScopedDbName("base")).toBeNull();

    scope.setStorageNamespace(null);
    expect(scope.activeScopedDbName("base")).toBeNull(); // anon purged by the logout
    scope.setStorageNamespace("user-b");
    expect(scope.activeScopedDbName("base")).toBe(`base@${origin}#user-b`); // other account unaffected
    scope.setStorageNamespace("user-a");
    expect(scope.activeScopedDbName("base")).toBe(`base@${origin}#user-a`); // explicit re-login re-enables
  });

  it("never rejects when IndexedDB is unavailable", async () => {
    vi.resetModules();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    const { purgeAccountLocalData, purgeLegacyUnscopedStores } = await import("../storage-scope.js");
    await expect(purgeAccountLocalData("user-a")).resolves.toBeUndefined();
    await expect(purgeLegacyUnscopedStores()).resolves.toBeUndefined();
  });
});

describe("storage-scope / logout purge", () => {
  it("deletes the legacy global databases", async () => {
    const { scope } = await loadModules();
    await createLegacyDb("first-tree-chat-cache");
    await createLegacyDb("first-tree-images");
    expect(await databaseNames()).toEqual(expect.arrayContaining(["first-tree-chat-cache", "first-tree-images"]));

    await scope.purgeLegacyUnscopedStores();

    const names = await databaseNames();
    expect(names).not.toContain("first-tree-chat-cache");
    expect(names).not.toContain("first-tree-images");
  });

  it("acceptance: account A's messages, images and drafts do not survive a logout into account B", async () => {
    const { scope, messages, images, drafts } = await loadModules();
    // Residue from a pre-namespacing build.
    await createLegacyDb("first-tree-chat-cache");
    await createLegacyDb("first-tree-images");

    // --- user A's session: cache messages + image + drafts (current AND legacy format)
    scope.setStorageNamespace("user-a");
    await messages.cacheMessages("chat-1", [msg("a-1", T(1))]);
    await images.putImage({ imageId: "img-a", base64: "a-bytes", mimeType: "image/png" });
    drafts.saveDraft(drafts.chatDraftScope("user-a", "chat-1"), { text: "A current-format draft" });
    // Another account's draft on the same browser must survive A's purge.
    drafts.saveDraft(drafts.chatDraftScope("user-b", "chat-1"), { text: "B draft" });
    // A pre-SEC-042 legacy-format draft for A, seeded raw so the read-path
    // migration cannot rewrite it before the purge.
    const seeded = readRawDraftMap();
    seeded["u:user-a:chat:chat-9"] = { text: "A legacy-format draft", updatedAt: 1 };
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(seeded));

    // --- logout (mirrors auth-context: purge, then drop to anonymous)
    await scope.purgeAccountLocalData("user-a");

    // B1: while still under A's (now purged) namespace, late writes are
    // dropped and reads come back empty.
    await messages.cacheMessages("chat-1", [msg("a-late", T(2))]);
    expect(await messages.getCachedMessages("chat-1")).toEqual([]);
    scope.setStorageNamespace(null);
    // ...and the anonymous namespace is write-blocked too.
    await messages.cacheMessages("chat-1", [msg("anon-write", T(3))]);
    expect(await messages.getCachedMessages("chat-1")).toEqual([]);
    await expect(images.putImage({ imageId: "img-late", base64: "x", mimeType: "image/png" })).rejects.toThrow(
      "Image storage unavailable",
    );

    // --- account B signs in on the same browser profile
    scope.setStorageNamespace("user-b");
    // Nothing of A is readable: not the messages, not the image, not the drafts.
    expect(await messages.getCachedMessages("chat-1")).toEqual([]);
    expect(await images.getImage("img-a")).toBeNull();
    expect(drafts.loadDraft(drafts.chatDraftScope("user-a", "chat-1"))).toBeNull();
    // B's own data is intact and B can read/write normally.
    expect(drafts.loadDraft(drafts.chatDraftScope("user-b", "chat-1"))?.text).toBe("B draft");
    await messages.cacheMessages("chat-1", [msg("b-1", T(4))]);
    expect((await messages.getCachedMessages("chat-1")).map((m) => m.id)).toEqual(["b-1"]);

    // The raw drafts map holds no user-a entries in either scope format.
    const remainingKeys = Object.keys(readRawDraftMap());
    expect(remainingKeys.some((k) => k.startsWith("u:user-a:") || k.startsWith("u:user-a@"))).toBe(false);

    // The legacy global databases were deleted by the purge.
    const names = await databaseNames();
    expect(names).not.toContain("first-tree-chat-cache");
    expect(names).not.toContain("first-tree-images");

    // A re-login of A re-enables caching, but the purged content stays gone.
    scope.setStorageNamespace("user-a");
    expect(await messages.getCachedMessages("chat-1")).toEqual([]);
    await messages.cacheMessages("chat-1", [msg("a-new", T(5))]);
    expect((await messages.getCachedMessages("chat-1")).map((m) => m.id)).toEqual(["a-new"]);
  });

  it("blocks the purged account's draft writes until re-login; anon stays blocked", async () => {
    const { scope, drafts } = await loadModules();
    scope.setStorageNamespace("user-a");
    drafts.saveDraft(drafts.chatDraftScope("user-a", "chat-1"), { text: "A draft" });

    // Logout: purge marks user-a AND anon draft-write-blocked synchronously.
    await scope.purgeAccountLocalData("user-a");

    // Late writes for the purged account are dropped — including an in-flight
    // failed send being parked after the purge.
    drafts.saveDraft(drafts.chatDraftScope("user-a", "chat-2"), { text: "late A write" });
    expect(drafts.loadDraft(drafts.chatDraftScope("user-a", "chat-2"))).toBeNull();
    expect(drafts.parkFailedDraftIfSwitched("user-a", "chat-1", "chat-2", "failed text")).toBe(true);
    expect(drafts.loadDraft(drafts.chatDraftScope("user-a", "chat-1"))).toBeNull();

    // Post-logout anonymous state: draft writes are blocked too.
    scope.setStorageNamespace(null);
    drafts.saveDraft(drafts.chatDraftScope(null, "chat-1"), { text: "anon write" });
    expect(drafts.loadDraft(drafts.chatDraftScope(null, "chat-1"))).toBeNull();

    // Another account is unaffected, and anon STAYS blocked after a sign-in.
    scope.setStorageNamespace("user-b");
    drafts.saveDraft(drafts.chatDraftScope("user-b", "chat-1"), { text: "B draft" });
    expect(drafts.loadDraft(drafts.chatDraftScope("user-b", "chat-1"))?.text).toBe("B draft");
    drafts.saveDraft(drafts.chatDraftScope(null, "chat-1"), { text: "anon still blocked" });
    expect(drafts.loadDraft(drafts.chatDraftScope(null, "chat-1"))).toBeNull();

    // Re-login of A lifts the block; the purged content stays gone, new
    // drafts land fresh.
    scope.setStorageNamespace("user-a");
    expect(drafts.loadDraft(drafts.chatDraftScope("user-a", "chat-1"))).toBeNull();
    drafts.saveDraft(drafts.chatDraftScope("user-a", "chat-1"), { text: "A again" });
    expect(drafts.loadDraft(drafts.chatDraftScope("user-a", "chat-1"))?.text).toBe("A again");
  });

  it("purges the token-fallback namespace when it differs from the current one", async () => {
    // One browser profile (one fake IDB), two "sessions" (two module graphs):
    // the first session leaves data under user-a's namespace; the second
    // session's /me never resolves, so the namespace is still anonymous and
    // only the token identifies user-a at logout.
    const factory = new IDBFactory();
    vi.resetModules();
    globalThis.indexedDB = factory;
    const scope1 = await import("../storage-scope.js");
    const messages1 = await import("../message-store.js");
    scope1.setStorageNamespace("user-a");
    await messages1.cacheMessages("chat-1", [msg("stale", T(1))]);

    vi.resetModules();
    globalThis.indexedDB = factory;
    const scope2 = await import("../storage-scope.js");
    const messages2 = await import("../message-store.js");
    await scope2.purgeAccountLocalData("user-a");

    scope2.setStorageNamespace("user-b");
    expect(await messages2.getCachedMessages("chat-1")).toEqual([]);
    // user-a's namespace was purged even though it was never current in this
    // session: signing back in as user-a finds nothing.
    scope2.setStorageNamespace("user-a");
    expect(await messages2.getCachedMessages("chat-1")).toEqual([]);
  });
});

describe("storage-scope / multi-tab deletion (D1)", () => {
  it("closes the cached connection when another tab deletes the db, then re-opens cleanly", async () => {
    const { scope, messages } = await loadModules();
    scope.setStorageNamespace("user-a");
    await messages.cacheMessages("chat-1", [msg("m-1", T(1))]);

    // Another tab deletes this namespace's database. This tab's cached
    // connection must close via `onversionchange` so the delete is not
    // blocked.
    const name = scope.scopedDbName("first-tree-chat-cache", scope.namespaceForUser("user-a"));
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error("delete failed"));
      req.onblocked = () => reject(new Error("delete blocked — onversionchange did not close the connection"));
    });

    // Never-throws read contract: the store must not reuse the closed
    // connection (InvalidStateError); it re-opens a fresh, empty database.
    await expect(messages.getCachedMessages("chat-1")).resolves.toEqual([]);
  });
});
