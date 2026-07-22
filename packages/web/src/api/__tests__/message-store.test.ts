import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_CONTENT_DATABASE_SPEC,
  captureContentStoreRuntime,
  closeCoordinatorConnections,
  createScopedDatabaseName,
  createViewLease,
  installContentStoreRuntime,
  type SessionLockManager,
  type SessionLockOptions,
  sessionErrorCodes,
} from "../../auth/session/index.js";
import type { MessageWithDelivery } from "../chats.js";
import { cacheMessages, clearChatCache, getCachedMessages } from "../message-store.js";
import {
  createStoreFixture,
  databaseNames,
  putRawStoreRow,
  replaceOrganization,
  replaceStoreFixture,
  type StoreFixture,
} from "./scoped-store-fixture.js";

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

const timestamp = (seconds: number): string => new Date(2026, 0, 1, 0, 0, seconds).toISOString();
let currentFixture: StoreFixture | null = null;

afterEach(() => {
  currentFixture?.dispose();
  currentFixture = null;
  closeCoordinatorConnections();
});

describe("scoped message cache semantics", () => {
  it("fails closed without an explicit captured view", async () => {
    await cacheMessages("chat-1", [msg("legacy", timestamp(1))]);
    expect(await getCachedMessages("chat-1")).toEqual([]);
  });

  it("orders, upserts, filters, and clears within one explicit view", async () => {
    currentFixture = await createStoreFixture({ label: "basic", organizationId: "org-a" });
    const { lease } = currentFixture;

    await cacheMessages(lease, "chat-1", [
      msg("c", timestamp(3)),
      msg("a", timestamp(1), { content: { text: "v1" } }),
      msg("b", timestamp(2)),
      msg("rogue", timestamp(4), { chatId: "chat-other" }),
    ]);
    await cacheMessages(lease, "chat-1", [msg("a", timestamp(1), { content: { text: "v2" } })]);
    await cacheMessages(lease, "chat-2", [msg("d", timestamp(4), { chatId: "chat-2" })]);

    const rows = await getCachedMessages(lease, "chat-1");
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect((rows[0]?.content as { text: string }).text).toBe("v2");
    expect(await getCachedMessages(lease, "chat-other")).toEqual([]);

    await clearChatCache(lease, "chat-1");
    expect(await getCachedMessages(lease, "chat-1")).toEqual([]);
    expect((await getCachedMessages(lease, "chat-2")).map((row) => row.id)).toEqual(["d"]);
  });

  it("skips corrupted rows instead of delivering untrusted persisted payloads", async () => {
    currentFixture = await createStoreFixture({ label: "corrupt-message", organizationId: "org-a" });
    const { activation, factory, lease } = currentFixture;
    await cacheMessages(lease, "chat-1", [msg("valid", timestamp(1))]);
    const databaseName = createScopedDatabaseName(
      CHAT_CONTENT_DATABASE_SPEC.logicalName,
      CHAT_CONTENT_DATABASE_SPEC.namespaceVersion,
      activation.scopeKey,
    );
    await putRawStoreRow(factory, databaseName, "messages", {
      organizationId: "org-a",
      chatId: "chat-1",
      messageId: "corrupt",
      payload: msg("different-id", timestamp(2), { deliveryStatus: "forged" as "sent" }),
      createdAt: timestamp(2),
      cachedAt: Date.now(),
    });

    expect((await getCachedMessages(lease, "chat-1")).map((row) => row.id)).toEqual(["valid"]);
  });

  it("keeps organization rows unreadable after an org switch and rejects the old lease", async () => {
    const orgA = await createStoreFixture({ label: "org-a", accountId: "account-a", organizationId: "org-a" });
    currentFixture = orgA;
    await cacheMessages(orgA.lease, "chat-1", [msg("from-a", timestamp(1))]);

    const orgB = replaceOrganization(orgA, {
      label: "org-b",
      organizationId: "org-b",
      orgRevision: "revision-b",
    });
    currentFixture = orgB;
    expect(await getCachedMessages(orgB.lease, "chat-1")).toEqual([]);
    expect(await getCachedMessages(orgA.lease, "chat-1")).toEqual([]);
    expect(captureContentStoreRuntime(orgB.lease)?.lease.organizationId).toBe("org-b");

    await cacheMessages(orgB.lease, "chat-1", [msg("from-b", timestamp(2))]);
    expect((await getCachedMessages(orgB.lease, "chat-1")).map((row) => row.id)).toEqual(["from-b"]);

    const orgAReturn = replaceOrganization(orgB, {
      label: "org-a-return",
      organizationId: "org-a",
      orgRevision: "revision-a-return",
    });
    currentFixture = orgAReturn;
    expect((await getCachedMessages(orgAReturn.lease, "chat-1")).map((row) => row.id)).toEqual(["from-a"]);
  });

  it("does not let an old org reclaim storage when two views reused one signal", async () => {
    const orgA = await createStoreFixture({ label: "same-signal-a", accountId: "account", organizationId: "org-a" });
    currentFixture = orgA;
    await cacheMessages(orgA.lease, "chat-1", [msg("from-a", timestamp(1))]);
    const orgBLease = createViewLease({
      ...orgA.lease,
      organizationId: "org-b",
      orgRevision: "revision-b",
      signal: orgA.lease.signal,
    });
    const disposeOrgB = installContentStoreRuntime({ barrier: orgA.barrier, lease: orgBLease });
    currentFixture = { ...orgA, lease: orgBLease, dispose: disposeOrgB };
    await cacheMessages(orgBLease, "chat-1", [msg("from-b", timestamp(2))]);

    expect(() => installContentStoreRuntime({ barrier: orgA.barrier, lease: orgA.lease })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );
    expect(await getCachedMessages(orgA.lease, "chat-1")).toEqual([]);
    expect((await getCachedMessages(orgBLease, "chat-1")).map((row) => row.id)).toEqual(["from-b"]);
  });

  it("purges the departing account's physical database before another account activates", async () => {
    const accountA = await createStoreFixture({ label: "account-a", accountId: "account-a", organizationId: "org" });
    currentFixture = accountA;
    await cacheMessages(accountA.lease, "chat-1", [msg("secret-a", timestamp(1))]);
    const accountAName = createScopedDatabaseName(
      CHAT_CONTENT_DATABASE_SPEC.logicalName,
      CHAT_CONTENT_DATABASE_SPEC.namespaceVersion,
      accountA.activation.scopeKey,
    );

    const accountB = await replaceStoreFixture(accountA, {
      label: "account-b",
      accountId: "account-b",
      organizationId: "org",
    });
    currentFixture = accountB;
    expect(await getCachedMessages(accountB.lease, "chat-1")).toEqual([]);
    expect(await getCachedMessages(accountA.lease, "chat-1")).toEqual([]);
    expect(await databaseNames(accountB.factory)).not.toContain(accountAName);

    await cacheMessages(accountB.lease, "chat-1", [msg("message-b", timestamp(2))]);
    const accountBName = createScopedDatabaseName(
      CHAT_CONTENT_DATABASE_SPEC.logicalName,
      CHAT_CONTENT_DATABASE_SPEC.namespaceVersion,
      accountB.activation.scopeKey,
    );
    expect(await databaseNames(accountB.factory)).toContain(accountBName);
    expect(await databaseNames(accountB.factory)).not.toContain(accountAName);
  });

  it("separates the same account id on different server authorities", async () => {
    const serverA = await createStoreFixture({
      label: "server-a",
      serverAuthority: "https://s1.example/api/v1",
      accountId: "shared-account",
      organizationId: "org",
    });
    currentFixture = serverA;
    await cacheMessages(serverA.lease, "chat-1", [msg("s1-secret", timestamp(1))]);

    const serverB = await replaceStoreFixture(serverA, {
      label: "server-b",
      serverAuthority: "https://s2.example/api/v1",
      accountId: "shared-account",
      organizationId: "org",
    });
    currentFixture = serverB;
    expect(serverB.activation.scopeKey).not.toBe(serverA.activation.scopeKey);
    expect(await getCachedMessages(serverB.lease, "chat-1")).toEqual([]);
  });
});

