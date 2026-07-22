import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageWithDelivery } from "../chats.js";

// Identity control for the per-account database namespacing (SEC-042); see
// message-store.test.ts for why the identity is mocked rather than seeded
// through real tokens in this node-environment suite.
const identityMock = vi.hoisted(() => ({ userId: "user-1" as string | null }));

vi.mock("../../lib/current-user-id.js", () => ({
  currentUserIdFromToken: () => identityMock.userId,
  lastKnownUserId: () => identityMock.userId,
}));

beforeEach(() => {
  identityMock.userId = "user-1";
});

type Callback = () => void;

type RequestStub<T> = {
  result: T | undefined;
  onsuccess: Callback | null;
  onerror: Callback | null;
};

type TransactionStub = {
  error: Error | null;
  oncomplete: Callback | null;
  onerror: Callback | null;
  onabort: Callback | null;
  objectStore: () => StoreStub;
};

type StoreStub = {
  put: (entry: unknown) => void;
  get: (key: unknown) => RequestStub<unknown>;
  delete: (key: unknown) => void;
};

type OpenRequestStub = {
  result: DatabaseStub;
  onupgradeneeded: Callback | null;
  onsuccess: Callback | null;
  onerror: Callback | null;
  onblocked: Callback | null;
};

type DatabaseStub = {
  transaction: (storeName: string, mode: IDBTransactionMode) => TransactionStub;
  objectStoreNames: { contains: (name: string) => boolean };
  createObjectStore: (name: string, options?: IDBObjectStoreParameters) => StoreStub;
};

async function loadImageStore() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  return import("../image-store.js");
}

async function loadReadStateStore() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  return import("../read-state-store.js");
}

function installControllableIndexedDb(): {
  request: OpenRequestStub;
  getRequests: RequestStub<unknown>[];
  transactions: TransactionStub[];
} {
  const getRequests: RequestStub<unknown>[] = [];
  const transactions: TransactionStub[] = [];
  const store: StoreStub = {
    put: () => undefined,
    get: () => {
      const request: RequestStub<unknown> = { result: undefined, onsuccess: null, onerror: null };
      getRequests.push(request);
      return request;
    },
    delete: () => undefined,
  };
  const db: DatabaseStub = {
    transaction: () => {
      const tx: TransactionStub = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore: () => store,
      };
      transactions.push(tx);
      return tx;
    },
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
  };
  const request: OpenRequestStub = {
    result: db,
    onupgradeneeded: null,
    onsuccess: null,
    onerror: null,
    onblocked: null,
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open: () => request },
  });
  return { request, getRequests, transactions };
}

async function settleOpen(request: OpenRequestStub): Promise<void> {
  request.onsuccess?.();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForTransaction(transactions: TransactionStub[], count: number): Promise<TransactionStub> {
  for (let i = 0; i < 5 && transactions.length < count; i += 1) {
    await Promise.resolve();
  }
  const tx = transactions[count - 1];
  if (!tx) throw new Error(`Missing transaction ${count}`);
  return tx;
}

describe("image-store", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("stores and retrieves image bytes by id", async () => {
    const { getImage, putImage } = await loadImageStore();

    await expect(putImage({ imageId: "img-1", base64: "abc123", mimeType: "image/png" })).resolves.toBeUndefined();
    await expect(getImage("img-1")).resolves.toEqual({ base64: "abc123", mimeType: "image/png" });
    await expect(getImage("missing")).resolves.toBeNull();
  });

  it("rejects writes and returns null when IndexedDB is unavailable", async () => {
    vi.resetModules();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    const { getImage, putImage } = await import("../image-store.js");

    await expect(putImage({ imageId: "img-1", base64: "abc123", mimeType: "image/png" })).rejects.toThrow(
      "Image storage unavailable",
    );
    await expect(getImage("img-1")).resolves.toBeNull();
  });

  it("rejects writes when the database open is blocked", async () => {
    vi.resetModules();
    const { request } = installControllableIndexedDb();
    const { putImage } = await import("../image-store.js");

    const write = putImage({ imageId: "img-1", base64: "abc123", mimeType: "image/png" });
    request.onblocked?.();

    await expect(write).rejects.toThrow("Image storage unavailable");
  });

  it("rejects writes on transaction error and abort", async () => {
    vi.resetModules();
    const firstDb = installControllableIndexedDb();
    const { putImage } = await import("../image-store.js");

    const erroredWrite = putImage({ imageId: "img-1", base64: "abc123", mimeType: "image/png" });
    await settleOpen(firstDb.request);
    const erroredTx = await waitForTransaction(firstDb.transactions, 1);
    erroredTx.error = new Error("quota exceeded");
    erroredTx.onerror?.();
    await expect(erroredWrite).rejects.toThrow("quota exceeded");

    vi.resetModules();
    const secondDb = installControllableIndexedDb();
    const { putImage: putImageAgain } = await import("../image-store.js");
    const abortedWrite = putImageAgain({ imageId: "img-2", base64: "def456", mimeType: "image/jpeg" });
    await settleOpen(secondDb.request);
    const abortedTx = await waitForTransaction(secondDb.transactions, 1);
    abortedTx.onabort?.();
    await expect(abortedWrite).rejects.toThrow("Image storage write aborted");
  });

  it("returns null when image reads fail", async () => {
    vi.resetModules();
    const db = installControllableIndexedDb();
    const { getImage } = await import("../image-store.js");

    const read = getImage("img-1");
    await settleOpen(db.request);
    const req = db.getRequests[0];
    if (!req) throw new Error("Missing get request");
    req.onerror?.();

    await expect(read).resolves.toBeNull();
  });
});

