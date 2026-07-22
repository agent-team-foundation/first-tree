// @vitest-environment happy-dom

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This suite exercises the REAL module chain — purge-local-data → the three
// stores → current-user-id → api/client token storage — with identities
// seeded through actual stored tokens, so the token → `sub` decode path is
// covered here (the store suites mock it instead).

function tokenWithPayload(payload: unknown): string {
  const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `header.${encoded}.signature`;
}

function setToken(sub: string): void {
  localStorage.setItem(
    "first-tree:tokens",
    JSON.stringify({ accessToken: tokenWithPayload({ sub }), refreshToken: "refresh" }),
  );
}

function createStorage(recordInto?: string[]): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      recordInto?.push("localStorage:removeItem");
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function installStorage(storage: Storage): void {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}

function createThrowingStorage(): Storage {
  return {
    get length() {
      return 0;
    },
    clear: () => {
      throw new Error("storage denied");
    },
    getItem: () => {
      throw new Error("storage denied");
    },
    key: () => {
      throw new Error("storage denied");
    },
    removeItem: () => {
      throw new Error("storage denied");
    },
    setItem: () => {
      throw new Error("storage denied");
    },
  };
}

/** Create (and close) a database so it exists without any open connection. */
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

async function listDatabaseNames(): Promise<string[]> {
  const dbs = await indexedDB.databases();
  return dbs
    .map((d) => d.name)
    .filter((n): n is string => typeof n === "string")
    .sort();
}

async function loadPurge() {
  return import("../purge-local-data.js");
}

type DeleteRequestStub = {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
};

beforeEach(() => {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  installStorage(createStorage());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("purgeLocalUserData", () => {
  it("deletes first-party databases and swept keys while preserving the retention list", async () => {
    await seedDb("first-tree-chat-cache");
    await seedDb("first-tree-images");
    await seedDb("first-tree-chat-cache:u:user-a");
    await seedDb("first-tree-images:u:user-a");
    localStorage.setItem(
      "first-tree:chat-drafts:v1",
      JSON.stringify({ "u:user-a:chat:chat-1": { text: "unsent secret", updatedAt: 1 } }),
    );
    localStorage.setItem("first-tree:new-chat-default-agent:user-a:org-1", "agent-1");
    localStorage.setItem("first-tree:chat-summary-expanded:v1:chat-1", "true");
    localStorage.setItem("first-tree:chat-summary-dismissed-version:v1:chat-1", "3");
    localStorage.setItem("first-tree:selectedOrganizationId:user-a", "org-1");
    localStorage.setItem("theme", "dark");
    // Explicit logout: tokens already cleared, so no current identity — every
    // first-party database (all accounts + legacy) goes.
    const { purgeLocalUserData } = await loadPurge();

    await purgeLocalUserData("user-a");

    expect(await listDatabaseNames()).toEqual([]);
    expect(localStorage.getItem("first-tree:chat-drafts:v1")).toBeNull();
    expect(localStorage.getItem("first-tree:new-chat-default-agent:user-a:org-1")).toBeNull();
    expect(localStorage.getItem("first-tree:chat-summary-expanded:v1:chat-1")).toBeNull();
    expect(localStorage.getItem("first-tree:chat-summary-dismissed-version:v1:chat-1")).toBeNull();
    // Retention list: per-user org selection and pure UI preferences survive.
    expect(localStorage.getItem("first-tree:selectedOrganizationId:user-a")).toBe("org-1");
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("spares the incoming account's databases on a bypass-logout account switch", async () => {
    await seedDb("first-tree-chat-cache");
    await seedDb("first-tree-images");
    await seedDb("first-tree-chat-cache:u:user-a");
    await seedDb("first-tree-images:u:user-a");
    await seedDb("first-tree-chat-cache:u:user-b");
    await seedDb("first-tree-images:u:user-b");
    // adoptTokens already stored user-b's tokens before the purge runs.
    setToken("user-b");
    const { purgeLocalUserData } = await loadPurge();

    await purgeLocalUserData("user-a");

    expect(await listDatabaseNames()).toEqual(["first-tree-chat-cache:u:user-b", "first-tree-images:u:user-b"]);
  });

  it("resolves within the time box when database deletes stay blocked", async () => {
    vi.useFakeTimers();
    const stub = {
      databases: async (): Promise<IDBDatabaseInfo[]> => [{ name: "first-tree-chat-cache", version: 2 }],
      deleteDatabase: (): DeleteRequestStub => ({ onsuccess: null, onerror: null, onblocked: null }),
    };
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: stub });
    const { purgeLocalUserData } = await loadPurge();

    let settled = false;
    const purge = purgeLocalUserData("user-a").then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    await purge;
    expect(settled).toBe(true);
  });

  it("still resolves and deletes databases when localStorage throws", async () => {
    await seedDb("first-tree-chat-cache");
    installStorage(createThrowingStorage());
    const { purgeLocalUserData } = await loadPurge();

    await expect(purgeLocalUserData("user-a")).resolves.toBeUndefined();
    expect(await listDatabaseNames()).toEqual([]);
  });

  it("falls back to the deterministic name list when databases() is unavailable", async () => {
    const factory = new IDBFactory();
    globalThis.indexedDB = factory;
    await seedDb("first-tree-chat-cache");
    await seedDb("first-tree-chat-cache:u:user-a");
    await seedDb("first-tree-chat-cache:u:user-c");
    // Firefox < 126: no indexedDB.databases(). Only open/deleteDatabase exist.
    const limited = {
      open: factory.open.bind(factory),
      deleteDatabase: factory.deleteDatabase.bind(factory),
    };
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: limited });
    const { purgeLocalUserData } = await loadPurge();

    await purgeLocalUserData("user-a");

    // Legacy + departing account deleted; an unrelated third account's
    // database is unreachable without enumeration and survives (its data
    // stays inaccessible to other accounts via namespacing).
    const remaining = (await factory.databases()).map((d) => d.name).sort();
    expect(remaining).toEqual(["first-tree-chat-cache:u:user-c"]);
  });

  it("sweeps localStorage before issuing any IndexedDB delete", async () => {
    const order: string[] = [];
    installStorage(createStorage(order));
    const stub = {
      databases: async (): Promise<IDBDatabaseInfo[]> => [{ name: "first-tree-chat-cache", version: 2 }],
      deleteDatabase: (name: string): DeleteRequestStub => {
        order.push(`idb:${name}`);
        const req: DeleteRequestStub = { onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      },
    };
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: stub });
    const { purgeLocalUserData } = await loadPurge();

    await purgeLocalUserData("user-a");

    const firstStorageSweep = order.indexOf("localStorage:removeItem");
    const firstDelete = order.findIndex((entry) => entry.startsWith("idb:"));
    expect(firstStorageSweep).toBeGreaterThanOrEqual(0);
    expect(firstDelete).toBeGreaterThan(firstStorageSweep);
  });

  it("resolves when IndexedDB is entirely unavailable", async () => {
    localStorage.setItem("first-tree:chat-drafts:v1", "{}");
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    const { purgeLocalUserData } = await loadPurge();

    await expect(purgeLocalUserData("user-a")).resolves.toBeUndefined();
    expect(localStorage.getItem("first-tree:chat-drafts:v1")).toBeNull();
  });
});
