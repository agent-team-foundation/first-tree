import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ActivationCertificate,
  AuthSessionCoordinator,
  CONTENT_SCOPE_LOCK_PREFIX,
  ContentDatabaseRegistry,
  type ContentDatabaseSpec,
  ContentScopeBarrier,
  closeCoordinatorConnections,
  createAccountScopeKey,
  createActivationCertificate,
  createCredentialRecord,
  createScopedDatabaseName,
  createSessionAttempt,
  createTransitionPermit,
  createViewLease,
  deleteDatabaseBarrier,
  isDatabaseNameForScope,
  parseAccountScopeKey,
  SessionError,
  type SessionLockManager,
  type SessionLockMode,
  type SessionLockOptions,
  sessionErrorCodes,
} from "../session/index.js";

type Deferred<T = void> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}>;

type LockWaiter<T = unknown> = {
  mode: SessionLockMode;
  callback: () => T | PromiseLike<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  started: boolean;
};

type LockState = {
  readers: number;
  writer: boolean;
  queue: LockWaiter[];
};

class OrderedTestLocks implements SessionLockManager {
  public readonly events: string[] = [];
  private readonly states = new Map<string, LockState>();

  public request<T>(name: string, options: SessionLockOptions, callback: () => T | PromiseLike<T>): Promise<T> {
    const state = this.states.get(name) ?? { readers: 0, writer: false, queue: [] };
    this.states.set(name, state);
    return new Promise<T>((resolve, reject) => {
      const waiter: LockWaiter<T> = {
        mode: options.mode,
        callback,
        resolve,
        reject,
        signal: options.signal,
        started: false,
      };
      const abort = (): void => {
        if (waiter.started) return;
        const index = state.queue.indexOf(waiter as LockWaiter);
        if (index >= 0) state.queue.splice(index, 1);
        reject(new DOMException("Lock request was cancelled", "AbortError"));
        this.pump(name, state);
      };
      waiter.abortListener = abort;
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      state.queue.push(waiter as LockWaiter);
      this.pump(name, state);
    });
  }

  private pump(name: string, state: LockState): void {
    if (state.writer) return;
    if (state.readers > 0 && state.queue[0]?.mode === "exclusive") return;
    while (state.queue.length > 0) {
      const next = state.queue[0];
      if (!next) return;
      if (next.mode === "exclusive") {
        if (state.readers > 0) return;
        state.queue.shift();
        state.writer = true;
        this.start(name, state, next);
        return;
      }
      state.queue.shift();
      state.readers += 1;
      this.start(name, state, next);
      if (state.queue[0]?.mode === "exclusive") return;
    }
  }

  private start(name: string, state: LockState, waiter: LockWaiter): void {
    waiter.started = true;
    waiter.signal?.removeEventListener("abort", waiter.abortListener ?? (() => undefined));
    this.events.push(`start:${waiter.mode}:${name}`);
    Promise.resolve()
      .then(waiter.callback)
      .then(waiter.resolve, waiter.reject)
      .finally(() => {
        this.events.push(`finish:${waiter.mode}:${name}`);
        if (waiter.mode === "exclusive") state.writer = false;
        else state.readers -= 1;
        this.pump(name, state);
      });
  }
}