describe("read-state-store", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("sets, gets, overwrites, and clears a chat read state", async () => {
    const { clearReadState, getReadState, setReadState } = await loadReadStateStore();

    await expect(getReadState("chat-1")).resolves.toBeNull();
    await setReadState("chat-1", "msg-1", "msg-3");
    await expect(getReadState("chat-1")).resolves.toMatchObject({
      chatId: "chat-1",
      bottomVisibleMessageId: "msg-1",
      latestKnownMessageId: "msg-3",
    });

    await setReadState("chat-1", "msg-4", "msg-5");
    await expect(getReadState("chat-1")).resolves.toMatchObject({
      chatId: "chat-1",
      bottomVisibleMessageId: "msg-4",
      latestKnownMessageId: "msg-5",
    });

    await clearReadState("chat-1");
    await expect(getReadState("chat-1")).resolves.toBeNull();
  });

  it("silently no-ops when IndexedDB is unavailable", async () => {
    vi.resetModules();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    const { clearReadState, getReadState, setReadState } = await import("../read-state-store.js");

    await expect(setReadState("chat-1", "msg-1", "msg-2")).resolves.toBeUndefined();
    await expect(clearReadState("chat-1")).resolves.toBeUndefined();
    await expect(getReadState("chat-1")).resolves.toBeNull();
  });

  it("silently no-ops when the database open is blocked", async () => {
    vi.resetModules();
    const { request } = installControllableIndexedDb();
    const { setReadState } = await import("../read-state-store.js");

    const write = setReadState("chat-1", "msg-1", "msg-2");
    request.onblocked?.();

    await expect(write).resolves.toBeUndefined();
  });

  it("returns null when read-state reads fail", async () => {
    vi.resetModules();
    const db = installControllableIndexedDb();
    const { getReadState } = await import("../read-state-store.js");

    const read = getReadState("chat-1");
    await settleOpen(db.request);
    const req = db.getRequests[0];
    if (!req) throw new Error("Missing read-state get request");
    req.onerror?.();

    await expect(read).resolves.toBeNull();
  });

  it("resolves read-state writes on transaction error and abort", async () => {
    vi.resetModules();
    const db = installControllableIndexedDb();
    const { clearReadState, setReadState } = await import("../read-state-store.js");

    const write = setReadState("chat-1", "msg-1", "msg-2");
    await settleOpen(db.request);
    const writeTx = await waitForTransaction(db.transactions, 1);
    writeTx.onerror?.();
    await expect(write).resolves.toBeUndefined();

    const clear = clearReadState("chat-1");
    const clearTx = await waitForTransaction(db.transactions, 2);
    clearTx.onabort?.();
    await expect(clear).resolves.toBeUndefined();
  });
});

async function listDatabaseNames(): Promise<string[]> {
  const dbs = await indexedDB.databases();
  return dbs
    .map((d) => d.name)
    .filter((n): n is string => typeof n === "string")
    .sort();
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

describe("per-account namespacing (SEC-042)", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("image-store writes into a database named for the current account and isolates accounts", async () => {
    const { getImage, putImage } = await loadImageStore();
    await putImage({ imageId: "img-1", base64: "abc123", mimeType: "image/png" });
    expect(await listDatabaseNames()).toEqual(["first-tree-images:u:user-1"]);

    identityMock.userId = "user-2";
    expect(await getImage("img-1")).toBeNull();

    identityMock.userId = "user-1";
    expect(await getImage("img-1")).toEqual({ base64: "abc123", mimeType: "image/png" });
  });

  it("image-store keeps the reject contract for writes while signed out and creates no database", async () => {
    const { getImage, putImage } = await loadImageStore();
    identityMock.userId = null;

    await expect(putImage({ imageId: "img-1", base64: "abc123", mimeType: "image/png" })).rejects.toThrow(
      "Image storage unavailable",
    );
    expect(await getImage("img-1")).toBeNull();
    expect(await listDatabaseNames()).toEqual([]);
  });

  it("image-store requests deletion of the legacy database on first namespaced open", async () => {
    const { putImage } = await loadImageStore();
    const spy = vi.spyOn(indexedDB, "deleteDatabase");
    await putImage({ imageId: "img-1", base64: "abc123", mimeType: "image/png" });
    expect(spy.mock.calls.filter(([name]) => name === "first-tree-images")).toHaveLength(1);
  });

  it("read-state-store writes into the shared per-account chat-cache database and no-ops while signed out", async () => {
    const { getReadState, setReadState } = await loadReadStateStore();
    await setReadState("chat-1", "msg-1", "msg-2");
    expect(await listDatabaseNames()).toEqual(["first-tree-chat-cache:u:user-1"]);

    identityMock.userId = null;
    await expect(setReadState("chat-2", "msg-3", "msg-4")).resolves.toBeUndefined();
    expect(await getReadState("chat-1")).toBeNull();
    expect(await listDatabaseNames()).toEqual(["first-tree-chat-cache:u:user-1"]);
  });

  it("purge must close BOTH chat-cache connections (message-store and read-state-store) for a delete to complete", async () => {
    vi.resetModules();
    globalThis.indexedDB = new IDBFactory();
    const messageStore = await import("../message-store.js");
    const readStateStore = await import("../read-state-store.js");

    const message: MessageWithDelivery = {
      id: "m1",
      chatId: "chat-1",
      senderId: "user-1",
      format: "text",
      content: { text: "hello" },
      metadata: {},
      inReplyTo: null,
      source: "web",
      createdAt: new Date(2026, 0, 1).toISOString(),
    };
    await messageStore.cacheMessages("chat-1", [message]);
    await readStateStore.setReadState("chat-1", "m1", "m1");

    // Two modules, one database, one connection each — the purge closes both.
    messageStore.closeDbForPurge();
    readStateStore.closeDbForPurge();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(deleteDb("first-tree-chat-cache:u:user-1")).resolves.toBe("success");
  });
});
