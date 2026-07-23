import { IDBDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountStateStore } from "../../api/account-state-store.js";
import {
  type BrowserSessionAuthorityProbe,
  type BrowserSessionNoticeTransportFactory,
  type BrowserSessionProjection,
  BrowserSessionRuntime,
  type BrowserSessionStorage,
  OWNER_TAB_STORAGE_KEY,
} from "../browser-session-runtime.js";
import { ORGANIZATION_NAVIGATION_LOCK_PREFIX } from "../selected-organization.js";
import {
  AuthSessionCoordinator,
  CONTENT_SCOPE_LOCK_PREFIX,
  ContentDatabaseRegistry,
  ContentScopeBarrier,
  type CrossDocumentAuthNotice,
  type CrossDocumentNoticeDelivery,
  type CrossDocumentNoticeTransport,
  captureAccountStoreRuntime,
  captureContentStoreRuntime,
  closeCoordinatorConnections,
  createAccountLease,
  createAccountScopeKey,
  createActivationCertificate,
  createScopedDatabaseName,
  createSessionAttempt,
  installAccountStoreRuntime,
  LEGACY_DATABASE_NAMES,
  SessionError,
  type SessionLockManager,
  type SessionLockOptions,
  sessionErrorCodes,
} from "../session/index.js";

const SERVER_AUTHORITY = "https://hub.example.test/api/v1";

class MemoryStorage implements BrowserSessionStorage {
  readonly #values = new Map<string, string>();
  #refusedRemoval: string | null = null;

  public get length(): number {
    return this.#values.size;
  }

  public key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  public getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }

  public removeItem(key: string): void {
    if (key !== this.#refusedRemoval) this.#values.delete(key);
  }

  public refuseRemoval(key: string): void {
    this.#refusedRemoval = key;
  }

  public allowRemoval(): void {
    this.#refusedRemoval = null;
  }
}

class MutableDocumentTarget extends EventTarget {
  public visibilityState: DocumentVisibilityState = "visible";
}

class ImmediateLocks implements SessionLockManager {
  public request<T>(_name: string, options: SessionLockOptions, callback: () => T | PromiseLike<T>): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(new DOMException("Lock cancelled", "AbortError"));
    return Promise.resolve().then(callback);
  }
}

class PurgeGateLocks extends ImmediateLocks {
  #held = false;
  #release = (): void => undefined;
  readonly purgeStarted: Promise<void>;
  #start = (): void => undefined;

  public constructor() {
    super();
    this.purgeStarted = new Promise<void>((resolve) => {
      this.#start = resolve;
    });
  }

  public holdPurge(): void {
    this.#held = true;
  }

  public releasePurge(): void {
    this.#release();
  }

  public override async request<T>(
    name: string,
    options: SessionLockOptions,
    callback: () => T | PromiseLike<T>,
  ): Promise<T> {
    if (this.#held && name.startsWith(CONTENT_SCOPE_LOCK_PREFIX)) {
      this.#start();
      await new Promise<void>((resolve) => {
        this.#release = resolve;
      });
      this.#held = false;
    }
    return super.request(name, options, callback);
  }
}

class NavigationDeliveryGateLocks extends ImmediateLocks {
  #held = false;
  #release = (): void => undefined;
  readonly navigationCommitted: Promise<void>;
  #markCommitted = (): void => undefined;

  public constructor() {
    super();
    this.navigationCommitted = new Promise<void>((resolve) => {
      this.#markCommitted = resolve;
    });
  }

  public holdNavigationDelivery(): void {
    this.#held = true;
  }

  public releaseNavigationDelivery(): void {
    this.#release();
  }

  public override async request<T>(
    name: string,
    options: SessionLockOptions,
    callback: () => T | PromiseLike<T>,
  ): Promise<T> {
    const result = await super.request(name, options, callback);
    if (this.#held && name.startsWith(ORGANIZATION_NAVIGATION_LOCK_PREFIX)) {
      this.#markCommitted();
      await new Promise<void>((resolve) => {
        this.#release = resolve;
      });
      this.#held = false;
    }
    return result;
  }
}

type SeededActive = Readonly<{
  activation: ReturnType<typeof createActivationCertificate>;
  barrier: ContentScopeBarrier;
  coordinator: AuthSessionCoordinator;
}>;

type RuntimeHarness = Readonly<{
  authority: {
    pin: ReturnType<typeof vi.fn<BrowserSessionAuthorityProbe["pin"]>>;
    reconcile: ReturnType<typeof vi.fn<BrowserSessionAuthorityProbe["reconcile"]>>;
  };
  documentTarget: MutableDocumentTarget;
  runtime: BrowserSessionRuntime;
  notices: ManualNoticeHarness;
  windowTarget: EventTarget;
}>;

class ManualNoticeHarness {
  available = true;
  sourceDelivery: CrossDocumentNoticeDelivery = Object.freeze({ broadcast: true, storage: true });
  authorityDelivery: CrossDocumentNoticeDelivery = Object.freeze({ broadcast: true, storage: true });
  readonly retiredEpochs: string[] = [];
  authorityAdvancedCount = 0;
  disposed = false;
  #handler: ((notice: CrossDocumentAuthNotice) => void) | null = null;
  #revision = 0;

  public readonly factory: BrowserSessionNoticeTransportFactory = (onNotice) => {
    this.#handler = onNotice;
    const transport: CrossDocumentNoticeTransport = Object.freeze({
      available: this.available,
      publishSourceRetired: (sessionEpoch) => {
        this.retiredEpochs.push(sessionEpoch);
        return this.sourceDelivery;
      },
      publishAuthorityAdvanced: () => {
        this.authorityAdvancedCount += 1;
        return this.authorityDelivery;
      },
      dispose: () => {
        this.disposed = true;
        this.#handler = null;
      },
    });
    return transport;
  };

  public deliverSourceRetired(sessionEpoch: string): void {
    this.#revision += 1;
    this.#handler?.(Object.freeze({ v: 1, kind: "source-retired", eventId: `source-${this.#revision}`, sessionEpoch }));
  }

  public deliverAuthorityAdvanced(): void {
    this.#revision += 1;
    this.#handler?.(Object.freeze({ v: 1, kind: "authority-advanced", eventId: `authority-${this.#revision}` }));
  }
}

let currentRuntime: BrowserSessionRuntime | null = null;

