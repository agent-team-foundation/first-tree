import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCandidateTokenSnapshot, fingerprintCandidateTokenSnapshot } from "../session/candidate-tokens.js";
import { deleteDatabaseBarrier } from "../session/idb-delete-barrier.js";
import {
  type AccountContentOperation,
  type ActivationCertificate,
  AuthSessionCoordinator,
  CONTENT_SCOPE_LOCK_PREFIX,
  ContentDatabaseRegistry,
  type ContentDatabaseSpec,
  type ContentOperation,
  ContentScopeBarrier,
  captureAccountStoreRuntime,
  closeCoordinatorConnections,
  createAccountLease,
  createAccountScopeKey,
  createActivationCertificate,
  createCredentialRecord,
  createScopedDatabaseName,
  createSessionAttempt,
  createViewLease,
  installAccountStoreRuntime,
  installSessionLifecycleHooks,
  isDatabaseNameForScope,
  LEGACY_DATABASE_NAMES,
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

function deferNthOpen(
  factory: IDBFactory,
  targetIndex: number,
): Readonly<{
  started: Promise<void>;
  release: () => void;
}> {
  const originalOpen = factory.open.bind(factory);
  const started = deferred();
  const released = deferred();
  let index = 0;
  vi.spyOn(factory, "open").mockImplementation((name: string, version?: number) => {
    index += 1;
    const request = version === undefined ? originalOpen(name) : originalOpen(name, version);
    if (index !== targetIndex) return request;
    return new Proxy(request, {
      get(target, property) {
        return Reflect.get(target, property, target);
      },
      set(target, property, value) {
        if (property === "onsuccess" && typeof value === "function") {
          target.onsuccess = (event) => {
            started.resolve();
            void released.promise.then(() => value.call(target, event));
          };
          return true;
        }
        return Reflect.set(target, property, value, target);
      },
    });
  });
  return Object.freeze({ started: started.promise, release: () => released.resolve() });
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
  });
}

function base64Url(value: string): string {
  return btoa(value).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function jwt(accountId: string, kind: "access" | "refresh"): string {
  return `${base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify({ sub: accountId, type: kind, exp: 2_100_000_000 }),
  )}.signature`;
}

async function credential(certificate: ActivationCertificate) {
  const accessToken = jwt(certificate.accountId, "access");
  const refreshToken = jwt(certificate.accountId, "refresh");
  const fingerprinted = await fingerprintCandidateTokenSnapshot(
    createCandidateTokenSnapshot({ accessToken, refreshToken }),
    certificate.serverAuthority,
  );
  return createCredentialRecord({
    activation: certificate,
    credentialRevision: 0,
    credentialFingerprint: fingerprinted.credentialFingerprint,
    accessToken,
    refreshToken,
  });
}

const CONTENT_SPEC: ContentDatabaseSpec = {
  logicalName: "chat-content",
  namespaceVersion: 1,
  databaseVersion: 1,
  upgrade: (database) => {
    if (!database.objectStoreNames.contains("rows")) database.createObjectStore("rows");
  },
};

async function activeFixture() {
  const factory = new IDBFactory();
  const coordinator = new AuthSessionCoordinator({
    indexedDB: factory,
    legacyPersistence: {
      indexedDB: factory,
      localStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
    },
  });
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
  if (attempt.kind !== "acquisition") throw new Error("expected acquisition attempt fixture");
  await coordinator.putAttempt(attempt);
  const targetCredential = await credential(certificate);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ user: { id: certificate.accountId } }), {
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  const proof = (
    await coordinator.requestCandidateMe({
      candidate: targetCredential,
      attempt,
      serverAuthority: certificate.serverAuthority,
      signal: new AbortController().signal,
    })
  ).proof;
  const permit = await coordinator.reserveAcquisitionTransition(
    { generation: "generation-0", revision: 1 },
    proof,
    certificate,
    null,
  );
  await coordinator.completeAcquisitionTransition(permit, proof);
  const controller = new AbortController();
  const lease = createViewLease({
    activation: certificate,
    organizationId: "org-a",
    orgRevision: "org-revision-a",
    ownerTabId: "owner-tab-a",
    documentId: "document-a",
    signal: controller.signal,
  });
  const accountLease = createAccountLease({
    activation: certificate,
    accountRevision: "account-revision-a",
    ownerTabId: lease.ownerTabId,
    documentId: lease.documentId,
    signal: controller.signal,
  });
  return { factory, coordinator, certificate, controller, lease, accountLease };
}