function deferred<T = void>(): Deferred<T> {
  let resolve = (_value: T): void => undefined;
  let reject = (_error: unknown): void => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const SERVER_AUTHORITY = "https://hub.example.test/api/v1";

function activation(label: string, generation = `generation-${label}`): ActivationCertificate {
  const accountId = `account-${label}`;
  return createActivationCertificate({
    sessionEpoch: `epoch-${label}`,
    authGeneration: generation,
    transitionPermitId: `permit-${label}`,
    serverAuthority: SERVER_AUTHORITY,
    accountId,
    scopeKey: createAccountScopeKey(SERVER_AUTHORITY, accountId),
    credentialRevision: 0,
    credentialFingerprint: `fingerprint-${label}`,
  });
}

function credential(certificate: ActivationCertificate) {
  return createCredentialRecord({
    activation: certificate,
    accessToken: `access-${certificate.sessionEpoch}`,
    refreshToken: `refresh-${certificate.sessionEpoch}`,
  });
}

const CONTENT_SPEC: ContentDatabaseSpec = {
  logicalName: "messages",
  namespaceVersion: 1,
  databaseVersion: 1,
  upgrade: (database) => {
    if (!database.objectStoreNames.contains("rows")) database.createObjectStore("rows");
  },
};

async function activeFixture() {
  const factory = new IDBFactory();
  const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
  await coordinator.bootstrapAnonymous("generation-0");
  const certificate = activation("a");
  const attempt = createSessionAttempt({
    attemptId: "attempt-a",
    kind: "acquisition",
    serverAuthority: SERVER_AUTHORITY,
    baselineGeneration: "generation-0",
    sourceEpoch: null,
    expiresAt: Date.now() + 60_000,
    payload: { mappedTab: "tab-a" },
  });
  await coordinator.putAttempt(attempt);
  const permit = createTransitionPermit({
    permitId: certificate.transitionPermitId,
    attemptId: attempt.attemptId,
    target: certificate,
    expiresAt: Date.now() + 60_000,
  });
  await coordinator.reserveTransition(
    { generation: "generation-0", revision: 1 },
    permit,
    null,
    "null-source-attempt-a",
  );
  await coordinator.completeTransition(permit, credential(certificate), "null-source-attempt-a");
  const controller = new AbortController();
  const lease = createViewLease({
    activation: certificate,
    organizationId: "org-a",
    orgRevision: "org-revision-a",
    documentId: "document-a",
    signal: controller.signal,
  });
  return { factory, coordinator, certificate, controller, lease };
}

function rawOpen(
  factory: IDBFactory,
  name: string,
  version: number,
  upgrade?: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function databaseNames(factory: IDBFactory): Promise<string[]> {
  const entries = await factory.databases();
  return entries.flatMap((entry) => (entry.name ? [entry.name] : []));
}

afterEach(() => closeCoordinatorConnections());

describe("account/server physical namespaces", () => {
  it("round-trips injectively and never accepts another scope as a deletion target", () => {
    const tuples = [
      ["https://a.example/api/v1", "bc"],
      ["https://a.example/api/v1b", "c"],
      ["https://b.example/api/v1", "a:b"],
      ["https://a.example/api/v1", "account:with:delimiters"],
    ] as const;
    const keys = tuples.map(([authority, accountId]) => createAccountScopeKey(authority, accountId));
    expect(new Set(keys).size).toBe(tuples.length);
    for (let index = 0; index < tuples.length; index += 1) {
      const tuple = tuples[index];
      const key = keys[index];
      if (!tuple || !key) throw new Error("Missing tuple fixture");
      expect(parseAccountScopeKey(key)).toEqual({ serverAuthority: tuple[0], accountId: tuple[1] });
    }

    const firstName = createScopedDatabaseName("messages", 1, keys[0] ?? "");
    expect(isDatabaseNameForScope(firstName, keys[0] ?? "")).toBe(true);
    expect(isDatabaseNameForScope(firstName, keys[1] ?? "")).toBe(false);
    expect(isDatabaseNameForScope(`messages:v0:${keys[0]}`, keys[0] ?? "")).toBe(false);
    expect(isDatabaseNameForScope(`messages:v01:${keys[0]}`, keys[0] ?? "")).toBe(false);
  });
});

describe("ContentScopeBarrier", () => {
  it("holds the shared lock through a writer and lets exclusive purge delete its result", async () => {
    const fixture = await activeFixture();
    const locks = new OrderedTestLocks();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks,
    });
    const writerEntered = deferred();
    const releaseWriter = deferred();
    const write = barrier.withShared(fixture.lease, async (operation) => {
      const database = await operation.openDatabase(CONTENT_SPEC);
      await operation.runTransaction(database, "rows", "readwrite", (transaction) => {
        transaction.objectStore("rows").put("secret-a", "chat-a");
      });
      operation.closeDatabase(database);
      writerEntered.resolve();
      await releaseWriter.promise;
    });
    await writerEntered.promise;

    await fixture.coordinator.beginRetirement(fixture.certificate, "logout", "generation-retiring");
    const databaseName = createScopedDatabaseName("messages", 1, fixture.certificate.scopeKey);
    let purgeResolved = false;
    const purge = barrier
      .withExclusive(fixture.certificate, (operation) => operation.deleteDatabases([databaseName]))
      .then(() => {
        purgeResolved = true;
      });
    await Promise.resolve();
    expect(purgeResolved).toBe(false);
    expect(locks.events.filter((event) => event.startsWith("start:exclusive"))).toHaveLength(0);

    releaseWriter.resolve();
    await expect(write).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });
    await purge;
    expect(await databaseNames(fixture.factory)).not.toContain(databaseName);

    await fixture.coordinator.markPurgeComplete(fixture.certificate, "receipt-a");
    await fixture.coordinator.completeRetirement(fixture.certificate, "receipt-a", "generation-none");
    const staleCallback = vi.fn();
    await expect(barrier.withShared(fixture.lease, staleCallback)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    expect(staleCallback).not.toHaveBeenCalled();
    expect(await databaseNames(fixture.factory)).not.toContain(databaseName);
  });

  it("cancels a pending stale upgrade, releases its shared lock, and lets the successor delete win", async () => {
    const fixture = await activeFixture();
    const locks = new OrderedTestLocks();
    const registry = new ContentDatabaseRegistry();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks,
      registry,
    });
    const databaseName = createScopedDatabaseName("messages", 1, fixture.certificate.scopeKey);
    const blocker = await rawOpen(fixture.factory, databaseName, 1, (database) => {
      database.createObjectStore("rows");
    });
    const openBlocked = deferred<string>();
    const upgrade = vi.fn();
    const staleOpen = barrier.withShared(fixture.lease, async (operation) => {
      await operation.openDatabase({
        ...CONTENT_SPEC,
        databaseVersion: 2,
        upgrade,
        onBlocked: openBlocked.resolve,
      });
    });
    await openBlocked.promise;

    registry.cancelPendingOpens();
    await expect(staleOpen).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    await fixture.coordinator.beginRetirement(fixture.certificate, "logout", "generation-retiring");

    const deleteBlocked = vi.fn();
    const purge = barrier.withExclusive(
      fixture.certificate,
      (operation) => operation.deleteDatabases([databaseName]),
      deleteBlocked,
    );
    await Promise.resolve();
    blocker.close();
    await purge;

    expect(upgrade).not.toHaveBeenCalled();
    expect(await databaseNames(fixture.factory)).not.toContain(databaseName);
  });

  it("keeps a blocked delete pending and tolerates a successor delete queued behind it", async () => {
    const factory = new IDBFactory();
    const database = await rawOpen(factory, "blocked-delete", 1, (opened) => opened.createObjectStore("rows"));
    const firstBlocked = deferred<string>();
    const secondBlocked = vi.fn();
    let firstResolved = false;
    let secondResolved = false;
    const first = deleteDatabaseBarrier(factory, "blocked-delete", firstBlocked.resolve).then(() => {
      firstResolved = true;
    });
    const second = deleteDatabaseBarrier(factory, "blocked-delete", secondBlocked).then(() => {
      secondResolved = true;
    });

    await firstBlocked.promise;
    expect(firstResolved).toBe(false);
    expect(secondResolved).toBe(false);
    database.close();
    await Promise.all([first, second]);
    expect(await databaseNames(factory)).not.toContain("blocked-delete");
  });

  it("aborts queued lock admission on lifecycle invalidation", async () => {
    const fixture = await activeFixture();
    const locks = new OrderedTestLocks();
    const registry = new ContentDatabaseRegistry();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks,
      registry,
    });
    const lockName = `${CONTENT_SCOPE_LOCK_PREFIX}${fixture.certificate.scopeKey}`;
    const blockerEntered = deferred();
    const releaseBlocker = deferred();
    const blocker = locks.request(lockName, { mode: "exclusive" }, async () => {
      blockerEntered.resolve();
      await releaseBlocker.promise;
    });
    await blockerEntered.promise;

    const callback = vi.fn();
    const queued = barrier.withShared(fixture.lease, callback);
    await Promise.resolve();
    registry.invalidateAllOperations();
    await expect(queued).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect(callback).not.toHaveBeenCalled();
    releaseBlocker.resolve();
    await blocker;
  });

  it("fails closed without IndexedDB or Web Locks", async () => {
    const fixture = await activeFixture();
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    try {
      expect(
        () => new ContentScopeBarrier({ coordinator: fixture.coordinator, indexedDB: fixture.factory }),
      ).toThrowError(expect.objectContaining({ code: sessionErrorCodes.platformUnavailable }));
    } finally {
      if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      else delete (globalThis as { navigator?: Navigator }).navigator;
    }

    const original = globalThis.indexedDB;
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    try {
      expect(
        () => new ContentScopeBarrier({ coordinator: fixture.coordinator, locks: new OrderedTestLocks() }),
      ).toThrowError(expect.objectContaining({ code: sessionErrorCodes.persistenceUnavailable }));
    } finally {
      globalThis.indexedDB = original;
    }
  });

  it("rejects cross-organization access and cleans up a transaction start failure", async () => {
    const fixture = await activeFixture();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks: new OrderedTestLocks(),
    });
    await barrier.withShared(fixture.lease, async (operation) => {
      expect(() => operation.assertOrganization("org-b")).toThrowError(
        expect.objectContaining({ code: sessionErrorCodes.admissionDenied }),
      );
      const database = await operation.openDatabase(CONTENT_SPEC);
      await expect(
        operation.runTransaction(database, "rows", "readwrite", () => {
          throw new SessionError(sessionErrorCodes.invalidState, "start failed");
        }),
      ).rejects.toMatchObject({ code: sessionErrorCodes.invalidState });
      operation.closeDatabase(database);
    });
  });
});
