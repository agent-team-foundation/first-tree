import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthSessionCoordinator,
  ContentDatabaseRegistry,
  closeCoordinatorConnections,
  installSessionLifecycleHooks,
  LEGACY_DATABASE_NAMES,
  SessionError,
  type StorageArea,
  scrubLegacyPersistence,
  scrubLegacyWebStorage,
  sessionErrorCodes,
} from "../session/index.js";

function deferNextOpen(factory: IDBFactory): Readonly<{ started: Promise<void>; release: () => void }> {
  const originalOpen = factory.open.bind(factory);
  let startedResolve = (): void => undefined;
  let releaseResolve = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  vi.spyOn(factory, "open").mockImplementationOnce((name: string, version?: number) => {
    const request = version === undefined ? originalOpen(name) : originalOpen(name, version);
    return new Proxy(request, {
      get: (target, property) => Reflect.get(target, property, target),
      set(target, property, value) {
        if (property === "onsuccess" && typeof value === "function") {
          target.onsuccess = (event) => {
            startedResolve();
            void released.then(() => value.call(target, event));
          };
          return true;
        }
        return Reflect.set(target, property, value, target);
      },
    });
  });
  return Object.freeze({ started, release: releaseResolve });
}

class MemoryStorage implements StorageArea {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  public keys(): string[] {
    return [...this.values.keys()].sort();
  }
}

function rawOpen(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("rows");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function databaseNames(factory: IDBFactory): Promise<string[]> {
  const entries = await factory.databases();
  return entries.flatMap((entry) => (entry.name ? [entry.name] : []));
}

function dispatch(target: EventTarget, name: string): void {
  target.dispatchEvent(new Event(name));
}

afterEach(() => {
  closeCoordinatorConnections();
  vi.restoreAllMocks();
});

describe("legacy persistence scrub", () => {
  it("removes only the exact known inventory and reruns after legacy data reappears", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    localStorage.setItem("first-tree:tokens", "secret");
    localStorage.setItem("first-tree:chat-drafts:v1", "draft");
    localStorage.setItem("first-tree:selectedOrganizationId:old-user", "org-a");
    localStorage.setItem("first-tree:new-chat-default-agent:user:org", "agent-a");
    localStorage.setItem("first-tree:chat-summary-expanded:v1:chat-a", "1");
    localStorage.setItem("onboarding:bannerDismissed", "1");
    localStorage.setItem("theme", "dark");
    localStorage.setItem("first-tree:tokens:unrelated", "keep");
    localStorage.setItem("onboarding:unrelated-local", "keep");
    sessionStorage.setItem("first-tree:quickstart:intent", "repo-secret");
    sessionStorage.setItem("first-tree:quickstart:agent", "agent-a");
    sessionStorage.setItem("context-build:install-attempt", "attempt");
    sessionStorage.setItem("settings:github:install-attempt", "attempt");
    sessionStorage.setItem("first-tree:auth-attempt", "attempt");
    sessionStorage.setItem("onboarding:selectedRepos:org-a", "repo-secret");
    sessionStorage.setItem("first-tree:install-guide-session", "1");

    for (const name of LEGACY_DATABASE_NAMES) (await rawOpen(factory, name)).close();
    const first = await scrubLegacyPersistence({ localStorage, sessionStorage, indexedDB: factory });

    expect(first).toEqual({
      localStorageKeysRemoved: 6,
      sessionStorageKeysRemoved: 6,
      databasesDeleted: LEGACY_DATABASE_NAMES.length,
    });
    expect(localStorage.keys()).toEqual(["first-tree:tokens:unrelated", "onboarding:unrelated-local", "theme"]);
    expect(sessionStorage.keys()).toEqual(["first-tree:install-guide-session"]);
    expect(await databaseNames(factory)).toEqual([]);

    localStorage.setItem("first-tree:tokens", "late-old-tab-secret");
    sessionStorage.setItem("first-tree:quickstart:agent", "late-old-tab-agent");
    (await rawOpen(factory, "first-tree-chat-cache")).close();
    const second = await scrubLegacyPersistence({ localStorage, sessionStorage, indexedDB: factory });

    expect(second.localStorageKeysRemoved).toBe(1);
    expect(second.sessionStorageKeysRemoved).toBe(1);
    expect(localStorage.getItem("first-tree:tokens")).toBeNull();
    expect(sessionStorage.getItem("first-tree:quickstart:agent")).toBeNull();
    expect(await databaseNames(factory)).toEqual([]);
  });

  it("keeps a blocked database deletion pending until the existing connection closes", async () => {
    const factory = new IDBFactory();
    const connection = await rawOpen(factory, LEGACY_DATABASE_NAMES[0]);
    let blockedResolve = (_name: string): void => undefined;
    const blocked = new Promise<string>((resolve) => {
      blockedResolve = resolve;
    });
    let completed = false;
    const scrub = scrubLegacyPersistence({
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      indexedDB: factory,
      onDatabaseBlocked: blockedResolve,
    }).then((result) => {
      completed = true;
      return result;
    });

    await expect(blocked).resolves.toBe(LEGACY_DATABASE_NAMES[0]);
    expect(completed).toBe(false);
    connection.close();
    await expect(scrub).resolves.toMatchObject({ databasesDeleted: LEGACY_DATABASE_NAMES.length });
  });

  it("fails closed when Web Storage cannot be enumerated or verified", () => {
    const safe = new MemoryStorage();
    const enumerationFailure: StorageArea = {
      get length(): number {
        throw new DOMException("denied", "SecurityError");
      },
      key: () => null,
      getItem: () => null,
      removeItem: () => undefined,
    };
    expect(() => scrubLegacyWebStorage({ localStorage: enumerationFailure, sessionStorage: safe })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.persistenceUnavailable }),
    );

    const removalFailure = new MemoryStorage();
    removalFailure.setItem("first-tree:tokens", "secret");
    const refusesRemoval: StorageArea = {
      get length() {
        return removalFailure.length;
      },
      key: (index) => removalFailure.key(index),
      getItem: (key) => removalFailure.getItem(key),
      removeItem: () => undefined,
    };
    expect(() => scrubLegacyWebStorage({ localStorage: refusesRemoval, sessionStorage: safe })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.persistenceUnavailable }),
    );
  });
});