let accountRuntimeSequence = 0;

function installFixtureAccountRuntime(
  barrier: ContentScopeBarrier,
  fixture: Awaited<ReturnType<typeof activeFixture>>,
) {
  accountRuntimeSequence += 1;
  const source = createAccountLease({
    ...fixture.accountLease,
    accountRevision: `${fixture.accountLease.accountRevision}-${accountRuntimeSequence}`,
  });
  const dispose = installAccountStoreRuntime({ barrier, lease: source });
  const runtime = captureAccountStoreRuntime(source);
  if (!runtime) throw new Error("Expected installed account runtime");
  return { dispose, runtime, source };
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

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

async function databaseNames(factory: IDBFactory): Promise<string[]> {
  const entries = await factory.databases();
  return entries.flatMap((entry) => (entry.name ? [entry.name] : []));
}

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

function purgeOptions(onBlocked?: (databaseName: string) => void) {
  return {
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    ...(onBlocked ? { onBlocked } : {}),
  };
}

afterEach(() => {
  closeCoordinatorConnections();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("account/server physical namespaces", () => {
  it("round-trips injectively and never accepts another scope as a deletion target", () => {
    const tuples = [
      ["https://a.example/api/v1", "bc"],
      ["https://a.example:8443/api/v1", "c"],
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
    const databaseName = createScopedDatabaseName("chat-content", 1, fixture.certificate.scopeKey);
    let purgeResolved = false;
    let receipt = "";
    const purge = barrier.purgeAccountScope(fixture.certificate, purgeOptions()).then((value) => {
      receipt = value;
      purgeResolved = true;
    });
    await Promise.resolve();
    expect(purgeResolved).toBe(false);
    expect(locks.events.filter((event) => event.startsWith("start:exclusive"))).toHaveLength(0);

    releaseWriter.resolve();
    await expect(write).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });
    await purge;
    expect(await databaseNames(fixture.factory)).not.toContain(databaseName);

    await fixture.coordinator.completeRetirement(fixture.certificate, receipt, "generation-none");
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
    const databaseName = createScopedDatabaseName("chat-content", 1, fixture.certificate.scopeKey);
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
    const purge = barrier.purgeAccountScope(fixture.certificate, purgeOptions(deleteBlocked));
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

  it("does not stamp cleanup when Web Storage verification fails", async () => {
    const fixture = await activeFixture();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks: new OrderedTestLocks(),
    });
    await fixture.coordinator.beginRetirement(fixture.certificate, "logout", "generation-retiring");
    const failingStorage = {
      length: 1,
      key: () => "first-tree:tokens",
      getItem: () => "plaintext-token",
      removeItem: () => undefined,
    };

    await expect(
      barrier.purgeAccountScope(fixture.certificate, {
        localStorage: failingStorage,
        sessionStorage: memoryStorage(),
      }),
    ).rejects.toMatchObject({ code: sessionErrorCodes.persistenceUnavailable });
    await expect(fixture.coordinator.readAuthority()).resolves.toMatchObject({
      mode: "retiring",
      phase: "revoked",
      cleanupReceipt: undefined,
    });
    expect("withExclusive" in barrier).toBe(false);
    expect("markPurgeComplete" in fixture.coordinator).toBe(false);
  });

  it("does not stamp cleanup when an IndexedDB deletion fails", async () => {
    const fixture = await activeFixture();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks: new OrderedTestLocks(),
    });
    await fixture.coordinator.beginRetirement(fixture.certificate, "logout", "generation-retiring");

    const failure = new DOMException("forced delete failure", "UnknownError");
    const failedRequest = {
      error: failure,
      onblocked: null,
      onerror: null,
      onsuccess: null,
    } as unknown as IDBOpenDBRequest;
    vi.spyOn(fixture.factory, "deleteDatabase").mockImplementationOnce(() => {
      queueMicrotask(() => failedRequest.onerror?.(new Event("error")));
      return failedRequest;
    });

    await expect(barrier.purgeAccountScope(fixture.certificate, purgeOptions())).rejects.toMatchObject({
      code: sessionErrorCodes.persistenceUnavailable,
    });
    await expect(fixture.coordinator.readAuthority()).resolves.toMatchObject({
      mode: "retiring",
      phase: "revoked",
      cleanupReceipt: undefined,
    });
  });

  it("reruns legacy-only cleanup for an existing source_purged receipt without deleting scoped databases", async () => {
    const fixture = await activeFixture();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks: new OrderedTestLocks(),
    });
    await fixture.coordinator.beginRetirement(fixture.certificate, "logout", "generation-terminal-purge");
    const receipt = await barrier.purgeAccountScope(fixture.certificate, purgeOptions());
    const scopedName = createScopedDatabaseName("chat-content", 1, fixture.certificate.scopeKey);
    const scoped = await rawOpen(fixture.factory, scopedName, 1, (database) => database.createObjectStore("rows"));
    const scopedWrite = scoped.transaction("rows", "readwrite");
    scopedWrite.objectStore("rows").put("new-session", "owner");
    await transactionDone(scopedWrite);
    scoped.close();
    const recreatedLegacy = await rawOpen(fixture.factory, LEGACY_DATABASE_NAMES[0], 1, (database) =>
      database.createObjectStore("rows"),
    );
    recreatedLegacy.close();
    const deleteSpy = vi.spyOn(fixture.factory, "deleteDatabase");
    const lateLocalStorage = memoryStorage({ "first-tree:tokens": "late-legacy-token" });

    await expect(
      barrier.purgeAccountScope(fixture.certificate, {
        localStorage: lateLocalStorage,
        sessionStorage: memoryStorage(),
      }),
    ).resolves.toBe(receipt);
    expect(lateLocalStorage.getItem("first-tree:tokens")).toBeNull();
    expect(deleteSpy.mock.calls.map(([name]) => name)).toEqual(LEGACY_DATABASE_NAMES);
    expect(await databaseNames(fixture.factory)).toContain(scopedName);
    expect(await databaseNames(fixture.factory)).not.toContain(LEGACY_DATABASE_NAMES[0]);
    const preserved = await rawOpen(fixture.factory, scopedName, 1);
    const preservedRead = preserved.transaction("rows", "readonly");
    await expect(requestResult(preservedRead.objectStore("rows").get("owner"))).resolves.toBe("new-session");
    preserved.close();
  });

  it("rejects an existing source_purged receipt when repeated legacy storage removal cannot be verified", async () => {
    const fixture = await activeFixture();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks: new OrderedTestLocks(),
    });
    await fixture.coordinator.beginRetirement(fixture.certificate, "logout", "generation-terminal-purge-failure");
    const receipt = await barrier.purgeAccountScope(fixture.certificate, purgeOptions());
    const deleteSpy = vi.spyOn(fixture.factory, "deleteDatabase");
    const failingStorage = {
      length: 1,
      key: () => "first-tree:tokens",
      getItem: () => "late-legacy-token",
      removeItem: () => undefined,
    };

    await expect(
      barrier.purgeAccountScope(fixture.certificate, {
        localStorage: failingStorage,
        sessionStorage: memoryStorage(),
      }),
    ).rejects.toMatchObject({ code: sessionErrorCodes.persistenceUnavailable });
    expect(deleteSpy.mock.calls.map(([name]) => name)).toEqual(LEGACY_DATABASE_NAMES);
    await expect(fixture.coordinator.readAuthority()).resolves.toMatchObject({
      mode: "retiring",
      phase: "source_purged",
      cleanupReceipt: receipt,
    });
  });

  it("rejects an old purge after a newer same-scope activation without deleting its database", async () => {
    const fixture = await activeFixture();
    const locks = new OrderedTestLocks();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks,
    });
    await fixture.coordinator.beginRetirement(fixture.certificate, "logout", "generation-retiring");
    const firstReceipt = await barrier.purgeAccountScope(fixture.certificate, purgeOptions());
    await fixture.coordinator.completeRetirement(fixture.certificate, firstReceipt, "generation-none");

    const next = createActivationCertificate({
      sessionEpoch: "epoch-a-2",
      authGeneration: "generation-a-2",
      transitionPermitId: "permit-a-2",
      serverAuthority: fixture.certificate.serverAuthority,
      accountId: fixture.certificate.accountId,
      scopeKey: fixture.certificate.scopeKey,
    });
    const nextAttempt = createSessionAttempt({
      attemptId: "attempt-a-2",
      kind: "acquisition",
      serverAuthority: next.serverAuthority,
      baselineGeneration: "generation-none",
      sourceEpoch: null,
      expiresAt: Date.now() + 60_000,
      payload: { mappedTab: "tab-a-2" },
    });
    if (nextAttempt.kind !== "acquisition") throw new Error("expected acquisition attempt fixture");
    await fixture.coordinator.putAttempt(nextAttempt);
    const nextCredential = await credential(next);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ user: { id: next.accountId } }), {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const nextProof = (
      await fixture.coordinator.requestCandidateMe({
        candidate: nextCredential,
        attempt: nextAttempt,
        serverAuthority: next.serverAuthority,
        signal: new AbortController().signal,
      })
    ).proof;
    const beforeReservation = await fixture.coordinator.readAuthority();
    const nextPermit = await fixture.coordinator.reserveAcquisitionTransition(
      { generation: beforeReservation.generation, revision: beforeReservation.revision },
      nextProof,
      next,
      null,
    );
    await fixture.coordinator.completeAcquisitionTransition(nextPermit, nextProof);

    const nextController = new AbortController();
    const nextLease = createViewLease({
      activation: next,
      organizationId: "org-a",
      orgRevision: "org-revision-a-2",
      ownerTabId: "owner-tab-a-2",
      documentId: "document-a-2",
      signal: nextController.signal,
    });
    const nextBarrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks,
    });
    await nextBarrier.withShared(nextLease, async (operation) => {
      const database = await operation.openDatabase(CONTENT_SPEC);
      await operation.runTransaction(database, "rows", "readwrite", (transaction) => {
        transaction.objectStore("rows").put("new-session", "owner");
      });
      operation.closeDatabase(database);
    });
    const databaseName = createScopedDatabaseName("chat-content", 1, next.scopeKey);
    const deleteSpy = vi.spyOn(fixture.factory, "deleteDatabase");

    await expect(barrier.purgeAccountScope(fixture.certificate, purgeOptions())).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await databaseNames(fixture.factory)).toContain(databaseName);
    await expect(fixture.coordinator.admitActivation(next)).resolves.toMatchObject({
      authority: { session: next },
    });
  });

  it("cancels a blocked purge on lifecycle suspension and lets a successor delete form the queue barrier", async () => {
    const fixture = await activeFixture();
    const locks = new OrderedTestLocks();
    const registry = new ContentDatabaseRegistry();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks,
      registry,
    });
    const databaseName = createScopedDatabaseName("chat-content", 1, fixture.certificate.scopeKey);
    const blocker = await rawOpen(fixture.factory, databaseName, 1, (database) => database.createObjectStore("rows"));
    await fixture.coordinator.beginRetirement(fixture.certificate, "logout", "generation-retiring");
    const blocked = deferred<string>();
    const first = barrier.purgeAccountScope(fixture.certificate, purgeOptions(blocked.resolve));
    await blocked.promise;

    registry.invalidateAllOperations();
    closeCoordinatorConnections();
    await expect(first).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    await expect(fixture.coordinator.readAuthority()).resolves.toMatchObject({
      mode: "retiring",
      phase: "revoked",
    });

    blocker.close();
    const receipt = await barrier.purgeAccountScope(fixture.certificate, purgeOptions());
    await expect(fixture.coordinator.readAuthority()).resolves.toMatchObject({
      mode: "retiring",
      phase: "source_purged",
      cleanupReceipt: receipt,
    });
    expect(await databaseNames(fixture.factory)).not.toContain(databaseName);
  });

  it("rejects object, callable, and hostile transaction thenables at runtime", async () => {
    const fixture = await activeFixture();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks: new OrderedTestLocks(),
    });

    await barrier.withShared(fixture.lease, async (operation) => {
      const database = await operation.openDatabase(CONTENT_SPEC);
      await expect(
        operation.runTransaction(database, "rows", "readwrite", async () => undefined),
      ).rejects.toMatchObject({ code: sessionErrorCodes.invalidState });
      // biome-ignore lint/suspicious/noThenProperty: this intentionally exercises callable thenable rejection.
      const callable = Object.assign(() => undefined, { then: () => undefined });
      await expect(operation.runTransaction(database, "rows", "readwrite", () => callable)).rejects.toMatchObject({
        code: sessionErrorCodes.invalidState,
      });
      // biome-ignore lint/suspicious/noThenProperty: this intentionally exercises a hostile then getter.
      const hostile = Object.defineProperty(() => undefined, "then", {
        get: () => {
          throw new Error("hostile getter must not escape");
        },
      });
      await expect(operation.runTransaction(database, "rows", "readwrite", () => hostile)).rejects.toMatchObject({
        code: sessionErrorCodes.invalidState,
      });
      operation.closeDatabase(database);
    });
  });

  it("rejects callable thenables returned by an upgrade without creating a usable handle", async () => {
    const fixture = await activeFixture();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks: new OrderedTestLocks(),
    });
    // biome-ignore lint/suspicious/noThenProperty: this intentionally exercises callable thenable rejection.
    const callable = Object.assign(() => undefined, { then: () => undefined });
    const spec: ContentDatabaseSpec = {
      logicalName: "callable-upgrade",
      namespaceVersion: 1,
      databaseVersion: 1,
      upgrade: (database) => {
        database.createObjectStore("rows");
        return callable;
      },
    };

    await expect(barrier.withShared(fixture.lease, (operation) => operation.openDatabase(spec))).rejects.toMatchObject({
      code: sessionErrorCodes.invalidState,
    });
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

  it.each([
    ["inside the shared holder", 3],
    ["after the shared holder releases", 5],
  ] as const)("does not deliver a result when lifecycle changes during the final admission %s", async (_label, openIndex) => {
    const fixture = await activeFixture();
    const registry = new ContentDatabaseRegistry();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks: new OrderedTestLocks(),
      registry,
    });
    const latch = deferNthOpen(fixture.factory, openIndex);
    const callback = vi.fn(() => "account-a-result");
    const shared = barrier.withShared(fixture.lease, callback);

    await latch.started;
    registry.invalidateAllOperations();
    latch.release();

    await expect(shared).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect(callback).toHaveBeenCalledTimes(1);
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

  it("uses the account scope lock without inventing an organization and keeps its capability runtime-private", async () => {
    const fixture = await activeFixture();
    const locks = new OrderedTestLocks();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks,
    });
    const { dispose: disposeAccount, runtime } = installFixtureAccountRuntime(barrier, fixture);
    let retainedOperation: AccountContentOperation | undefined;
    let retainedDatabase: IDBDatabase | undefined;

    await runtime.withShared(async (operation) => {
      retainedOperation = operation;
      expect(operation.lease.accountRevision).toBe(runtime.sourceLease.accountRevision);
      expect(operation.lease.signal).toBe(runtime.lease.signal);
      expect("organizationId" in operation.lease).toBe(false);
      expect(Reflect.ownKeys(operation)).toEqual([]);
      expect(Reflect.get(operation, "barrier")).toBeUndefined();
      expect(Reflect.get(operation, "token")).toBeUndefined();
      expect(Reflect.get(operation, "#barrier")).toBeUndefined();
      expect(Reflect.get(operation, "#token")).toBeUndefined();
      expect(operation.physicalDatabaseName(CONTENT_SPEC)).toBe(
        createScopedDatabaseName("chat-content", 1, fixture.certificate.scopeKey),
      );

      retainedDatabase = await operation.openDatabase(CONTENT_SPEC);
      await operation.runTransaction(retainedDatabase, "rows", "readwrite", (transaction) => {
        transaction.objectStore("rows").put("org-a", "selected-organization");
      });
    });

    expect(locks.events).toContain(`start:shared:${CONTENT_SCOPE_LOCK_PREFIX}${fixture.certificate.scopeKey}`);
    if (!retainedOperation || !retainedDatabase) throw new Error("Expected retained account operation fixture");
    await expect(retainedOperation.openDatabase(CONTENT_SPEC)).rejects.toMatchObject({
      code: sessionErrorCodes.staleOperation,
    });
    await expect(
      retainedOperation.runTransaction(retainedDatabase, "rows", "readwrite", (transaction) => {
        transaction.objectStore("rows").put("org-b", "selected-organization");
      }),
    ).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    retainedOperation.closeDatabase(retainedDatabase);
    disposeAccount();
  });

  it.each([
    "abort",
    "pagehide",
    "freeze",
  ] as const)("cancels an in-flight account operation on %s before delivery", async (eventName) => {
    const fixture = await activeFixture();
    const registry = new ContentDatabaseRegistry();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks: new OrderedTestLocks(),
      registry,
    });
    const entered = deferred();
    const release = deferred();
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const disposeLifecycle = installSessionLifecycleHooks({ registry, windowTarget, documentTarget });
    const { dispose: disposeAccount, runtime } = installFixtureAccountRuntime(barrier, fixture);
    const shared = runtime.withShared(async () => {
      entered.resolve();
      await release.promise;
      return "stale-result";
    });
    await entered.promise;

    if (eventName === "abort") fixture.controller.abort();
    else if (eventName === "pagehide") windowTarget.dispatchEvent(new Event("pagehide"));
    else documentTarget.dispatchEvent(new Event("freeze"));

    await expect(shared).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    release.resolve();
    disposeLifecycle();
    disposeAccount();
  });

  it("does not enter an account callback after the activation begins retirement", async () => {
    const fixture = await activeFixture();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks: new OrderedTestLocks(),
    });
    const { dispose: disposeAccount, runtime } = installFixtureAccountRuntime(barrier, fixture);
    await fixture.coordinator.beginRetirement(fixture.certificate, "logout", "generation-retiring-account");
    const callback = vi.fn();

    await expect(runtime.withShared(callback)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    expect(callback).not.toHaveBeenCalled();
    disposeAccount();
  });

  it("keeps barrier authority runtime-private and revokes a retained operation when its callback settles", async () => {
    const fixture = await activeFixture();
    const barrier = new ContentScopeBarrier({
      coordinator: fixture.coordinator,
      indexedDB: fixture.factory,
      locks: new OrderedTestLocks(),
    });
    let retainedOperation: ContentOperation | undefined;
    let retainedDatabase: IDBDatabase | undefined;

    await barrier.withShared(fixture.lease, async (operation) => {
      retainedOperation = operation;
      expect(Reflect.ownKeys(operation)).toEqual([]);
      expect(Reflect.get(operation, "barrier")).toBeUndefined();
      expect(Reflect.get(operation, "token")).toBeUndefined();
      expect(Reflect.get(operation, "#barrier")).toBeUndefined();
      expect(Reflect.get(operation, "#token")).toBeUndefined();

      retainedDatabase = await operation.openDatabase(CONTENT_SPEC);
      await operation.runTransaction(retainedDatabase, "rows", "readwrite", (transaction) => {
        transaction.objectStore("rows").put("account-a", "owner");
      });
    });

    if (!retainedOperation || !retainedDatabase) throw new Error("Expected retained operation fixture");
    const staleOperation = retainedOperation;
    const staleDatabase = retainedDatabase;
    expect(Reflect.ownKeys(staleOperation)).toEqual([]);
    expect(Reflect.get(staleOperation, "barrier")).toBeUndefined();
    expect(Reflect.get(staleOperation, "token")).toBeUndefined();
    expect(() => staleOperation.assertOrganization("org-b")).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.admissionDenied }),
    );
    await expect(staleOperation.openDatabase(CONTENT_SPEC)).rejects.toMatchObject({
      code: sessionErrorCodes.staleOperation,
    });
    await expect(
      staleOperation.runTransaction(staleDatabase, "rows", "readwrite", (transaction) => {
        transaction.objectStore("rows").put("account-b", "owner");
      }),
    ).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    staleOperation.closeDatabase(staleDatabase);
  });
});