function base64Url(value: string): string {
  return btoa(value).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function jwt(accountId: string, kind: "access" | "refresh", marker: string, expiresAt = 2_100_000_000): string {
  return `${base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify({ sub: accountId, type: kind, exp: expiresAt, marker }),
  )}.signature`;
}

function ids(label: string): () => string {
  let revision = 0;
  return () => `${label}-${++revision}`;
}

function activeMe(accountId: string, memberships: readonly string[], defaultOrganizationId: string | null): Response {
  return new Response(
    JSON.stringify({
      user: { id: accountId, email: `${accountId}@example.test` },
      memberships: memberships.map((organizationId) => ({ organizationId })),
      defaultOrganizationId,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function deferredResponse(): Readonly<{
  promise: Promise<Response>;
  resolve: (response: Response) => void;
}> {
  let resolve = (_response: Response): void => undefined;
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return Object.freeze({ promise, resolve });
}

function deferredValue<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return Object.freeze({ promise, resolve });
}

function rawOpen(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("rows");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new DOMException("Transaction aborted", "AbortError"));
    transaction.onerror = () => reject(transaction.error ?? new DOMException("Transaction failed", "UnknownError"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putRawRow(factory: IDBFactory, databaseName: string, key: string, value: string): Promise<void> {
  const database = await rawOpen(factory, databaseName);
  const transaction = database.transaction("rows", "readwrite");
  transaction.objectStore("rows").put(value, key);
  await transactionDone(transaction);
  database.close();
}

async function readRawRow(factory: IDBFactory, databaseName: string, key: string): Promise<unknown> {
  const database = await rawOpen(factory, databaseName);
  const transaction = database.transaction("rows", "readonly");
  const value = await requestResult(transaction.objectStore("rows").get(key));
  await transactionDone(transaction);
  database.close();
  return value;
}

async function overwriteSelectedOrganization(
  factory: IDBFactory,
  activation: SeededActive["activation"],
  ownerTabId: string,
  organizationId: string,
  orgRevision: string,
): Promise<void> {
  const databaseName = createScopedDatabaseName("first-tree-account-state", 1, activation.scopeKey);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => reject(new Error("Expected the account-state database to exist"));
  });
  const transaction = database.transaction("entries", "readwrite");
  transaction.objectStore("entries").put({
    v: 1,
    sessionEpoch: activation.sessionEpoch,
    partitionKind: "account",
    partitionId: "account",
    kind: "selected-organization",
    tabId: ownerTabId,
    key: "current",
    value: { state: "selected", organizationId, orgRevision },
    updatedAt: Date.now(),
  });
  await transactionDone(transaction);
  database.close();
}

async function seedActive(
  factory: IDBFactory,
  localStorage: MemoryStorage,
  sessionStorage: MemoryStorage,
  locks: SessionLockManager,
  label: string,
  expiresAt: Readonly<{ access: number; refresh: number }> = {
    access: 2_100_000_000,
    refresh: 2_100_000_000,
  },
  serverAuthority = SERVER_AUTHORITY,
  closeConnections = true,
): Promise<SeededActive> {
  const coordinator = new AuthSessionCoordinator({
    indexedDB: factory,
    legacyPersistence: { indexedDB: factory, localStorage, sessionStorage },
  });
  const anonymous = await coordinator.bootstrapAnonymous(`anonymous-${label}`);
  if (anonymous.mode !== "none") throw new Error("Expected anonymous seed authority");
  const accountId = `account-${label}`;
  const activation = createActivationCertificate({
    sessionEpoch: `epoch-${label}`,
    authGeneration: `active-${label}`,
    transitionPermitId: `permit-${label}`,
    serverAuthority,
    accountId,
    scopeKey: createAccountScopeKey(serverAuthority, accountId),
  });
  const attempt = createSessionAttempt({
    kind: "acquisition",
    attemptId: `attempt-${label}`,
    serverAuthority,
    baselineGeneration: anonymous.generation,
    sourceEpoch: null,
    expiresAt: Date.now() + 60_000,
    payload: {},
  });
  if (attempt.kind !== "acquisition") throw new Error("Expected acquisition attempt");
  await coordinator.putAttempt(attempt);
  const cursor = await coordinator.readAuthority();
  const candidateFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ user: { id: accountId } }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  let verified: Awaited<ReturnType<AuthSessionCoordinator["requestCandidateMe"]>>;
  try {
    verified = await coordinator.requestCandidateMe({
      attempt,
      serverAuthority,
      candidate: {
        accessToken: jwt(accountId, "access", label, expiresAt.access),
        refreshToken: jwt(accountId, "refresh", label, expiresAt.refresh),
      },
      signal: new AbortController().signal,
    });
  } finally {
    candidateFetch.mockRestore();
  }
  const permit = await coordinator.reserveAcquisitionTransition(
    { generation: cursor.generation, revision: cursor.revision },
    verified.proof,
    activation,
    null,
  );
  await coordinator.completeAcquisitionTransition(permit, verified.proof);
  if (closeConnections) closeCoordinatorConnections();
  return Object.freeze({
    activation,
    coordinator,
    barrier: new ContentScopeBarrier({
      coordinator,
      indexedDB: factory,
      locks,
      registry: new ContentDatabaseRegistry(),
    }),
  });
}

async function reserveReplacementTransition(
  source: SeededActive,
  label: string,
): Promise<ReturnType<typeof createActivationCertificate>> {
  const authority = await source.coordinator.readAuthority();
  if (authority.mode !== "active") throw new Error("Expected active replacement source");
  const targetAccountId = `account-${label}`;
  const candidateAttempt = createSessionAttempt({
    kind: "acquisition",
    attemptId: `attempt-${label}`,
    serverAuthority: source.activation.serverAuthority,
    baselineGeneration: authority.generation,
    sourceEpoch: source.activation.sessionEpoch,
    expiresAt: Date.now() + 60_000,
    payload: {},
  });
  if (candidateAttempt.kind !== "acquisition") throw new Error("Expected acquisition attempt");
  await source.coordinator.putAttempt(candidateAttempt);
  const cursor = await source.coordinator.readAuthority();
  const candidateFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ user: { id: targetAccountId } }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  let candidate: Awaited<ReturnType<AuthSessionCoordinator["requestCandidateMe"]>>;
  try {
    candidate = await source.coordinator.requestCandidateMe({
      attempt: candidateAttempt,
      serverAuthority: source.activation.serverAuthority,
      candidate: {
        accessToken: jwt(targetAccountId, "access", label),
        refreshToken: jwt(targetAccountId, "refresh", label),
      },
      signal: new AbortController().signal,
    });
  } finally {
    candidateFetch.mockRestore();
  }
  const target = createActivationCertificate({
    sessionEpoch: `epoch-${label}`,
    authGeneration: `generation-${label}`,
    transitionPermitId: `permit-${label}`,
    serverAuthority: source.activation.serverAuthority,
    accountId: targetAccountId,
    scopeKey: createAccountScopeKey(source.activation.serverAuthority, targetAccountId),
  });
  await source.coordinator.reserveAcquisitionTransition(
    { generation: cursor.generation, revision: cursor.revision },
    candidate.proof,
    target,
    source.activation,
  );
  return target;
}

async function seedSelectedOrganization(
  seeded: SeededActive,
  ownerTabId: string,
  organizationId: string,
  orgRevision: string,
): Promise<void> {
  const controller = new AbortController();
  const lease = createAccountLease({
    activation: seeded.activation,
    accountRevision: `seed-account-${orgRevision}`,
    ownerTabId,
    documentId: `seed-document-${orgRevision}`,
    signal: controller.signal,
  });
  const dispose = installAccountStoreRuntime({ barrier: seeded.barrier, lease });
  try {
    await new AccountStateStore().putAccountEntry(lease, {
      kind: "selected-organization",
      key: "current",
      tabId: ownerTabId,
      value: { state: "selected", organizationId, orgRevision },
      updatedAt: 1,
    });
  } finally {
    controller.abort();
    dispose();
  }
}

function createRuntime(
  factory: IDBFactory,
  localStorage: MemoryStorage,
  sessionStorage: MemoryStorage,
  locks: SessionLockManager,
  activation: SeededActive["activation"],
  label: string,
  notices = new ManualNoticeHarness(),
  onDatabaseBlocked?: (databaseName: string) => void,
): RuntimeHarness {
  const authority = {
    pin: vi.fn<BrowserSessionAuthorityProbe["pin"]>().mockResolvedValue(activation.serverAuthority),
    reconcile: vi
      .fn<BrowserSessionAuthorityProbe["reconcile"]>()
      .mockResolvedValue({ kind: "match", authority: activation.serverAuthority }),
  };
  const windowTarget = new EventTarget();
  const documentTarget = new MutableDocumentTarget();
  const runtime = new BrowserSessionRuntime({
    indexedDB: factory,
    locks,
    localStorage,
    sessionStorage,
    authority,
    createId: ids(label),
    windowTarget,
    documentTarget,
    noticeTransportFactory: notices.factory,
    ...(onDatabaseBlocked === undefined ? {} : { onDatabaseBlocked }),
  });
  currentRuntime = runtime;
  return Object.freeze({ authority, documentTarget, notices, runtime, windowTarget });
}

function activeProjection(value: BrowserSessionProjection): Extract<BrowserSessionProjection, { kind: "active" }> {
  if (value.kind !== "active") throw new Error(`Expected active projection, received ${value.kind}`);
  return value;
}

afterEach(() => {
  currentRuntime?.dispose();
  currentRuntime = null;
  closeCoordinatorConnections();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BrowserSessionRuntime", () => {
  it("buffers a pre-start retirement notice until repeated legacy cleanup and fresh boot authority complete", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-pre-start-notice");
    localStorage.setItem("first-tree:tokens", "legacy-secret");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "pre-start-notice");
    localStorage.setItem("first-tree:tokens", "late-legacy-secret");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-pre-start-notice",
    );
    const open = vi.spyOn(factory, "open");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    open.mockClear();

    harness.notices.deliverSourceRetired(seeded.activation.sessionEpoch);

    expect(open).not.toHaveBeenCalled();
    expect(harness.authority.pin).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "veiled", reason: "boot" });

    await expect(harness.runtime.start()).resolves.toMatchObject({ kind: "active" });
    expect(localStorage.getItem("first-tree:tokens")).toBeNull();
    expect(harness.authority.pin).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps notices gated after a failed boot scrub until a later exact scrub succeeds", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-failed-boot-scrub-notice");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "failed-boot-scrub-notice");
    localStorage.setItem("first-tree:tokens", "late-legacy-secret");
    localStorage.refuseRemoval("first-tree:tokens");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-failed-boot-scrub-notice",
    );
    const external = new AuthSessionCoordinator({
      indexedDB: factory,
      legacyPersistence: { indexedDB: factory, localStorage, sessionStorage },
    });
    await external.beginRetirement(seeded.activation, "logout", "failed-boot-scrub-retiring");
    const receipt = await seeded.barrier.purgeAccountScope(seeded.activation, {
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
    });
    await external.completeRetirement(seeded.activation, receipt, "failed-boot-scrub-none");
    harness.notices.deliverAuthorityAdvanced();
    const fetch = vi.spyOn(globalThis, "fetch");

    await expect(harness.runtime.start()).resolves.toMatchObject({ kind: "recovery" });
    expect(localStorage.getItem("first-tree:tokens")).toBe("late-legacy-secret");
    expect(harness.authority.pin).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    harness.notices.deliverSourceRetired(seeded.activation.sessionEpoch);
    localStorage.allowRemoval();
    await expect(harness.runtime.resume()).resolves.toEqual({ kind: "anonymous" });
    expect(localStorage.getItem("first-tree:tokens")).toBeNull();
    expect(harness.authority.pin).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not reconcile a notice while repeated legacy database deletion is blocked", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-blocked-boot-notice");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "blocked-boot-notice");
    const blocker = await rawOpen(factory, LEGACY_DATABASE_NAMES[0]);
    let reportBlocked = (_databaseName: string): void => undefined;
    const blocked = new Promise<string>((resolve) => {
      reportBlocked = resolve;
    });
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-blocked-boot-notice",
      new ManualNoticeHarness(),
      reportBlocked,
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const open = vi.spyOn(factory, "open");

    const starting = harness.runtime.start();
    await expect(blocked).resolves.toBe(LEGACY_DATABASE_NAMES[0]);
    open.mockClear();
    harness.notices.deliverSourceRetired(seeded.activation.sessionEpoch);
    harness.notices.deliverAuthorityAdvanced();

    expect(open).not.toHaveBeenCalled();
    expect(harness.authority.pin).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "veiled" });

    blocker.close();
    await expect(starting).resolves.toMatchObject({ kind: "active" });
    expect(harness.authority.pin).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps one blocked boot scrub authoritative across pagehide and resume", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-blocked-boot-resume");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "blocked-boot-resume");
    const blocker = await rawOpen(factory, LEGACY_DATABASE_NAMES[0]);
    let reportBlocked = (_databaseName: string): void => undefined;
    const blocked = new Promise<string>((resolve) => {
      reportBlocked = resolve;
    });
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-blocked-boot-resume",
      new ManualNoticeHarness(),
      reportBlocked,
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));

    const starting = harness.runtime.start();
    await expect(blocked).resolves.toBe(LEGACY_DATABASE_NAMES[0]);
    harness.windowTarget.dispatchEvent(new Event("pagehide"));
    const resuming = harness.runtime.resume();

    expect(harness.runtime.getProjection()).toMatchObject({ kind: "veiled" });
    expect(harness.authority.pin).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    blocker.close();
    await expect(resuming).resolves.toMatchObject({ kind: "active" });
    await starting;
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "active" });
    expect(harness.authority.pin).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the shell veiled until verified identity and selected-head publication complete", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-boot");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "boot");
    const harness = createRuntime(factory, localStorage, sessionStorage, locks, seeded.activation, "runtime-boot");
    const response = deferredResponse();
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    const observed: string[] = [];
    harness.runtime.subscribe((projection) => observed.push(projection.kind));

    const starting = harness.runtime.start();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "veiled" });
    expect(observed).not.toContain("active");

    response.resolve(activeMe(seeded.activation.accountId, ["org-first", "org-default"], "org-default"));
    const projection = activeProjection(await starting);
    expect(projection.publication.state).toMatchObject({ kind: "selected", organizationId: "org-default" });
    expect(Object.isFrozen(projection.me.user)).toBe(true);
    expect(Object.isFrozen(projection.me.memberships)).toBe(true);
    expect(harness.runtime.getProjection()).toBe(projection);
    expect(observed.at(-1)).toBe("active");
  });

  it("observes an existing durable cursor with a fresh proof and never falls back to the first membership", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-cursor");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "cursor");
    await seedSelectedOrganization(seeded, "owner-cursor", "org-durable", "org-durable-revision");
    const harness = createRuntime(factory, localStorage, sessionStorage, locks, seeded.activation, "runtime-cursor");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(activeMe(seeded.activation.accountId, ["org-first", "org-durable"], null)),
      );

    const projection = activeProjection(await harness.runtime.start());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(projection.publication.state).toEqual({
      kind: "selected",
      organizationId: "org-durable",
      orgRevision: "org-durable-revision",
    });

    const noDefaultFactory = new IDBFactory();
    const noDefaultLocal = new MemoryStorage();
    const noDefaultSession = new MemoryStorage();
    noDefaultSession.setItem(OWNER_TAB_STORAGE_KEY, "owner-no-default");
    const noDefaultSeed = await seedActive(noDefaultFactory, noDefaultLocal, noDefaultSession, locks, "no-default");
    harness.runtime.dispose();
    const noDefault = createRuntime(
      noDefaultFactory,
      noDefaultLocal,
      noDefaultSession,
      locks,
      noDefaultSeed.activation,
      "runtime-no-default",
    );
    fetch.mockRestore();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(noDefaultSeed.activation.accountId, ["org-first"], null));
    expect(activeProjection(await noDefault.runtime.start()).publication.state.kind).toBe("needs-selection");
  });

  it("rotates account and organization revisions after pagehide before revealing again", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-resume");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "resume");
    const harness = createRuntime(factory, localStorage, sessionStorage, locks, seeded.activation, "runtime-resume");
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(activeMe(seeded.activation.accountId, ["org-a"], "org-a")),
    );
    const before = activeProjection(await harness.runtime.start());

    harness.windowTarget.dispatchEvent(new Event("pagehide"));
    expect(harness.runtime.getProjection().kind).toBe("veiled");
    const after = activeProjection(await harness.runtime.resume());

    expect(after.accountLease.accountRevision).not.toBe(before.accountLease.accountRevision);
    expect(after.publication.state.orgRevision).not.toBe(before.publication.state.orgRevision);
    expect(after.publication.state).toMatchObject({ kind: "selected", organizationId: "org-a" });
  });

  it.each([
    "pagehide",
    "freeze",
  ] as const)("rebinds an exact %s-suspended view with fresh revisions during same-process offline recovery", async (eventName) => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, `owner-offline-${eventName}`);
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, `offline-${eventName}`);
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      `runtime-offline-${eventName}`,
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    const beforeView = before.publication.viewLease;
    if (!beforeView) throw new Error("Expected selected organization view");
    fetch.mockClear();
    harness.authority.reconcile.mockResolvedValue({ kind: "unavailable", expected: SERVER_AUTHORITY });

    (eventName === "pagehide" ? harness.windowTarget : harness.documentTarget).dispatchEvent(new Event(eventName));
    expect(captureAccountStoreRuntime(before.accountLease)).toBeNull();
    expect(captureContentStoreRuntime(beforeView)).toBeNull();

    const after = activeProjection(await harness.runtime.resume());
    const afterView = after.publication.viewLease;
    if (!afterView) throw new Error("Expected rebound organization view");
    expect(fetch).not.toHaveBeenCalled();
    expect(before.accountLease.signal.aborted).toBe(true);
    expect(after.me).toBe(before.me);
    expect(after.accountLease.signal).not.toBe(before.accountLease.signal);
    expect(after.accountLease.accountRevision).not.toBe(before.accountLease.accountRevision);
    expect(after.publication.state).toMatchObject({ kind: "selected", organizationId: "org-a" });
    expect(after.publication.state.orgRevision).not.toBe(before.publication.state.orgRevision);
    expect(afterView).not.toBe(beforeView);
    expect(captureAccountStoreRuntime(after.accountLease)).not.toBeNull();
    expect(captureContentStoreRuntime(afterView)).not.toBeNull();
    await expect(
      new AccountStateStore().getAccountEntry(after.accountLease, {
        kind: "selected-organization",
        key: "current",
        tabId: after.accountLease.ownerTabId,
      }),
    ).resolves.toMatchObject({
      value: {
        state: "selected",
        organizationId: "org-a",
        orgRevision: after.publication.state.orgRevision,
      },
    });
  });

  it.each([
    ["pagehide", "changed"],
    ["freeze", "missing"],
  ] as const)("keeps a %s-restored view in recovery when the Vite generation is %s", async (eventName, reason) => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, `owner-generation-${eventName}`);
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, `generation-${eventName}`);
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      `runtime-generation-${eventName}`,
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    fetch.mockClear();
    harness.authority.reconcile.mockRejectedValue(new Error(`Vite generation ${reason}`));

    (eventName === "pagehide" ? harness.windowTarget : harness.documentTarget).dispatchEvent(new Event(eventName));
    const projection = await harness.runtime.resume();

    expect(projection).toMatchObject({ kind: "recovery" });
    expect(projection.kind).not.toBe("active");
    expect(before.accountLease.signal.aborted).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rechecks the Vite generation after a suspended selected-head commit and before cached delivery", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-generation-race");
    const locks = new NavigationDeliveryGateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "generation-race");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-generation-race",
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    const beforeView = before.publication.viewLease;
    if (!beforeView) throw new Error("Expected selected organization view");
    fetch.mockClear();
    harness.authority.reconcile.mockReset();
    harness.authority.reconcile.mockResolvedValueOnce({ kind: "unavailable", expected: SERVER_AUTHORITY });
    locks.holdNavigationDelivery();

    harness.windowTarget.dispatchEvent(new Event("pagehide"));
    const delivered: BrowserSessionProjection[] = [];
    const unsubscribe = harness.runtime.subscribe((projection) => delivered.push(projection));
    delivered.length = 0;
    const resuming = harness.runtime.resume();
    await locks.navigationCommitted;

    expect(harness.authority.reconcile).toHaveBeenCalledTimes(1);
    expect(harness.runtime.getProjection().kind).toBe("veiled");
    harness.authority.reconcile.mockRejectedValueOnce(new Error("Vite V2 retargeted to unavailable S2"));
    locks.releaseNavigationDelivery();

    await expect(resuming).resolves.toMatchObject({ kind: "recovery" });
    expect(harness.authority.reconcile).toHaveBeenCalledTimes(2);
    expect(delivered.some((projection) => projection.kind === "active")).toBe(false);
    expect(captureAccountStoreRuntime(before.accountLease)).toBeNull();
    expect(captureContentStoreRuntime(beforeView)).toBeNull();
    await expect(harness.runtime.refresh()).rejects.toMatchObject({ code: "admission_denied" });
    expect(fetch).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("single-flights pageshow, visibility, and direct resume across suspended head commit and delivery", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-concurrent-offline-resume");
    const locks = new NavigationDeliveryGateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "concurrent-offline-resume");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-concurrent-offline-resume",
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    const beforeView = before.publication.viewLease;
    if (!beforeView) throw new Error("Expected selected organization view");
    fetch.mockClear();
    harness.authority.reconcile.mockReset();
    harness.authority.reconcile.mockResolvedValue({ kind: "unavailable", expected: SERVER_AUTHORITY });
    locks.holdNavigationDelivery();

    harness.windowTarget.dispatchEvent(new Event("pagehide"));
    const delivered: BrowserSessionProjection[] = [];
    const unsubscribe = harness.runtime.subscribe((projection) => delivered.push(projection));
    delivered.length = 0;
    const resume = vi.spyOn(harness.runtime, "resume");
    harness.windowTarget.dispatchEvent(new Event("pageshow"));
    await locks.navigationCommitted;

    expect(harness.authority.reconcile).toHaveBeenCalledTimes(1);
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "veiled" });
    harness.documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(resume).toHaveBeenCalledTimes(2);
    const pageShowResume = resume.mock.results[0]?.value;
    const visibilityResume = resume.mock.results[1]?.value;
    expect(visibilityResume).toBe(pageShowResume);
    const directResume = harness.runtime.resume();
    expect(directResume).toBe(pageShowResume);
    expect(harness.authority.reconcile).toHaveBeenCalledTimes(1);

    locks.releaseNavigationDelivery();
    const after = activeProjection(await directResume);
    const afterView = after.publication.viewLease;
    if (!afterView) throw new Error("Expected rebound organization view");
    expect(harness.authority.reconcile).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(delivered.some((projection) => projection.kind === "recovery")).toBe(false);
    expect(after.accountLease.accountRevision).not.toBe(before.accountLease.accountRevision);
    expect(after.publication.state).toMatchObject({ kind: "selected", organizationId: "org-a" });
    expect(after.publication.state.orgRevision).not.toBe(before.publication.state.orgRevision);
    expect(captureAccountStoreRuntime(before.accountLease)).toBeNull();
    expect(captureContentStoreRuntime(beforeView)).toBeNull();
    expect(captureAccountStoreRuntime(after.accountLease)).not.toBeNull();
    expect(captureContentStoreRuntime(afterView)).not.toBeNull();
    await expect(
      new AccountStateStore().getAccountEntry(after.accountLease, {
        kind: "selected-organization",
        key: "current",
        tabId: after.accountLease.ownerTabId,
      }),
    ).resolves.toMatchObject({
      value: {
        state: "selected",
        organizationId: "org-a",
        orgRevision: after.publication.state.orgRevision,
      },
    });
    unsubscribe();
  });

  it.each([
    "pagehide",
    "freeze",
  ] as const)("hands an in-flight offline remount to a new %s lifecycle cycle", async (eventName) => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, `owner-double-suspend-${eventName}`);
    const locks = new NavigationDeliveryGateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, `double-suspend-${eventName}`);
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      `runtime-double-suspend-${eventName}`,
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    const beforeView = before.publication.viewLease;
    if (!beforeView) throw new Error("Expected selected organization view");
    fetch.mockClear();
    harness.authority.reconcile.mockReset();
    harness.authority.reconcile.mockResolvedValue({ kind: "unavailable", expected: SERVER_AUTHORITY });
    locks.holdNavigationDelivery();

    const lifecycleTarget = eventName === "pagehide" ? harness.windowTarget : harness.documentTarget;
    lifecycleTarget.dispatchEvent(new Event(eventName));
    const delivered: BrowserSessionProjection[] = [];
    const unsubscribe = harness.runtime.subscribe((projection) => delivered.push(projection));
    delivered.length = 0;
    const firstResume = harness.runtime.resume();
    await locks.navigationCommitted;

    expect(harness.runtime.getProjection().kind).toBe("veiled");
    lifecycleTarget.dispatchEvent(new Event(eventName));
    const secondResume = harness.runtime.resume();
    locks.releaseNavigationDelivery();

    await expect(firstResume).resolves.toMatchObject({ kind: "veiled" });
    const after = activeProjection(await secondResume);
    const afterView = after.publication.viewLease;
    if (!afterView) throw new Error("Expected rebound organization view");
    expect(fetch).not.toHaveBeenCalled();
    expect(delivered.filter((projection) => projection.kind === "active")).toEqual([after]);
    expect(delivered.some((projection) => projection.kind === "recovery")).toBe(false);
    expect(after.accountLease.accountRevision).not.toBe(before.accountLease.accountRevision);
    expect(after.publication.state).toMatchObject({ kind: "selected", organizationId: "org-a" });
    expect(after.publication.state.orgRevision).not.toBe(before.publication.state.orgRevision);
    expect(captureAccountStoreRuntime(before.accountLease)).toBeNull();
    expect(captureContentStoreRuntime(beforeView)).toBeNull();
    expect(captureAccountStoreRuntime(after.accountLease)).not.toBeNull();
    expect(captureContentStoreRuntime(afterView)).not.toBeNull();
    await expect(
      new AccountStateStore().getAccountEntry(after.accountLease, {
        kind: "selected-organization",
        key: "current",
        tabId: after.accountLease.ownerTabId,
      }),
    ).resolves.toMatchObject({
      value: {
        state: "selected",
        organizationId: "org-a",
        orgRevision: after.publication.state.orgRevision,
      },
    });
    unsubscribe();
  });

  it.each([
    "retirement",
    "selected-head",
  ] as const)("rechecks durable %s ownership after the final suspended authority probe", async (winner) => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, `owner-final-suspend-${winner}`);
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, `final-suspend-${winner}`);
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      `runtime-final-suspend-${winner}`,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a", "org-b"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    const finalProbe = deferredValue<Awaited<ReturnType<BrowserSessionAuthorityProbe["reconcile"]>>>();
    harness.authority.reconcile.mockReset();
    harness.authority.reconcile.mockResolvedValueOnce({ kind: "unavailable", expected: SERVER_AUTHORITY });
    harness.authority.reconcile.mockReturnValueOnce(finalProbe.promise);

    harness.windowTarget.dispatchEvent(new Event("pagehide"));
    const delivered: BrowserSessionProjection[] = [];
    const unsubscribe = harness.runtime.subscribe((projection) => delivered.push(projection));
    delivered.length = 0;
    const resuming = harness.runtime.resume();
    await vi.waitFor(() => expect(harness.authority.reconcile).toHaveBeenCalledTimes(2));

    if (winner === "retirement") {
      const external = new AuthSessionCoordinator({
        indexedDB: factory,
        legacyPersistence: { indexedDB: factory, localStorage, sessionStorage },
      });
      await external.beginRetirement(seeded.activation, "logout", "generation-final-suspend-external-retirement");
    } else {
      await overwriteSelectedOrganization(
        factory,
        seeded.activation,
        before.accountLease.ownerTabId,
        "org-b",
        "external-org-revision",
      );
    }
    finalProbe.resolve({ kind: "unavailable", expected: SERVER_AUTHORITY });

    await expect(resuming).resolves.toMatchObject({ kind: "recovery" });
    expect(delivered.some((projection) => projection.kind === "active")).toBe(false);
    expect(harness.runtime.getProjection().kind).not.toBe("active");
    unsubscribe();
  });

  it("defers notice-driven reads and purge while pagehidden until visible reconciliation", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-suspended-notice");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "suspended-notice");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-suspended-notice",
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    const external = new AuthSessionCoordinator({
      indexedDB: factory,
      legacyPersistence: { indexedDB: factory, localStorage, sessionStorage },
    });
    await external.beginRetirement(seeded.activation, "logout", "external-suspended-retirement");
    const deleteDatabase = vi.spyOn(factory, "deleteDatabase");
    fetch.mockClear();
    harness.authority.pin.mockClear();

    harness.windowTarget.dispatchEvent(new Event("pagehide"));
    harness.notices.deliverSourceRetired(seeded.activation.sessionEpoch);

    expect(harness.runtime.getProjection()).toMatchObject({ kind: "veiled" });
    expect(before.accountLease.signal.aborted).toBe(true);
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(harness.authority.pin).not.toHaveBeenCalled();
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "retiring", phase: "revoked" });

    await expect(harness.runtime.resume()).resolves.toEqual({ kind: "anonymous" });
    expect(deleteDatabase).toHaveBeenCalled();
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
  });

  it("refreshes an expired access token before the first verified active identity", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-cold-refresh");
    const locks = new ImmediateLocks();
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "cold-refresh", {
      access: nowSeconds + 5,
      refresh: nowSeconds + 3_600,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((nowSeconds + 10) * 1_000);
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-cold-refresh",
    );
    const replacementAccess = jwt(seeded.activation.accountId, "access", "rotated", nowSeconds + 3_600);
    const replacementRefresh = jwt(seeded.activation.accountId, "refresh", "rotated", nowSeconds + 7_200);
    const requests: Array<Readonly<{ url: string; init: RequestInit | undefined }>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push(Object.freeze({ url, init }));
      if (url === "/api/v1/auth/refresh") {
        return new Response(JSON.stringify({ accessToken: replacementAccess, refreshToken: replacementRefresh }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (requests.filter((request) => request.url === "/api/v1/me").length === 1) {
        return new Response("expired", { status: 401 });
      }
      return activeMe(seeded.activation.accountId, ["org-a"], "org-a");
    });

    const projection = activeProjection(await harness.runtime.start());
    expect(requests.map((request) => request.url)).toEqual(["/api/v1/me", "/api/v1/auth/refresh", "/api/v1/me"]);
    const refreshRequest = requests[1];
    const refreshHeaders = new Headers(refreshRequest?.init?.headers);
    expect(refreshRequest?.init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
    });
    expect(refreshHeaders.has("Authorization")).toBe(false);
    expect(refreshHeaders.has("Cookie")).toBe(false);
    expect(JSON.parse(String(refreshRequest?.init?.body))).toEqual({
      refreshToken: jwt(seeded.activation.accountId, "refresh", "cold-refresh", nowSeconds + 3_600),
    });
    expect(new Headers(requests[2]?.init?.headers).get("Authorization")).toBe(`Bearer ${replacementAccess}`);
    expect(projection.credential.credentialRevision).toBe(1);
    expect(projection.publication.state).toMatchObject({ kind: "selected", organizationId: "org-a" });
  });

  it("retires and purges the exact account when its coordinator-owned refresh returns 401", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-refresh-401");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "refresh-401");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-refresh-401",
    );
    let activeMeCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/v1/auth/refresh") return new Response("expired", { status: 401 });
      activeMeCalls += 1;
      return activeMeCalls === 1
        ? activeMe(seeded.activation.accountId, ["org-a"], "org-a")
        : new Response("expired", { status: 401 });
    });
    const before = activeProjection(await harness.runtime.start());

    await expect(harness.runtime.refresh()).resolves.toEqual({ kind: "anonymous" });
    expect(before.accountLease.signal.aborted).toBe(true);
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
    expect(harness.notices.retiredEpochs).toEqual([seeded.activation.sessionEpoch]);
    expect(harness.notices.authorityAdvancedCount).toBe(1);
  });

  it("retires and purges when refreshed credentials still receive an exact account identity 401", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-terminal-active-me-401");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "terminal-active-me-401");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-terminal-active-me-401",
    );
    const replacementAccess = jwt(seeded.activation.accountId, "access", "terminal-active-me-401-rotated");
    const replacementRefresh = jwt(seeded.activation.accountId, "refresh", "terminal-active-me-401-rotated");
    const requests: Array<Readonly<{ url: string; init: RequestInit | undefined }>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push(Object.freeze({ url, init }));
      if (url === "/api/v1/auth/refresh") {
        return new Response(JSON.stringify({ accessToken: replacementAccess, refreshToken: replacementRefresh }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const activeMeCount = requests.filter((request) => request.url === "/api/v1/me").length;
      return activeMeCount === 1
        ? activeMe(seeded.activation.accountId, ["org-a"], "org-a")
        : new Response("expired", { status: 401 });
    });
    const before = activeProjection(await harness.runtime.start());

    await expect(harness.runtime.refresh()).resolves.toEqual({ kind: "anonymous" });
    expect(requests.map((request) => request.url)).toEqual([
      "/api/v1/me",
      "/api/v1/me",
      "/api/v1/auth/refresh",
      "/api/v1/me",
    ]);
    expect(new Headers(requests[3]?.init?.headers).get("Authorization")).toBe(`Bearer ${replacementAccess}`);
    expect(before.accountLease.signal.aborted).toBe(true);
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
    expect(harness.notices.retiredEpochs).toEqual([seeded.activation.sessionEpoch]);
    expect(harness.notices.authorityAdvancedCount).toBe(1);
  });

  it.each([
    "open",
    "transaction",
  ] as const)("retries a retained terminal identity retirement after a pre-commit %s failure", async (failurePoint) => {
    const testId = `terminal-active-me-401-retry-${failurePoint}`;
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, `owner-${testId}`);
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, testId);
    const harness = createRuntime(factory, localStorage, sessionStorage, locks, seeded.activation, `runtime-${testId}`);
    const replacementAccess = jwt(seeded.activation.accountId, "access", `${testId}-rotated`);
    const replacementRefresh = jwt(seeded.activation.accountId, "refresh", `${testId}-rotated`);
    let bootIdentityPending = true;
    const requests: string[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/v1/auth/refresh") {
        return new Response(JSON.stringify({ accessToken: replacementAccess, refreshToken: replacementRefresh }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (bootIdentityPending) {
        bootIdentityPending = false;
        return activeMe(seeded.activation.accountId, ["org-a"], "org-a");
      }
      return new Response("expired", { status: 401 });
    });
    const before = activeProjection(await harness.runtime.start());
    requests.length = 0;

    const originalRetirement = AuthSessionCoordinator.prototype.retireAccountAfterTerminalActiveMe401;
    let retirementCalls = 0;
    const retirementInputs: Array<readonly [unknown, unknown]> = [];
    const retirementResults: string[] = [];
    vi.spyOn(AuthSessionCoordinator.prototype, "retireAccountAfterTerminalActiveMe401").mockImplementation(
      async function (this: AuthSessionCoordinator, leaseValue, rejectionValue) {
        retirementCalls += 1;
        retirementInputs.push([leaseValue, rejectionValue]);
        if (retirementCalls === 1) {
          if (failurePoint === "open") {
            vi.spyOn(factory, "open").mockImplementationOnce(() => {
              throw new Error("transient terminal retirement open failure");
            });
          } else {
            vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce(() => {
              throw new DOMException("transient terminal retirement transaction failure", "UnknownError");
            });
          }
        }
        const result = await originalRetirement.call(this, leaseValue, rejectionValue);
        retirementResults.push(result);
        return result;
      },
    );

    await expect(harness.runtime.refresh()).resolves.toMatchObject({ kind: "recovery" });
    expect(requests).toEqual(["/api/v1/me", "/api/v1/auth/refresh", "/api/v1/me"]);
    expect(retirementCalls).toBe(1);
    expect(before.accountLease.signal.aborted).toBe(true);
    await expect(seeded.coordinator.readAuthority()).resolves.toMatchObject({ mode: "active" });

    fetch.mockRejectedValue(new Error("pending terminal retirement must prevent another network request"));
    await expect(harness.runtime.resume()).resolves.toEqual({ kind: "anonymous" });
    expect(requests).toEqual(["/api/v1/me", "/api/v1/auth/refresh", "/api/v1/me"]);
    expect(retirementCalls).toBe(2);
    expect(retirementInputs[1]?.[0]).toBe(retirementInputs[0]?.[0]);
    expect(retirementInputs[1]?.[1]).toBe(retirementInputs[0]?.[1]);
    expect(retirementResults).toEqual(["retired"]);
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
    expect(harness.notices.retiredEpochs).toEqual([seeded.activation.sessionEpoch]);
    expect(harness.notices.authorityAdvancedCount).toBe(1);

    await expect(harness.runtime.resume()).resolves.toEqual({ kind: "anonymous" });
    expect(retirementCalls).toBe(2);
    expect(requests).toHaveLength(3);
  });

  it("transfers transaction-first terminal identity retirement to a fresh local cleanup operation", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-terminal-active-me-401-transfer");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "terminal-active-me-401-transfer");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-terminal-active-me-401-transfer",
    );
    const replacementAccess = jwt(seeded.activation.accountId, "access", "terminal-active-me-401-transfer");
    const replacementRefresh = jwt(seeded.activation.accountId, "refresh", "terminal-active-me-401-transfer");
    let activeMeCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/v1/auth/refresh") {
        return new Response(JSON.stringify({ accessToken: replacementAccess, refreshToken: replacementRefresh }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      activeMeCalls += 1;
      return activeMeCalls === 1
        ? activeMe(seeded.activation.accountId, ["org-a"], "org-a")
        : new Response("expired", { status: 401 });
    });
    await harness.runtime.start();
    const originalRetirement = AuthSessionCoordinator.prototype.retireAccountAfterTerminalActiveMe401;
    let supersedingRefresh: Promise<BrowserSessionProjection> | null = null;
    vi.spyOn(AuthSessionCoordinator.prototype, "retireAccountAfterTerminalActiveMe401").mockImplementationOnce(
      async function (this: AuthSessionCoordinator, leaseValue, rejectionValue) {
        const result = await originalRetirement.call(this, leaseValue, rejectionValue);
        supersedingRefresh = harness.runtime.refresh();
        return result;
      },
    );

    await harness.runtime.refresh();
    if (!supersedingRefresh) throw new Error("Expected the committed retirement to trigger a superseding refresh");
    await supersedingRefresh;
    expect(harness.runtime.getProjection()).toEqual({ kind: "anonymous" });
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
    expect(harness.notices.retiredEpochs).toEqual([seeded.activation.sessionEpoch]);
    expect(harness.notices.authorityAdvancedCount).toBe(1);
  });

  it("retires and purges an active account when the Vite identity firewall returns 421", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-active-me-421");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "active-me-421");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-active-me-421",
    );
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    fetch.mockResolvedValueOnce(new Response("wrong Vite authority", { status: 421 }));

    await expect(harness.runtime.refresh()).resolves.toEqual({ kind: "anonymous" });
    expect(before.accountLease.signal.aborted).toBe(true);
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
    expect(harness.notices.retiredEpochs).toEqual([seeded.activation.sessionEpoch]);
    expect(harness.notices.authorityAdvancedCount).toBe(1);
  });

  it("retires and purges when a 401 recovery refresh reaches a mismatched Vite server", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-refresh-421");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "refresh-421");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-refresh-421",
    );
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    fetch.mockResolvedValueOnce(new Response("expired", { status: 401 }));
    fetch.mockResolvedValueOnce(new Response("wrong Vite authority", { status: 421 }));

    await expect(harness.runtime.refresh()).resolves.toEqual({ kind: "anonymous" });
    expect(before.accountLease.signal.aborted).toBe(true);
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
    expect(harness.notices.retiredEpochs).toEqual([seeded.activation.sessionEpoch]);
    expect(harness.notices.authorityAdvancedCount).toBe(1);
  });

  it("keeps an owned-401 cleanup in recovery when source retirement delivery fails", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-refresh-401-notice-failure");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "refresh-401-notice-failure");
    const notices = new ManualNoticeHarness();
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-refresh-401-notice-failure",
      notices,
    );
    let activeMeCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/v1/auth/refresh") return new Response("expired", { status: 401 });
      activeMeCalls += 1;
      return activeMeCalls === 1
        ? activeMe(seeded.activation.accountId, ["org-a"], "org-a")
        : new Response("expired", { status: 401 });
    });
    await harness.runtime.start();
    notices.sourceDelivery = Object.freeze({ broadcast: false, storage: false });

    await expect(harness.runtime.refresh()).resolves.toMatchObject({ kind: "recovery" });
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
    expect(notices.retiredEpochs).toEqual([seeded.activation.sessionEpoch]);
    expect(notices.authorityAdvancedCount).toBe(1);
  });

  it("preserves a newer credential without stale cleanup when it supersedes terminal account identity 401", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-terminal-401-superseded");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "terminal-401-superseded");
    const notices = new ManualNoticeHarness();
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-terminal-401-superseded",
      notices,
    );
    const firstAccess = jwt(seeded.activation.accountId, "access", "terminal-401-superseded-first");
    const firstRefresh = jwt(seeded.activation.accountId, "refresh", "terminal-401-superseded-first");
    const winnerAccess = jwt(seeded.activation.accountId, "access", "terminal-401-superseded-winner");
    const winnerRefresh = jwt(seeded.activation.accountId, "refresh", "terminal-401-superseded-winner");
    let activeMeCalls = 0;
    let refreshCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/v1/auth/refresh") {
        refreshCalls += 1;
        return new Response(
          JSON.stringify({
            accessToken: refreshCalls === 1 ? firstAccess : winnerAccess,
            refreshToken: refreshCalls === 1 ? firstRefresh : winnerRefresh,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      activeMeCalls += 1;
      if (activeMeCalls === 1 || activeMeCalls >= 4) {
        return activeMe(seeded.activation.accountId, ["org-a"], "org-a");
      }
      return new Response("expired", { status: 401 });
    });
    await harness.runtime.start();
    const external = new AuthSessionCoordinator({
      indexedDB: factory,
      legacyPersistence: { indexedDB: factory, localStorage, sessionStorage },
    });
    const retireTerminal = AuthSessionCoordinator.prototype.retireAccountAfterTerminalActiveMe401;
    let observedRetirement: Awaited<ReturnType<typeof retireTerminal>> | null = null;
    vi.spyOn(AuthSessionCoordinator.prototype, "retireAccountAfterTerminalActiveMe401").mockImplementationOnce(
      async function (this: AuthSessionCoordinator, leaseValue, rejectionValue) {
        const current = await external.readActiveSession();
        await external.refreshAccountCredential(
          leaseValue,
          current.credential,
          "generation-terminal-401-superseded-unused",
        );
        observedRetirement = await retireTerminal.call(this, leaseValue, rejectionValue);
        return observedRetirement;
      },
    );
    const deleteDatabase = vi.spyOn(factory, "deleteDatabase");
    deleteDatabase.mockClear();

    const projection = await harness.runtime.refresh();
    expect(observedRetirement).toBe("superseded");
    expect(activeMeCalls).toBeGreaterThanOrEqual(4);
    expect(refreshCalls).toBe(2);
    expect(await external.readAuthority()).toMatchObject({ mode: "active", session: seeded.activation });
    expect(projection).toMatchObject({ kind: "recovery" });
    expect(notices.retiredEpochs).toEqual([]);
    expect(notices.authorityAdvancedCount).toBe(0);
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  it("does not treat superseded owned-401 retirement as source-notice delivery", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-superseded-401-notice-failure");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "superseded-401-notice-failure");
    const notices = new ManualNoticeHarness();
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-superseded-401-notice-failure",
      notices,
    );
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    await harness.runtime.start();
    notices.sourceDelivery = Object.freeze({ broadcast: false, storage: false });
    fetch.mockResolvedValueOnce(new Response("expired", { status: 401 }));
    const external = new AuthSessionCoordinator({
      indexedDB: factory,
      legacyPersistence: { indexedDB: factory, localStorage, sessionStorage },
    });
    vi.spyOn(AuthSessionCoordinator.prototype, "refreshAccountCredentialAfterActiveMe401").mockImplementationOnce(
      async () => {
        await external.beginRetirement(seeded.activation, "logout", "generation-superseded-401-external-retiring");
        const receipt = await seeded.barrier.purgeAccountScope(seeded.activation, { localStorage, sessionStorage });
        await external.completeRetirement(seeded.activation, receipt, "generation-superseded-401-external-none");
        throw new SessionError(
          sessionErrorCodes.admissionDenied,
          "A concurrent retirement already consumed this refresh",
          Object.freeze({ kind: "refresh_http_status", status: 401, retirement: "superseded" }),
        );
      },
    );

    await expect(harness.runtime.refresh()).resolves.toEqual({ kind: "anonymous" });
    expect(await external.readAuthority()).toMatchObject({ mode: "none" });
    expect(notices.retiredEpochs).toEqual([]);
    expect(notices.authorityAdvancedCount).toBe(0);
    expect(harness.runtime.getProjection()).toEqual({ kind: "anonymous" });
  });

  it("allows exact ordinary-hidden offline reuse but never reveals an externally retired account", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-offline");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "offline");
    const harness = createRuntime(factory, localStorage, sessionStorage, locks, seeded.activation, "runtime-offline");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());

    harness.documentTarget.visibilityState = "hidden";
    harness.documentTarget.dispatchEvent(new Event("visibilitychange"));
    harness.authority.reconcile.mockResolvedValue({ kind: "unavailable", expected: SERVER_AUTHORITY });
    harness.documentTarget.visibilityState = "visible";
    const reused = activeProjection(await harness.runtime.resume());
    expect(reused.accountLease).toBe(before.accountLease);
    expect(reused.publication).toBe(before.publication);

    const external = new AuthSessionCoordinator({ indexedDB: factory });
    await external.beginRetirement(seeded.activation, "logout", "external-retirement");
    const receipt = await seeded.barrier.purgeAccountScope(seeded.activation, { localStorage, sessionStorage });
    await external.completeRetirement(seeded.activation, receipt, "external-anonymous");
    const projection = await harness.runtime.resume();
    expect(projection).toMatchObject({ kind: "recovery" });
    expect(projection.kind).not.toBe("active");
  });

  it("keeps a hidden active lease hot when an older generic refresh fails offline", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-held-hidden-refresh");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "held-hidden-refresh");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-held-hidden-refresh",
    );
    let rejectHeld = (_error: unknown): void => undefined;
    const heldResponse = new Promise<Response>((_resolve, reject) => {
      rejectHeld = reject;
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(activeMe(seeded.activation.accountId, ["org-a"], "org-a"))
      .mockImplementationOnce(() => heldResponse);
    const before = activeProjection(await harness.runtime.start());

    const refresh = harness.runtime.refresh();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    harness.documentTarget.visibilityState = "hidden";
    harness.documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "veiled", reason: "lifecycle_suspended" });
    expect(before.accountLease.signal.aborted).toBe(false);

    rejectHeld(new TypeError("offline"));
    await expect(refresh).resolves.toMatchObject({ kind: "veiled", reason: "lifecycle_suspended" });
    expect(before.accountLease.signal.aborted).toBe(false);
    expect(await seeded.coordinator.readAuthority()).toMatchObject({
      mode: "active",
      session: seeded.activation,
    });
    expect(harness.notices.retiredEpochs).toEqual([]);

    harness.authority.reconcile.mockResolvedValue({ kind: "unavailable", expected: SERVER_AUTHORITY });
    harness.documentTarget.visibilityState = "visible";
    const resumed = activeProjection(await harness.runtime.resume());
    expect(resumed.accountLease).toBe(before.accountLease);
    expect(resumed.publication).toBe(before.publication);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retires local capabilities after a hard authority probe failure and remounts only after a later match", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-hard-authority-probe");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "hard-authority-probe");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-hard-authority-probe",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(activeMe(seeded.activation.accountId, ["org-a"], "org-a")),
    );
    const before = activeProjection(await harness.runtime.start());
    harness.authority.reconcile.mockRejectedValueOnce(new TypeError("TLS certificate rejected"));

    await expect(harness.runtime.resume()).resolves.toMatchObject({ kind: "recovery" });
    expect(before.accountLease.signal.aborted).toBe(true);
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "active", session: seeded.activation });
    expect(harness.notices.retiredEpochs).toEqual([]);

    harness.authority.reconcile.mockResolvedValueOnce({
      kind: "unavailable",
      expected: seeded.activation.serverAuthority,
    });
    await expect(harness.runtime.resume()).resolves.toMatchObject({ kind: "recovery" });
    expect(harness.runtime.getProjection().kind).not.toBe("active");

    harness.authority.reconcile.mockResolvedValueOnce({
      kind: "match",
      authority: seeded.activation.serverAuthority,
    });
    const remountedProjection = await harness.runtime.resume();
    expect(remountedProjection).toMatchObject({ kind: "active" });
    const remounted = activeProjection(remountedProjection);
    expect(remounted.accountLease).not.toBe(before.accountLease);
    expect(remounted.accountLease.signal.aborted).toBe(false);
    expect(remounted.activation).toEqual(seeded.activation);
  });

  it("never retires a newer foreign-server authority from an old pinned document", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-foreign-server-notice");
    const locks = new ImmediateLocks();
    const source = await seedActive(factory, localStorage, sessionStorage, locks, "foreign-server-source");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      source.activation,
      "runtime-foreign-server-notice",
    );
    const sourceFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(activeMe(source.activation.accountId, ["org-source"], "org-source")));
    const oldProjection = activeProjection(await harness.runtime.start());
    sourceFetch.mockRestore();

    const external = new AuthSessionCoordinator({ indexedDB: factory });
    await external.beginRetirement(source.activation, "logout", "foreign-server-source-retiring");
    const receipt = await source.barrier.purgeAccountScope(source.activation, { localStorage, sessionStorage });
    await external.completeRetirement(source.activation, receipt, "foreign-server-source-none");
    const targetAuthority = "https://second-hub.example.test/api/v1";
    const target = await seedActive(
      factory,
      localStorage,
      sessionStorage,
      locks,
      "foreign-server-target",
      undefined,
      targetAuthority,
    );
    const targetSession = await target.coordinator.readActiveSession();
    const targetDatabase = createScopedDatabaseName("chat-content", 1, target.activation.scopeKey);
    await putRawRow(factory, targetDatabase, "owner", "target-row");
    const unexpectedFetch = vi.spyOn(globalThis, "fetch");

    harness.notices.deliverAuthorityAdvanced();
    await vi.waitFor(() => expect(harness.runtime.getProjection()).toMatchObject({ kind: "recovery" }));

    expect(oldProjection.accountLease.signal.aborted).toBe(true);
    expect(unexpectedFetch).not.toHaveBeenCalled();
    expect(await target.coordinator.readActiveSession()).toEqual(targetSession);
    expect(await readRawRow(factory, targetDatabase, "owner")).toBe("target-row");
    expect(harness.notices.retiredEpochs).not.toContain(target.activation.sessionEpoch);
  });

  it("stale-gates a held old-account 421 after replacement before mismatch retirement can touch F", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-held-421-foreign-server");
    const locks = new ImmediateLocks();
    const source = await seedActive(factory, localStorage, sessionStorage, locks, "held-421-source");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      source.activation,
      "runtime-held-421-foreign-server",
    );
    const held = deferredResponse();
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(activeMe(source.activation.accountId, ["org-source"], "org-source"));
    await harness.runtime.start();
    fetch.mockReturnValueOnce(held.promise);
    const refreshing = harness.runtime.refresh();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    fetch.mockRestore();

    const external = new AuthSessionCoordinator({ indexedDB: factory });
    await external.beginRetirement(source.activation, "logout", "held-421-source-retiring");
    const receipt = await source.barrier.purgeAccountScope(source.activation, { localStorage, sessionStorage });
    await external.completeRetirement(source.activation, receipt, "held-421-source-none");
    const target = await seedActive(
      factory,
      localStorage,
      sessionStorage,
      locks,
      "held-421-target",
      undefined,
      "https://third-hub.example.test/api/v1",
      false,
    );
    const targetSession = await target.coordinator.readActiveSession();
    const targetDatabase = createScopedDatabaseName("chat-content", 1, target.activation.scopeKey);
    await putRawRow(factory, targetDatabase, "owner", "target-row");
    const beginRetirement = vi.spyOn(AuthSessionCoordinator.prototype, "beginRetirement");

    held.resolve(new Response("old request reached the wrong Vite authority", { status: 421 }));
    await expect(refreshing).resolves.toMatchObject({ kind: "recovery" });

    expect(await target.coordinator.readActiveSession()).toEqual(targetSession);
    expect(await readRawRow(factory, targetDatabase, "owner")).toBe("target-row");
    expect(harness.notices.retiredEpochs).not.toContain(target.activation.sessionEpoch);
    expect(beginRetirement).not.toHaveBeenCalled();
  });

  it("finishes a server-mismatch purge but stays in recovery when source delivery fails", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-server-mismatch-notice-failure");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "server-mismatch-notice-failure");
    const notices = new ManualNoticeHarness();
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-server-mismatch-notice-failure",
      notices,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    await harness.runtime.start();
    harness.authority.reconcile.mockResolvedValue({
      kind: "mismatch",
      expected: seeded.activation.serverAuthority,
      observed: "https://other.example.test/api/v1",
    });
    notices.sourceDelivery = Object.freeze({ broadcast: false, storage: false });

    await expect(harness.runtime.resume()).resolves.toMatchObject({ kind: "recovery" });
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
    expect(notices.retiredEpochs).toEqual([seeded.activation.sessionEpoch]);
    expect(notices.authorityAdvancedCount).toBe(1);
  });

  it("synchronously veils a matching retired epoch and remounts it only after fresh authority proof", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-early-notice");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "early-notice");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-early-notice",
    );
    const held = deferredResponse();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(activeMe(seeded.activation.accountId, ["org-a"], "org-a")));
    const before = activeProjection(await harness.runtime.start());
    fetch.mockImplementationOnce(() => held.promise);

    harness.notices.deliverSourceRetired(seeded.activation.sessionEpoch);

    expect(harness.runtime.getProjection()).toMatchObject({ kind: "veiled" });
    expect(before.accountLease.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect((await seeded.coordinator.readAuthority()).mode).toBe("active");

    held.resolve(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    await vi.waitFor(() => expect(harness.runtime.getProjection().kind).toBe("active"));
    const after = activeProjection(harness.runtime.getProjection());
    expect(after.accountLease).not.toBe(before.accountLease);
    expect(after.publication.state).toMatchObject({ kind: "selected", organizationId: "org-a" });
  });

  it("keeps an authoritative F view byte-for-byte live when a late E notice arrives", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-late-notice");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "late-notice-f");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-late-notice",
    );
    const held = deferredResponse();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    fetch.mockImplementationOnce(() => held.promise);
    const refreshing = harness.runtime.refresh();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const beforeNotice = harness.runtime.getProjection();

    harness.notices.deliverSourceRetired("epoch-retired-E");

    expect(harness.runtime.getProjection()).toEqual(beforeNotice);
    expect(before.accountLease.signal.aborted).toBe(false);
    held.resolve(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    await expect(refreshing).resolves.toMatchObject({ kind: "active" });
    expect(activeProjection(harness.runtime.getProjection()).accountLease).toBe(before.accountLease);
  });

  it("leaves an exact active F runtime untouched when its credential advances before a late E notice", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-late-notice-rotated-f");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "late-notice-rotated-f");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-late-notice-rotated-f",
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accessToken: jwt(seeded.activation.accountId, "access", "rotated-f"),
          refreshToken: jwt(seeded.activation.accountId, "refresh", "rotated-f"),
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    await seeded.coordinator.refreshAccountCredential(
      before.accountLease,
      before.credential,
      "unused-owned-401-generation",
    );
    const readAuthority = vi.spyOn(AuthSessionCoordinator.prototype, "readAuthority");
    const readActiveSession = vi.spyOn(AuthSessionCoordinator.prototype, "readActiveSession");
    readAuthority.mockClear();
    readActiveSession.mockClear();
    fetch.mockClear();

    harness.notices.deliverSourceRetired("epoch-retired-E");
    await vi.waitFor(() => expect(readAuthority).toHaveBeenCalled());

    expect(harness.runtime.getProjection()).toBe(before);
    expect(before.accountLease.signal.aborted).toBe(false);
    expect(readActiveSession).not.toHaveBeenCalled();
    expect(harness.authority.pin).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("assists a live replacement transition only through source_purged and preserves its target permit", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-transition-notice");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "transition-source");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-transition-notice",
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const sourceProjection = activeProjection(await harness.runtime.start());
    const authority = await seeded.coordinator.readAuthority();
    if (authority.mode !== "active") throw new Error("Expected active source authority");
    const targetAccountId = "account-transition-target";
    const attempt = createSessionAttempt({
      kind: "acquisition",
      attemptId: "attempt-transition-target",
      serverAuthority: SERVER_AUTHORITY,
      baselineGeneration: authority.generation,
      sourceEpoch: seeded.activation.sessionEpoch,
      expiresAt: Date.now() + 60_000,
      payload: {},
    });
    if (attempt.kind !== "acquisition") throw new Error("Expected acquisition attempt");
    await seeded.coordinator.putAttempt(attempt);
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ user: { id: targetAccountId } }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const proof = await seeded.coordinator.requestCandidateMe({
      attempt,
      serverAuthority: SERVER_AUTHORITY,
      candidate: {
        accessToken: jwt(targetAccountId, "access", "transition-target"),
        refreshToken: jwt(targetAccountId, "refresh", "transition-target"),
      },
      signal: new AbortController().signal,
    });
    const target = createActivationCertificate({
      sessionEpoch: "epoch-transition-target",
      authGeneration: "generation-transition-target",
      transitionPermitId: "permit-transition-target",
      serverAuthority: SERVER_AUTHORITY,
      accountId: targetAccountId,
      scopeKey: createAccountScopeKey(SERVER_AUTHORITY, targetAccountId),
    });
    const permit = await seeded.coordinator.reserveAcquisitionTransition(
      { generation: authority.generation, revision: authority.revision + 1 },
      proof.proof,
      target,
      seeded.activation,
    );
    fetch.mockResolvedValue(activeMe(targetAccountId, ["org-b"], "org-b"));

    harness.notices.deliverSourceRetired(seeded.activation.sessionEpoch);

    expect(harness.runtime.getProjection().kind).toBe("veiled");
    expect(sourceProjection.accountLease.signal.aborted).toBe(true);
    await vi.waitFor(async () => {
      const current = await seeded.coordinator.readAuthority();
      expect(current).toMatchObject({
        mode: "transition",
        phase: "source_purged",
        permit: { permitId: permit.permitId },
      });
    });
    const purged = await seeded.coordinator.readAuthority();
    if (purged.mode !== "transition" || !purged.cleanupReceipt) throw new Error("Expected purged transition");
    await seeded.coordinator.completeAcquisitionTransition(permit, proof.proof, purged.cleanupReceipt);
    harness.notices.deliverAuthorityAdvanced();

    await vi.waitFor(() => expect(harness.runtime.getProjection().kind).toBe("active"));
    expect(activeProjection(harness.runtime.getProjection()).activation).toEqual(target);
  });

  it("refuses authenticated reveal when no cross-document notice transport is usable", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-no-notices");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "no-notices");
    const notices = new ManualNoticeHarness();
    notices.available = false;
    notices.sourceDelivery = Object.freeze({ broadcast: false, storage: false });
    notices.authorityDelivery = Object.freeze({ broadcast: false, storage: false });
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-no-notices",
      notices,
    );
    const fetch = vi.spyOn(globalThis, "fetch");

    await expect(harness.runtime.start()).resolves.toMatchObject({
      kind: "recovery",
      reason: sessionErrorCodes.platformUnavailable,
    });
    expect(fetch).not.toHaveBeenCalled();

    await expect(harness.runtime.logout()).rejects.toMatchObject({ code: sessionErrorCodes.recoveryRequired });
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
    expect(harness.authority.pin).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("logs out durable active authority directly when boot recovery installed no local runtime", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-recovery-logout");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "recovery-logout");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-recovery-logout",
    );
    harness.authority.pin.mockRejectedValue(new TypeError("offline"));
    const fetch = vi.spyOn(globalThis, "fetch");

    await expect(harness.runtime.start()).resolves.toMatchObject({ kind: "recovery" });
    expect(harness.authority.pin).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();

    await expect(harness.runtime.logout()).resolves.toBe("completed");
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
    expect(harness.authority.pin).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not let an E-owned recovery surface retire a newer active F", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-recovery-foreign-active");
    const locks = new ImmediateLocks();
    const source = await seedActive(factory, localStorage, sessionStorage, locks, "recovery-foreign-source");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      source.activation,
      "runtime-recovery-foreign-active",
    );
    harness.authority.pin.mockRejectedValue(new TypeError("offline"));
    await expect(harness.runtime.start()).resolves.toMatchObject({ kind: "recovery" });

    const external = new AuthSessionCoordinator({
      indexedDB: factory,
      legacyPersistence: { indexedDB: factory, localStorage, sessionStorage },
    });
    await external.beginRetirement(source.activation, "logout", "recovery-foreign-source-retiring");
    const sourceReceipt = await source.barrier.purgeAccountScope(source.activation, { localStorage, sessionStorage });
    await external.completeRetirement(source.activation, sourceReceipt, "recovery-foreign-source-none");
    const target = await seedActive(factory, localStorage, sessionStorage, locks, "recovery-foreign-target");
    const targetSession = await target.coordinator.readActiveSession();
    const targetDatabase = createScopedDatabaseName("chat-content", 1, target.activation.scopeKey);
    await putRawRow(factory, targetDatabase, "owner", "target-row");
    harness.authority.pin.mockResolvedValue(target.activation.serverAuthority);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      activeMe(target.activation.accountId, ["org-target"], "org-target"),
    );

    await expect(harness.runtime.logout()).resolves.toBe("superseded");
    expect(await target.coordinator.readActiveSession()).toEqual(targetSession);
    expect(await readRawRow(factory, targetDatabase, "owner")).toBe("target-row");
    expect(harness.runtime.getProjection()).toMatchObject({
      kind: "active",
      activation: target.activation,
    });
  });

  it("does not let an E-owned recovery surface finish a newer F retirement", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-recovery-foreign-retiring");
    const locks = new ImmediateLocks();
    const source = await seedActive(factory, localStorage, sessionStorage, locks, "recovery-retiring-source");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      source.activation,
      "runtime-recovery-foreign-retiring",
    );
    harness.authority.pin.mockRejectedValue(new TypeError("offline"));
    await expect(harness.runtime.start()).resolves.toMatchObject({ kind: "recovery" });

    const external = new AuthSessionCoordinator({
      indexedDB: factory,
      legacyPersistence: { indexedDB: factory, localStorage, sessionStorage },
    });
    await external.beginRetirement(source.activation, "logout", "recovery-retiring-source-retiring");
    const sourceReceipt = await source.barrier.purgeAccountScope(source.activation, { localStorage, sessionStorage });
    await external.completeRetirement(source.activation, sourceReceipt, "recovery-retiring-source-none");
    const replacement = await seedActive(
      factory,
      localStorage,
      sessionStorage,
      locks,
      "recovery-retiring-F",
      undefined,
      SERVER_AUTHORITY,
      false,
    );
    const replacementDatabase = createScopedDatabaseName("chat-content", 1, replacement.activation.scopeKey);
    await putRawRow(factory, replacementDatabase, "owner", "replacement-row");
    await external.beginRetirement(replacement.activation, "logout", "recovery-retiring-F-pending");
    const before = await external.readAuthority();

    await expect(harness.runtime.logout()).resolves.toBe("superseded");
    expect(await external.readAuthority()).toEqual(before);
    expect(await readRawRow(factory, replacementDatabase, "owner")).toBe("replacement-row");
    expect(harness.notices.retiredEpochs).not.toContain(replacement.activation.sessionEpoch);
  });

  it("does not let an E-owned recovery surface cancel or purge a newer F-to-G transition", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-recovery-foreign-transition");
    const locks = new ImmediateLocks();
    const source = await seedActive(factory, localStorage, sessionStorage, locks, "recovery-transition-source");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      source.activation,
      "runtime-recovery-foreign-transition",
    );
    harness.authority.pin.mockRejectedValue(new TypeError("offline"));
    await expect(harness.runtime.start()).resolves.toMatchObject({ kind: "recovery" });

    const external = new AuthSessionCoordinator({ indexedDB: factory });
    await external.beginRetirement(source.activation, "logout", "recovery-transition-source-retiring");
    const sourceReceipt = await source.barrier.purgeAccountScope(source.activation, { localStorage, sessionStorage });
    await external.completeRetirement(source.activation, sourceReceipt, "recovery-transition-source-none");
    const replacement = await seedActive(factory, localStorage, sessionStorage, locks, "recovery-transition-f");
    const replacementDatabase = createScopedDatabaseName("chat-content", 1, replacement.activation.scopeKey);
    await putRawRow(factory, replacementDatabase, "owner", "replacement-row");
    const target = await reserveReplacementTransition(replacement, "recovery-transition-g");

    await expect(harness.runtime.logout()).resolves.toBe("superseded");
    expect(await replacement.coordinator.readAuthority()).toMatchObject({
      mode: "transition",
      phase: "revoked",
      permit: { permitId: target.transitionPermitId },
      source: replacement.activation,
    });
    expect(await readRawRow(factory, replacementDatabase, "owner")).toBe("replacement-row");
    expect(harness.notices.retiredEpochs).not.toContain(replacement.activation.sessionEpoch);
  });

  it("does not let a late E logout cancel a newer anonymous-generation acquisition attempt", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-recovery-anonymous-attempt");
    const locks = new ImmediateLocks();
    const source = await seedActive(factory, localStorage, sessionStorage, locks, "recovery-anonymous-attempt-E");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      source.activation,
      "runtime-recovery-anonymous-attempt",
    );
    harness.authority.pin.mockRejectedValue(new TypeError("offline"));
    await expect(harness.runtime.start()).resolves.toMatchObject({ kind: "recovery" });

    const external = new AuthSessionCoordinator({ indexedDB: factory });
    await external.beginRetirement(source.activation, "logout", "recovery-anonymous-attempt-E-retiring");
    const sourceReceipt = await source.barrier.purgeAccountScope(source.activation, { localStorage, sessionStorage });
    await external.completeRetirement(source.activation, sourceReceipt, "recovery-anonymous-attempt-none");
    const anonymous = await external.readAuthority();
    const candidateAttempt = createSessionAttempt({
      kind: "acquisition",
      attemptId: "attempt-recovery-anonymous-attempt-F",
      serverAuthority: SERVER_AUTHORITY,
      baselineGeneration: anonymous.generation,
      sourceEpoch: null,
      expiresAt: Date.now() + 60_000,
      payload: {},
    });
    if (candidateAttempt.kind !== "acquisition") throw new Error("Expected acquisition attempt");
    await external.putAttempt(candidateAttempt);
    const before = await external.readAuthority();

    await expect(harness.runtime.logout()).resolves.toBe("superseded");
    expect(await external.readAuthority()).toEqual(before);
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "recovery" });

    const candidateFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "account-recovery-anonymous-attempt-F" } }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      external.requestCandidateMe({
        attempt: candidateAttempt,
        serverAuthority: SERVER_AUTHORITY,
        candidate: {
          accessToken: jwt("account-recovery-anonymous-attempt-F", "access", "recovery-anonymous-attempt-F"),
          refreshToken: jwt("account-recovery-anonymous-attempt-F", "refresh", "recovery-anonymous-attempt-F"),
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ accountId: "account-recovery-anonymous-attempt-F" });
    candidateFetch.mockRestore();
  });

  it("assists newer anonymous cleaning without reporting a late E logout as completed", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-recovery-foreign-cleaning");
    const locks = new ImmediateLocks();
    const source = await seedActive(factory, localStorage, sessionStorage, locks, "recovery-foreign-cleaning-E");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      source.activation,
      "runtime-recovery-foreign-cleaning",
    );
    harness.authority.pin.mockRejectedValue(new TypeError("offline"));
    await expect(harness.runtime.start()).resolves.toMatchObject({ kind: "recovery" });

    const external = new AuthSessionCoordinator({ indexedDB: factory });
    await external.beginRetirement(source.activation, "logout", "recovery-foreign-cleaning-E-retiring");
    const sourceReceipt = await source.barrier.purgeAccountScope(source.activation, { localStorage, sessionStorage });
    await external.completeRetirement(source.activation, sourceReceipt, "recovery-foreign-cleaning-none");
    const anonymous = await external.readAuthority();
    await external.cancelAnonymousAuthority(anonymous, "recovery-foreign-cleaning-pending");

    await expect(harness.runtime.logout()).resolves.toBe("superseded");
    expect(await external.readAuthority()).toMatchObject({ mode: "none" });
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "recovery" });
  });

  it("does not let an E-owned recovery surface cancel a newer source-free acquisition", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-recovery-source-free-transition");
    const locks = new ImmediateLocks();
    const source = await seedActive(factory, localStorage, sessionStorage, locks, "recovery-source-free-E");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      source.activation,
      "runtime-recovery-source-free-transition",
    );
    harness.authority.pin.mockRejectedValue(new TypeError("offline"));
    await expect(harness.runtime.start()).resolves.toMatchObject({ kind: "recovery" });

    const external = new AuthSessionCoordinator({
      indexedDB: factory,
      legacyPersistence: { indexedDB: factory, localStorage, sessionStorage },
    });
    await external.beginRetirement(source.activation, "logout", "recovery-source-free-E-retiring");
    const sourceReceipt = await source.barrier.purgeAccountScope(source.activation, { localStorage, sessionStorage });
    await external.completeRetirement(source.activation, sourceReceipt, "recovery-source-free-none");
    const anonymous = await external.readAuthority();
    const candidateAttempt = createSessionAttempt({
      kind: "acquisition",
      attemptId: "attempt-recovery-source-free-F",
      serverAuthority: SERVER_AUTHORITY,
      baselineGeneration: anonymous.generation,
      sourceEpoch: null,
      expiresAt: Date.now() + 60_000,
      payload: {},
    });
    if (candidateAttempt.kind !== "acquisition") throw new Error("Expected acquisition attempt");
    await external.putAttempt(candidateAttempt);
    const cursor = await external.readAuthority();
    const target = createActivationCertificate({
      sessionEpoch: "epoch-recovery-source-free-F",
      authGeneration: "generation-recovery-source-free-F",
      transitionPermitId: "permit-recovery-source-free-F",
      serverAuthority: SERVER_AUTHORITY,
      accountId: "account-recovery-source-free-F",
      scopeKey: createAccountScopeKey(SERVER_AUTHORITY, "account-recovery-source-free-F"),
    });
    const candidateFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: { id: target.accountId } }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const candidate = await external.requestCandidateMe({
      attempt: candidateAttempt,
      serverAuthority: SERVER_AUTHORITY,
      candidate: {
        accessToken: jwt(target.accountId, "access", "recovery-source-free-F"),
        refreshToken: jwt(target.accountId, "refresh", "recovery-source-free-F"),
      },
      signal: new AbortController().signal,
    });
    candidateFetch.mockRestore();
    const permit = await external.reserveAcquisitionTransition(
      { generation: cursor.generation, revision: cursor.revision },
      candidate.proof,
      target,
      null,
    );
    const targetDatabase = createScopedDatabaseName("chat-content", 1, target.scopeKey);
    await putRawRow(factory, targetDatabase, "owner", "candidate-row");
    const before = await external.readAuthority();

    await expect(harness.runtime.logout()).resolves.toBe("superseded");
    expect(await external.readAuthority()).toEqual(before);
    expect(await readRawRow(factory, targetDatabase, "owner")).toBe("candidate-row");
    expect(harness.notices.retiredEpochs).not.toContain(target.sessionEpoch);
    await expect(
      external.cancelAcquisitionTransition(permit, "recovery-source-free-proof-attempt-remained"),
    ).resolves.toMatchObject({ kind: "cleaning" });
  });

  it("does not purge F-to-G when anonymous cancellation loses after an initial none read", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-recovery-cancel-race");
    const locks = new ImmediateLocks();
    const source = await seedActive(factory, localStorage, sessionStorage, locks, "recovery-cancel-race-E");
    const external = new AuthSessionCoordinator({ indexedDB: factory });
    await external.beginRetirement(source.activation, "logout", "recovery-cancel-race-E-retiring");
    const sourceReceipt = await source.barrier.purgeAccountScope(source.activation, { localStorage, sessionStorage });
    await external.completeRetirement(source.activation, sourceReceipt, "recovery-cancel-race-none");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      source.activation,
      "runtime-recovery-cancel-race",
    );
    await expect(harness.runtime.start()).resolves.toMatchObject({ kind: "anonymous" });

    const originalCancel = AuthSessionCoordinator.prototype.cancelAnonymousAuthority;
    let replacementDatabase = "";
    vi.spyOn(AuthSessionCoordinator.prototype, "cancelAnonymousAuthority").mockImplementationOnce(async function (
      this: AuthSessionCoordinator,
      expected,
      nextGeneration,
    ) {
      const replacement = await seedActive(
        factory,
        localStorage,
        sessionStorage,
        locks,
        "recovery-cancel-race-F",
        undefined,
        SERVER_AUTHORITY,
        false,
      );
      replacementDatabase = createScopedDatabaseName("chat-content", 1, replacement.activation.scopeKey);
      await putRawRow(factory, replacementDatabase, "owner", "replacement-row");
      await reserveReplacementTransition(replacement, "recovery-cancel-race-G");
      return originalCancel.call(this, expected, nextGeneration);
    });

    await expect(harness.runtime.logout()).resolves.toBe("superseded");
    expect(await external.readAuthority()).toMatchObject({
      mode: "transition",
      phase: "revoked",
      source: { accountId: "account-recovery-cancel-race-F" },
      permit: { permitId: "permit-recovery-cancel-race-G" },
    });
    expect(await readRawRow(factory, replacementDatabase, "owner")).toBe("replacement-row");
    expect(harness.notices.retiredEpochs).not.toContain("epoch-recovery-cancel-race-F");
  });

  it("cancels and scrubs a true anonymous transition that wins the initial logout CAS", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-anonymous-transition-race");
    const locks = new ImmediateLocks();
    const expectedAuthority = createActivationCertificate({
      sessionEpoch: "epoch-anonymous-transition-probe",
      authGeneration: "generation-anonymous-transition-probe",
      transitionPermitId: "permit-anonymous-transition-probe",
      serverAuthority: SERVER_AUTHORITY,
      accountId: "account-anonymous-transition-probe",
      scopeKey: createAccountScopeKey(SERVER_AUTHORITY, "account-anonymous-transition-probe"),
    });
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      expectedAuthority,
      "runtime-anonymous-transition-race",
    );
    await expect(harness.runtime.start()).resolves.toEqual({ kind: "anonymous" });
    localStorage.setItem("first-tree:tokens", "late-anonymous-secret");

    const external = new AuthSessionCoordinator({
      indexedDB: factory,
      legacyPersistence: { indexedDB: factory, localStorage, sessionStorage },
    });
    const originalCancel = AuthSessionCoordinator.prototype.cancelAnonymousAuthority;
    vi.spyOn(AuthSessionCoordinator.prototype, "cancelAnonymousAuthority").mockImplementationOnce(async function (
      this: AuthSessionCoordinator,
      expected,
      nextGeneration,
    ) {
      const baseline = await external.readAuthority();
      if (baseline.mode !== "none") throw new Error("expected anonymous baseline");
      const target = createActivationCertificate({
        sessionEpoch: "epoch-anonymous-transition-target",
        authGeneration: "generation-anonymous-transition-target",
        transitionPermitId: "permit-anonymous-transition-target",
        serverAuthority: SERVER_AUTHORITY,
        accountId: "account-anonymous-transition-target",
        scopeKey: createAccountScopeKey(SERVER_AUTHORITY, "account-anonymous-transition-target"),
      });
      const candidateAttempt = createSessionAttempt({
        kind: "acquisition",
        attemptId: "attempt-anonymous-transition-target",
        serverAuthority: SERVER_AUTHORITY,
        baselineGeneration: baseline.generation,
        sourceEpoch: null,
        expiresAt: Date.now() + 60_000,
        payload: {},
      });
      if (candidateAttempt.kind !== "acquisition") throw new Error("expected acquisition attempt");
      await external.putAttempt(candidateAttempt);
      const cursor = await external.readAuthority();
      const candidateFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ user: { id: target.accountId } }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      try {
        const candidate = await external.requestCandidateMe({
          attempt: candidateAttempt,
          serverAuthority: SERVER_AUTHORITY,
          candidate: {
            accessToken: jwt(target.accountId, "access", "anonymous-transition-target"),
            refreshToken: jwt(target.accountId, "refresh", "anonymous-transition-target"),
          },
          signal: new AbortController().signal,
        });
        await external.reserveAcquisitionTransition(
          { generation: cursor.generation, revision: cursor.revision },
          candidate.proof,
          target,
          null,
        );
      } finally {
        candidateFetch.mockRestore();
      }
      return originalCancel.call(this, expected, nextGeneration);
    });

    await expect(harness.runtime.logout()).resolves.toBe("completed");
    expect(await external.readAuthority()).toMatchObject({ mode: "none" });
    expect(localStorage.getItem("first-tree:tokens")).toBeNull();
    expect(harness.notices.retiredEpochs).toEqual([]);
    expect(harness.runtime.getProjection()).toEqual({ kind: "anonymous" });
  });

  it("does not purge F-to-G when local E retirement loses at its commit boundary", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-begin-retirement-race");
    const locks = new ImmediateLocks();
    const source = await seedActive(factory, localStorage, sessionStorage, locks, "begin-retirement-race-E");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      source.activation,
      "runtime-begin-retirement-race",
    );
    const activeFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(activeMe(source.activation.accountId, ["org-e"], "org-e"));
    await harness.runtime.start();
    activeFetch.mockRestore();

    const originalBegin = AuthSessionCoordinator.prototype.beginRetirement;
    let replacementDatabase = "";
    vi.spyOn(AuthSessionCoordinator.prototype, "beginRetirement").mockImplementationOnce(async function (
      this: AuthSessionCoordinator,
      captured,
      cause,
      nextGeneration,
    ) {
      await originalBegin.call(this, source.activation, "logout", "begin-retirement-race-E-retiring");
      const sourceReceipt = await source.barrier.purgeAccountScope(source.activation, { localStorage, sessionStorage });
      await this.completeRetirement(source.activation, sourceReceipt, "begin-retirement-race-none");
      const replacement = await seedActive(
        factory,
        localStorage,
        sessionStorage,
        locks,
        "begin-retirement-race-F",
        undefined,
        SERVER_AUTHORITY,
        false,
      );
      replacementDatabase = createScopedDatabaseName("chat-content", 1, replacement.activation.scopeKey);
      await putRawRow(factory, replacementDatabase, "owner", "replacement-row");
      await reserveReplacementTransition(replacement, "begin-retirement-race-G");
      return originalBegin.call(this, captured, cause, nextGeneration);
    });

    await expect(harness.runtime.logout()).resolves.toBe("superseded");
    expect(await source.coordinator.readAuthority()).toMatchObject({
      mode: "transition",
      phase: "revoked",
      source: { accountId: "account-begin-retirement-race-F" },
      permit: { permitId: "permit-begin-retirement-race-G" },
    });
    expect(await readRawRow(factory, replacementDatabase, "owner")).toBe("replacement-row");
    expect(harness.notices.retiredEpochs).not.toContain("epoch-begin-retirement-race-F");
  });

  it("does not purge F-to-G when it appears after E retirement commits but before local delivery", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-complete-retirement-race");
    const locks = new ImmediateLocks();
    const source = await seedActive(factory, localStorage, sessionStorage, locks, "complete-retirement-race-E");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      source.activation,
      "runtime-complete-retirement-race",
    );
    const activeFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(activeMe(source.activation.accountId, ["org-e"], "org-e"));
    await harness.runtime.start();
    activeFetch.mockRestore();

    const originalComplete = AuthSessionCoordinator.prototype.completeRetirement;
    let replacementDatabase = "";
    vi.spyOn(AuthSessionCoordinator.prototype, "completeRetirement").mockImplementationOnce(async function (
      this: AuthSessionCoordinator,
      captured,
      receipt,
      nextGeneration,
    ) {
      await originalComplete.call(this, captured, receipt, nextGeneration);
      const replacement = await seedActive(
        factory,
        localStorage,
        sessionStorage,
        locks,
        "complete-retirement-race-F",
        undefined,
        SERVER_AUTHORITY,
        false,
      );
      replacementDatabase = createScopedDatabaseName("chat-content", 1, replacement.activation.scopeKey);
      await putRawRow(factory, replacementDatabase, "owner", "replacement-row");
      await reserveReplacementTransition(replacement, "complete-retirement-race-G");
    });

    await expect(harness.runtime.logout()).resolves.toBe("superseded");
    expect(await source.coordinator.readAuthority()).toMatchObject({
      mode: "transition",
      phase: "revoked",
      source: { accountId: "account-complete-retirement-race-F" },
      permit: { permitId: "permit-complete-retirement-race-G" },
    });
    expect(await readRawRow(factory, replacementDatabase, "owner")).toBe("replacement-row");
    expect(harness.notices.retiredEpochs).not.toContain("epoch-complete-retirement-race-F");
  });

  it("recovers a committed anonymous-cleaning tombstone after logout result delivery is lost", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-anonymous-cleaning-recovery");
    const locks = new ImmediateLocks();
    const dummyAccountId = "account-anonymous-cleaning-recovery";
    const dummyActivation = createActivationCertificate({
      sessionEpoch: "epoch-anonymous-cleaning-recovery",
      authGeneration: "generation-anonymous-cleaning-recovery",
      transitionPermitId: "permit-anonymous-cleaning-recovery",
      serverAuthority: SERVER_AUTHORITY,
      accountId: dummyAccountId,
      scopeKey: createAccountScopeKey(SERVER_AUTHORITY, dummyAccountId),
    });
    let reportBlocked = (_databaseName: string): void => undefined;
    const blocked = new Promise<string>((resolve) => {
      reportBlocked = resolve;
    });
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      dummyActivation,
      "runtime-anonymous-cleaning-recovery",
      new ManualNoticeHarness(),
      reportBlocked,
    );
    await expect(harness.runtime.start()).resolves.toEqual({ kind: "anonymous" });
    const legacyBlocker = await rawOpen(factory, LEGACY_DATABASE_NAMES[0]);
    const originalCancel = AuthSessionCoordinator.prototype.cancelAnonymousAuthority;
    vi.spyOn(AuthSessionCoordinator.prototype, "cancelAnonymousAuthority").mockImplementationOnce(async function (
      this: AuthSessionCoordinator,
      ...args: Parameters<AuthSessionCoordinator["cancelAnonymousAuthority"]>
    ) {
      await originalCancel.apply(this, args);
      harness.windowTarget.dispatchEvent(new Event("pagehide"));
      throw new Error("committed cancellation result was lost");
    });

    await expect(harness.runtime.logout()).rejects.toThrow("committed cancellation result was lost");
    const observer = new AuthSessionCoordinator({ indexedDB: factory });
    expect(await observer.readAuthority()).toMatchObject({ mode: "cleaning" });

    const resuming = harness.runtime.resume();
    await expect(blocked).resolves.toBe(LEGACY_DATABASE_NAMES[0]);
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "veiled" });
    expect(await observer.readAuthority()).toMatchObject({ mode: "cleaning" });
    legacyBlocker.close();

    await expect(resuming).resolves.toEqual({ kind: "anonymous" });
    expect(await observer.readAuthority()).toMatchObject({ mode: "none" });
  });

  it("retires durable recovery authority before repeated legacy cleanup can block logout", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-recovery-logout-order");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "recovery-logout-order");
    let reportBlocked = (_databaseName: string): void => undefined;
    const blocked = new Promise<string>((resolve) => {
      reportBlocked = resolve;
    });
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-recovery-logout-order",
      new ManualNoticeHarness(),
      reportBlocked,
    );
    harness.authority.pin.mockRejectedValue(new TypeError("offline"));
    await expect(harness.runtime.start()).resolves.toMatchObject({ kind: "recovery" });
    const legacyBlocker = await rawOpen(factory, LEGACY_DATABASE_NAMES[0]);

    let settled = false;
    const logout = harness.runtime.logout().finally(() => {
      settled = true;
    });
    await expect(blocked).resolves.toBe(LEGACY_DATABASE_NAMES[0]);
    expect(settled).toBe(false);
    expect(await seeded.coordinator.readAuthority()).toMatchObject({
      mode: "retiring",
      source: seeded.activation,
      phase: "revoked",
    });
    await expect(seeded.coordinator.readActiveSession()).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });

    legacyBlocker.close();
    await expect(logout).resolves.toBe("completed");
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
  });

  it("uses authority-advanced only as a fresh-read hint after an external logout", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-authority-advanced");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "authority-advanced");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-authority-advanced",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    const external = new AuthSessionCoordinator({ indexedDB: factory });
    await external.beginRetirement(seeded.activation, "logout", "external-advanced-retirement");
    const receipt = await seeded.barrier.purgeAccountScope(seeded.activation, { localStorage, sessionStorage });
    await external.completeRetirement(seeded.activation, receipt, "external-advanced-anonymous");

    harness.notices.deliverAuthorityAdvanced();

    expect(harness.runtime.getProjection()).toBe(before);
    await vi.waitFor(() => expect(harness.runtime.getProjection()).toEqual({ kind: "anonymous" }));
    expect(before.accountLease.signal.aborted).toBe(true);
  });

  it("fails closed when an authority-advanced hint cannot be reconciled transactionally", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-authority-read-failure");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "authority-read-failure");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-authority-read-failure",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    vi.spyOn(AuthSessionCoordinator.prototype, "readAuthority").mockRejectedValueOnce(
      new Error("coordinator unavailable"),
    );

    harness.notices.deliverAuthorityAdvanced();

    await vi.waitFor(() => expect(harness.runtime.getProjection()).toMatchObject({ kind: "recovery" }));
    expect(before.accountLease.signal.aborted).toBe(true);
    expect(harness.runtime.getProjection().kind).not.toBe("active");
    await expect(harness.runtime.logout()).resolves.toBe("completed");
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
  });

  it("publishes needs-selection when current membership disappears", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-membership");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "membership");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-membership",
    );
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    expect(before.publication.state).toMatchObject({ kind: "selected", organizationId: "org-a" });

    fetch.mockResolvedValueOnce(activeMe(seeded.activation.accountId, ["org-b"], null));
    const after = activeProjection(await harness.runtime.refresh());
    expect(after.publication.state.kind).toBe("needs-selection");
    expect(after.publication.viewLease).toBeNull();
  });

  it("restores the exact current view after a rejected organization request", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-rejected-switch");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "rejected-switch");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-rejected-switch",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());

    const after = activeProjection(await harness.runtime.switchOrganization("org-not-a-member"));
    expect(after).toBe(before);
    expect(after.publication.state).toMatchObject({ kind: "selected", organizationId: "org-a" });
  });

  it("does not complete logout or publish anonymous before the verified purge finishes", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-logout");
    const locks = new PurgeGateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "logout");
    const harness = createRuntime(factory, localStorage, sessionStorage, locks, seeded.activation, "runtime-logout");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    await harness.runtime.start();
    localStorage.setItem("first-tree:tokens", "late-legacy-secret");
    locks.holdPurge();

    let settled = false;
    const logout = harness.runtime.logout().finally(() => {
      settled = true;
    });
    await locks.purgeStarted;
    expect(settled).toBe(false);
    expect(harness.runtime.getProjection().kind).toBe("veiled");
    harness.notices.deliverSourceRetired(seeded.activation.sessionEpoch);
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "veiled", reason: "logout" });
    locks.releasePurge();

    await expect(logout).resolves.toBe("completed");
    expect(harness.runtime.getProjection()).toEqual({ kind: "anonymous" });
    expect(localStorage.getItem("first-tree:tokens")).toBeNull();
  });

  it("keeps a failed purge veiled and recovery-only", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-failed-logout");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "failed-logout");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-failed-logout",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    await harness.runtime.start();
    localStorage.setItem("first-tree:tokens", "cannot-remove");
    localStorage.refuseRemoval("first-tree:tokens");

    await expect(harness.runtime.logout()).rejects.toMatchObject({
      code: sessionErrorCodes.persistenceUnavailable,
    });
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "recovery" });
    expect(harness.runtime.getProjection().kind).not.toBe("anonymous");
    expect(await seeded.coordinator.readAuthority()).toMatchObject({
      mode: "retiring",
      source: seeded.activation,
    });

    localStorage.allowRemoval();
    await expect(harness.runtime.logout()).resolves.toBe("completed");
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
    expect(harness.runtime.getProjection()).toEqual({ kind: "anonymous" });
    expect(localStorage.getItem("first-tree:tokens")).toBeNull();
    expect(harness.notices.retiredEpochs).toEqual([seeded.activation.sessionEpoch, seeded.activation.sessionEpoch]);
  });

  it("never reports completion when local repeated cleanup fails after another tab completes retirement", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-local-cleanup-failure");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "local-cleanup-failure");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-local-cleanup-failure",
    );
    harness.authority.pin.mockRejectedValue(new TypeError("offline"));
    await expect(harness.runtime.start()).resolves.toMatchObject({ kind: "recovery" });
    const external = new AuthSessionCoordinator({ indexedDB: factory });
    await external.beginRetirement(seeded.activation, "logout", "local-cleanup-failure-retiring");
    const receipt = await seeded.barrier.purgeAccountScope(seeded.activation, { localStorage, sessionStorage });
    sessionStorage.setItem("first-tree:auth-attempt", "sensitive-local-residue");
    sessionStorage.refuseRemoval("first-tree:auth-attempt");
    const originalPurge = ContentScopeBarrier.prototype.purgeAccountScope;
    vi.spyOn(ContentScopeBarrier.prototype, "purgeAccountScope").mockImplementationOnce(async function (
      this: ContentScopeBarrier,
      ...args: Parameters<ContentScopeBarrier["purgeAccountScope"]>
    ) {
      try {
        return await originalPurge.apply(this, args);
      } catch (error) {
        await external.completeRetirement(seeded.activation, receipt, "local-cleanup-failure-none");
        await seedActive(factory, new MemoryStorage(), new MemoryStorage(), locks, "local-cleanup-failure-target");
        throw error;
      }
    });

    await expect(harness.runtime.logout()).rejects.toMatchObject({
      code: sessionErrorCodes.persistenceUnavailable,
    });
    expect(await external.readAuthority()).toMatchObject({
      mode: "active",
      session: { accountId: "account-local-cleanup-failure-target" },
    });
    expect(sessionStorage.getItem("first-tree:auth-attempt")).toBe("sensitive-local-residue");
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "recovery" });
  });

  it("finishes durable cleanup but refuses to report logout completion when every final notice path fails", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-notice-failure");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "notice-failure");
    const notices = new ManualNoticeHarness();
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-notice-failure",
      notices,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    await harness.runtime.start();
    notices.sourceDelivery = Object.freeze({ broadcast: false, storage: false });
    notices.authorityDelivery = Object.freeze({ broadcast: false, storage: false });

    await expect(harness.runtime.logout()).rejects.toMatchObject({
      code: sessionErrorCodes.recoveryRequired,
    });
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "recovery" });
    expect(notices.retiredEpochs).toEqual([seeded.activation.sessionEpoch]);
    expect(notices.authorityAdvancedCount).toBe(1);
  });

  it("finishes cleanup but rejects completion when source retirement delivery alone fails", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-source-notice-failure");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "source-notice-failure");
    const notices = new ManualNoticeHarness();
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-source-notice-failure",
      notices,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    await harness.runtime.start();
    notices.sourceDelivery = Object.freeze({ broadcast: false, storage: false });

    await expect(harness.runtime.logout()).rejects.toMatchObject({ code: sessionErrorCodes.recoveryRequired });
    expect(await seeded.coordinator.readAuthority()).toMatchObject({ mode: "none" });
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "recovery" });
    expect(notices.retiredEpochs).toEqual([seeded.activation.sessionEpoch]);
    expect(notices.authorityAdvancedCount).toBe(1);
  });

  it("never restores the old projection when a refreshed credential cannot be announced", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-refresh-notice-failure");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "refresh-notice-failure");
    const notices = new ManualNoticeHarness();
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-refresh-notice-failure",
      notices,
    );
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const before = activeProjection(await harness.runtime.start());
    notices.authorityDelivery = Object.freeze({ broadcast: false, storage: false });
    fetch.mockResolvedValueOnce(new Response("expired", { status: 401 }));
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accessToken: jwt(seeded.activation.accountId, "access", "notice-failure-rotated"),
          refreshToken: jwt(seeded.activation.accountId, "refresh", "notice-failure-rotated"),
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    fetch.mockResolvedValueOnce(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));

    await expect(harness.runtime.refresh()).resolves.toMatchObject({ kind: "recovery" });

    expect((await seeded.coordinator.readActiveSession()).credential.credentialRevision).toBe(1);
    expect(before.accountLease.signal.aborted).toBe(true);
    expect(harness.runtime.getProjection().kind).not.toBe("active");
    expect(notices.authorityAdvancedCount).toBe(1);
  });

  it("converges when another document completes the same retirement first", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-concurrent-logout");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "concurrent-logout");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-concurrent-logout",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    await harness.runtime.start();

    const originalComplete = AuthSessionCoordinator.prototype.completeRetirement;
    let releaseFirst = (): void => undefined;
    let firstReached = (): void => undefined;
    const firstCompletion = new Promise<void>((resolve) => {
      firstReached = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    vi.spyOn(AuthSessionCoordinator.prototype, "completeRetirement").mockImplementation(async function (
      this: AuthSessionCoordinator,
      source,
      receipt,
      generation,
    ) {
      calls += 1;
      if (calls === 1) {
        firstReached();
        await firstRelease;
      }
      return originalComplete.call(this, source, receipt, generation);
    });

    const localLogout = harness.runtime.logout();
    await firstCompletion;
    const external = new AuthSessionCoordinator({ indexedDB: factory });
    const receipt = await seeded.barrier.purgeAccountScope(seeded.activation, { localStorage, sessionStorage });
    await external.completeRetirement(seeded.activation, receipt, "external-concurrent-anonymous");
    releaseFirst();

    await expect(localLogout).resolves.toBe("completed");
    expect(harness.runtime.getProjection()).toEqual({ kind: "anonymous" });
  });

  it("does not publish anonymous when a newer account activates after retirement commits", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-retirement-superseded");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "retirement-superseded-E");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-retirement-superseded",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(seeded.activation.accountId, ["org-e"], "org-e"));
    await harness.runtime.start();

    const originalComplete = AuthSessionCoordinator.prototype.completeRetirement;
    let committed = (): void => undefined;
    let release = (): void => undefined;
    const committedPromise = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(AuthSessionCoordinator.prototype, "completeRetirement").mockImplementationOnce(async function (
      this: AuthSessionCoordinator,
      source,
      receipt,
      generation,
    ) {
      await originalComplete.call(this, source, receipt, generation);
      committed();
      await releasePromise;
    });

    const logout = harness.runtime.logout();
    await committedPromise;
    const replacement = await seedActive(factory, localStorage, sessionStorage, locks, "retirement-superseded-F");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(replacement.activation.accountId, ["org-f"], "org-f"));
    release();

    await expect(logout).resolves.toBe("superseded");
    expect(harness.runtime.getProjection()).toMatchObject({
      kind: "active",
      activation: replacement.activation,
      publication: { state: { kind: "selected", organizationId: "org-f" } },
    });
  });

  it("clears only legacy residue when a stale local logout loses before retirement to a newer account", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-stale-logout-newer-account");
    const locks = new ImmediateLocks();
    const source = await seedActive(factory, localStorage, sessionStorage, locks, "stale-logout-source");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      source.activation,
      "runtime-stale-logout-newer-account",
    );
    const sourceFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(activeMe(source.activation.accountId, ["org-source"], "org-source")));
    const sourceProjection = activeProjection(await harness.runtime.start());
    sourceFetch.mockRestore();

    const external = new AuthSessionCoordinator({ indexedDB: factory });
    await external.beginRetirement(source.activation, "logout", "stale-logout-source-retiring");
    const receipt = await source.barrier.purgeAccountScope(source.activation, { localStorage, sessionStorage });
    await external.completeRetirement(source.activation, receipt, "stale-logout-source-none");
    const target = await seedActive(factory, localStorage, sessionStorage, locks, "stale-logout-target");
    const targetSession = await target.coordinator.readActiveSession();
    const targetDatabase = createScopedDatabaseName("chat-content", 1, target.activation.scopeKey);
    await putRawRow(factory, targetDatabase, "owner", "target-row");
    localStorage.setItem("first-tree:tokens", "late-legacy-token");
    sessionStorage.setItem("first-tree:auth-attempt", "late-legacy-attempt");
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(activeMe(target.activation.accountId, ["org-target"], "org-target")),
    );

    await expect(harness.runtime.logout()).resolves.toBe("superseded");
    expect(sourceProjection.accountLease.signal.aborted).toBe(true);
    expect(harness.runtime.getProjection()).toMatchObject({
      kind: "active",
      activation: target.activation,
      publication: { state: { kind: "selected", organizationId: "org-target" } },
    });
    expect(await target.coordinator.readActiveSession()).toEqual(targetSession);
    expect(await readRawRow(factory, targetDatabase, "owner")).toBe("target-row");
    expect(localStorage.getItem("first-tree:tokens")).toBeNull();
    expect(sessionStorage.getItem("first-tree:auth-attempt")).toBeNull();
  });

  it("isolates a projection subscriber failure from authority publication", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-subscriber");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "subscriber");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-subscriber",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    const delivered: string[] = [];
    harness.runtime.subscribe((projection) => {
      if (projection.kind === "active") throw new Error("subscriber failed");
    });
    harness.runtime.subscribe((projection) => delivered.push(projection.kind));

    await expect(harness.runtime.start()).resolves.toMatchObject({ kind: "active" });
    expect(harness.runtime.getProjection()).toMatchObject({ kind: "active" });
    expect(delivered.at(-1)).toBe("active");
  });

  it("lets a reentrant subscriber supersede first publication without leaving a dead active handle", async () => {
    const factory = new IDBFactory();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(OWNER_TAB_STORAGE_KEY, "owner-reentrant-publication");
    const locks = new ImmediateLocks();
    const seeded = await seedActive(factory, localStorage, sessionStorage, locks, "reentrant-publication");
    const harness = createRuntime(
      factory,
      localStorage,
      sessionStorage,
      locks,
      seeded.activation,
      "runtime-reentrant-publication",
    );
    const held = deferredResponse();
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    fetch.mockImplementationOnce(() => held.promise);
    let reentrant: Promise<BrowserSessionProjection> | null = null;
    const activeLeases: Extract<BrowserSessionProjection, { kind: "active" }>["accountLease"][] = [];
    const secondaryActiveLeases: Extract<BrowserSessionProjection, { kind: "active" }>["accountLease"][] = [];
    harness.runtime.subscribe((projection) => {
      if (projection.kind !== "active" || reentrant !== null) return;
      activeLeases.push(projection.accountLease);
      reentrant = harness.runtime.refresh();
    });
    harness.runtime.subscribe((projection) => {
      if (projection.kind === "active") secondaryActiveLeases.push(projection.accountLease);
    });

    await expect(harness.runtime.start()).resolves.toMatchObject({ kind: "veiled" });
    const firstActiveLease = activeLeases[0];
    if (!firstActiveLease) throw new Error("Expected the reentrant subscriber to observe the first active lease");
    expect(firstActiveLease.signal.aborted).toBe(false);
    expect(reentrant).not.toBeNull();
    held.resolve(activeMe(seeded.activation.accountId, ["org-a"], "org-a"));
    await expect(reentrant).resolves.toMatchObject({ kind: "active" });
    expect(activeProjection(harness.runtime.getProjection()).accountLease).toBe(firstActiveLease);
    expect(firstActiveLease.signal.aborted).toBe(false);
    expect(secondaryActiveLeases).toEqual([firstActiveLease]);
  });
});