class PausedSharedLock implements SessionLockManager {
  public entered: Promise<void>;
  private markEntered: () => void = () => undefined;
  private releasePaused: (() => Promise<void>) | null = null;
  private pauseNextShared = true;

  public constructor() {
    this.entered = new Promise((resolve) => {
      this.markEntered = resolve;
    });
  }

  public request<T>(_name: string, options: SessionLockOptions, callback: () => T | PromiseLike<T>): Promise<T> {
    if (options.mode !== "shared" || !this.pauseNextShared) return Promise.resolve().then(callback);
    this.pauseNextShared = false;
    this.markEntered();
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => reject(new DOMException("Lock cancelled", "AbortError"));
      options.signal?.addEventListener("abort", abort, { once: true });
      this.releasePaused = () => {
        options.signal?.removeEventListener("abort", abort);
        return Promise.resolve(callback()).then(
          (value) => {
            resolve(value);
          },
          (error: unknown) => {
            reject(error);
            throw error;
          },
        );
      };
    });
  }

  public release(): Promise<void> {
    return this.releasePaused?.() ?? Promise.resolve();
  }
}

describe("stale scoped message operations", () => {
  it("persists the pre-await message snapshot instead of later caller mutations", async () => {
    const locks = new PausedSharedLock();
    currentFixture = await createStoreFixture({ label: "snapshot-message", organizationId: "org-a" }, locks);
    const first = msg("first", timestamp(1), { content: { text: "before" } });
    const messages = [first];
    const write = cacheMessages(currentFixture.lease, "chat-1", messages);
    await locks.entered;

    (first.content as { text: string }).text = "after";
    messages.push(msg("late", timestamp(2)));
    await locks.release();
    await write;

    const rows = await getCachedMessages(currentFixture.lease, "chat-1");
    expect(rows.map((row) => row.id)).toEqual(["first"]);
    expect(rows[0]?.content).toEqual({ text: "before" });
  });

  it("does not let a queued old-org writer recreate or populate storage", async () => {
    const locks = new PausedSharedLock();
    const orgA = await createStoreFixture({ label: "late-a", organizationId: "org-a" }, locks);
    currentFixture = orgA;
    const lateWrite = cacheMessages(orgA.lease, "chat-1", [msg("late-a", timestamp(1))]);
    await locks.entered;

    const orgB = replaceOrganization(orgA, {
      label: "late-b",
      organizationId: "org-b",
      orgRevision: "revision-b",
    });
    currentFixture = orgB;
    await expect(locks.release()).rejects.toMatchObject({ code: "stale_operation" });
    await lateWrite;

    expect(await getCachedMessages(orgB.lease, "chat-1")).toEqual([]);
    const orgAReturn = replaceOrganization(orgB, {
      label: "late-a-return",
      organizationId: "org-a",
      orgRevision: "revision-a-return",
    });
    currentFixture = orgAReturn;
    expect(await getCachedMessages(orgAReturn.lease, "chat-1")).toEqual([]);
  });
});