describe("session lifecycle hooks", () => {
  it("preserves an in-flight coordinator read on ordinary hidden but cancels it on pagehide", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const registry = new ContentDatabaseRegistry();
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
    Object.defineProperty(documentTarget, "visibilityState", { configurable: true, value: "hidden" });
    const dispose = installSessionLifecycleHooks({ registry, windowTarget, documentTarget });

    const hiddenLatch = deferNextOpen(factory);
    const hiddenRead = coordinator.readAuthority();
    await hiddenLatch.started;
    dispatch(documentTarget, "visibilitychange");
    hiddenLatch.release();
    await expect(hiddenRead).resolves.toMatchObject({ mode: "none", generation: "generation-0" });

    vi.restoreAllMocks();
    const suspendLatch = deferNextOpen(factory);
    const suspendedRead = coordinator.readAuthority();
    await suspendLatch.started;
    dispatch(windowTarget, "pagehide");
    suspendLatch.release();
    await expect(suspendedRead).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    dispose();
  });

  it("veils first on hidden, cancels pending opens, and reserves full invalidation for suspend", () => {
    const registry = new ContentDatabaseRegistry();
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
    Object.defineProperty(documentTarget, "visibilityState", { configurable: true, value: "hidden" });
    const events: string[] = [];
    vi.spyOn(registry, "cancelPendingOpens").mockImplementation(() => events.push("cancel-pending"));
    vi.spyOn(registry, "closeAllHandles").mockImplementation(() => events.push("close-handles"));
    vi.spyOn(registry, "invalidateAllOperations").mockImplementation(() => events.push("invalidate-all"));
    const dispose = installSessionLifecycleHooks({
      registry,
      windowTarget,
      documentTarget,
      onVeil: () => events.push("veil"),
      onLegacyStorageScrub: () => events.push("scrub"),
    });

    dispatch(documentTarget, "visibilitychange");
    expect(events).toEqual(["veil", "scrub", "cancel-pending", "close-handles"]);

    events.length = 0;
    dispatch(windowTarget, "pagehide");
    expect(events).toEqual(["veil", "scrub", "invalidate-all"]);

    events.length = 0;
    dispatch(documentTarget, "freeze");
    expect(events).toEqual(["veil", "scrub", "invalidate-all"]);

    dispose();
    events.length = 0;
    dispatch(windowTarget, "pagehide");
    expect(events).toEqual([]);
  });

  it("continues fail-closed teardown when a caller safety hook throws", () => {
    const registry = new ContentDatabaseRegistry();
    const windowTarget = new EventTarget();
    const errors: unknown[] = [];
    const invalidate = vi.spyOn(registry, "invalidateAllOperations");
    installSessionLifecycleHooks({
      registry,
      windowTarget,
      onVeil: () => {
        throw new SessionError(sessionErrorCodes.persistenceUnavailable, "veil hook failed");
      },
      onLegacyStorageScrub: () => {
        throw new SessionError(sessionErrorCodes.persistenceUnavailable, "scrub hook failed");
      },
      onLifecycleError: (error) => errors.push(error),
    });

    expect(() => dispatch(windowTarget, "pagehide")).not.toThrow();
    expect(errors).toHaveLength(2);
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
