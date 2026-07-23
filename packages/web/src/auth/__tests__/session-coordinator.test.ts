import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCandidateTokenSnapshot, fingerprintCandidateTokenSnapshot } from "../session/candidate-tokens.js";
import { claimVerifiedActiveMeProof, type VerifiedCandidateProof } from "../session/coordinator.js";
import {
  type AcquisitionSessionAttempt,
  type ActivationCertificate,
  AUTH_COORDINATOR_DATABASE_NAME,
  type AuthAuthority,
  AuthSessionCoordinator as BaseAuthSessionCoordinator,
  ContentScopeBarrier,
  type CoordinatorOptions,
  type CoordinatorSnapshot,
  closeCoordinatorConnections,
  createAccountLease,
  createAccountScopeKey,
  createActivationCertificate,
  createCredentialRecord,
  createManagementDeliveryPermit,
  createSessionAttempt,
  createViewLease,
  installAccountStoreRuntime,
  readVerifiedActiveMeProof,
  SessionError,
  type SessionLockManager,
  type StorageArea,
  scrubLegacyPersistence,
  sessionErrorCodes,
  validateCoordinatorSnapshot,
} from "../session/index.js";

const SERVER_AUTHORITY = "https://hub.example.test/api/v1";

function activation(label: string, authGeneration: string, accountId = `account-${label}`): ActivationCertificate {
  return createActivationCertificate({
    sessionEpoch: `epoch-${label}`,
    authGeneration,
    transitionPermitId: `permit-${label}`,
    serverAuthority: SERVER_AUTHORITY,
    accountId,
    scopeKey: createAccountScopeKey(SERVER_AUTHORITY, accountId),
  });
}

function base64Url(value: string): string {
  return btoa(value).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function jwt(accountId: string, kind: "access" | "refresh", marker: string, expiresAt = 2_100_000_000): string {
  return `${base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify({ sub: accountId, type: kind, exp: expiresAt, marker }),
  )}.signature`;
}

async function credential(
  certificate: ActivationCertificate,
  revision = 0,
  suffix = certificate.sessionEpoch,
  expiresAt: Readonly<{ access: number; refresh: number }> = { access: 2_100_000_000, refresh: 2_100_000_000 },
) {
  const accessToken = jwt(certificate.accountId, "access", `access-${suffix}`, expiresAt.access);
  const refreshToken = jwt(certificate.accountId, "refresh", `refresh-${suffix}`, expiresAt.refresh);
  const fingerprinted = await fingerprintCandidateTokenSnapshot(
    createCandidateTokenSnapshot({ accessToken, refreshToken }),
    certificate.serverAuthority,
  );
  return createCredentialRecord({
    activation: certificate,
    credentialRevision: revision,
    credentialFingerprint: fingerprinted.credentialFingerprint,
    accessToken,
    refreshToken,
  });
}

function attempt(attemptId: string, generation: string, sourceEpoch: string | null = null): AcquisitionSessionAttempt {
  const value = createSessionAttempt({
    attemptId,
    kind: "acquisition",
    serverAuthority: SERVER_AUTHORITY,
    baselineGeneration: generation,
    sourceEpoch,
    expiresAt: Date.now() + 60_000,
    payload: { mappedTab: `tab-${attemptId}` },
  });
  if (value.kind !== "acquisition") throw new Error("expected acquisition attempt fixture");
  return value;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

async function sessionRejection(promise: Promise<unknown>): Promise<SessionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionError) return error;
    throw error;
  }
  throw new Error("Expected a session rejection");
}

async function candidateProof(
  coordinator: AuthSessionCoordinator,
  candidateAttempt: AcquisitionSessionAttempt,
  targetCredential: Awaited<ReturnType<typeof credential>>,
  signal = new AbortController().signal,
): Promise<VerifiedCandidateProof> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ user: { id: targetCredential.activation.accountId } })),
  );
  return (
    await coordinator.requestCandidateMe({
      candidate: {
        accessToken: targetCredential.accessToken,
        refreshToken: targetCredential.refreshToken,
        credentialFingerprint: targetCredential.credentialFingerprint,
      },
      attempt: candidateAttempt,
      serverAuthority: targetCredential.activation.serverAuthority,
      signal,
    })
  ).proof;
}

async function activateAnonymous(
  _factory: IDBFactory,
  coordinator: AuthSessionCoordinator,
  certificate: ActivationCertificate,
  attemptId: string,
): Promise<void> {
  const beforeAttempt = await coordinator.readAuthority();
  const candidateAttempt = attempt(attemptId, beforeAttempt.generation);
  await coordinator.putAttempt(candidateAttempt);
  const beforeReservation = await coordinator.readAuthority();
  const targetCredential = await credential(certificate);
  const proof = await candidateProof(coordinator, candidateAttempt, targetCredential);
  const transition = await coordinator.reserveAcquisitionTransition(
    { generation: beforeReservation.generation, revision: beforeReservation.revision },
    proof,
    certificate,
    null,
  );
  await coordinator.completeAcquisitionTransition(transition, proof);
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function openCoordinatorDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(AUTH_COORDINATOR_DATABASE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("coordinator open failed"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("coordinator request failed"));
  });
}

async function readCoordinatorSnapshot(factory: IDBFactory): Promise<CoordinatorSnapshot> {
  const database = await openCoordinatorDatabase(factory);
  try {
    const transaction = database.transaction(["authority", "credentials", "attempts"], "readonly");
    const [authorityRow, credentials, attempts] = await Promise.all([
      requestResult(transaction.objectStore("authority").get("head")),
      requestResult(transaction.objectStore("credentials").getAll()),
      requestResult(transaction.objectStore("attempts").getAll()),
      transactionDone(transaction),
    ]);
    if (typeof authorityRow !== "object" || authorityRow === null || !("authority" in authorityRow)) {
      throw new Error("missing authority row fixture");
    }
    return validateCoordinatorSnapshot({
      authority: (authorityRow as { authority: unknown }).authority,
      credentials,
      attempts,
    });
  } finally {
    database.close();
  }
}

async function replaceCoordinatorSnapshotForTest(
  factory: IDBFactory,
  mutate: (snapshot: CoordinatorSnapshot) => CoordinatorSnapshot,
): Promise<void> {
  const current = await readCoordinatorSnapshot(factory);
  const next = mutate(current);
  const database = await openCoordinatorDatabase(factory);
  try {
    const transaction = database.transaction(["authority", "credentials", "attempts"], "readwrite");
    const authority = transaction.objectStore("authority");
    const credentials = transaction.objectStore("credentials");
    const attempts = transaction.objectStore("attempts");
    authority.clear();
    credentials.clear();
    attempts.clear();
    authority.put({ key: "head", authority: next.authority });
    for (const item of next.credentials) credentials.put(item);
    for (const item of next.attempts) attempts.put(item);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function writeRawCoordinatorSnapshotForTest(
  factory: IDBFactory,
  snapshot: Readonly<{ authority: unknown; credentials: readonly unknown[]; attempts: readonly unknown[] }>,
): Promise<void> {
  const database = await openCoordinatorDatabase(factory);
  try {
    const transaction = database.transaction(["authority", "credentials", "attempts"], "readwrite");
    const authority = transaction.objectStore("authority");
    const credentials = transaction.objectStore("credentials");
    const attempts = transaction.objectStore("attempts");
    authority.clear();
    credentials.clear();
    attempts.clear();
    authority.put({ key: "head", authority: snapshot.authority });
    for (const item of snapshot.credentials) credentials.put(item);
    for (const item of snapshot.attempts) attempts.put(item);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function deferNextOpen(factory: IDBFactory): Readonly<{
  started: Promise<void>;
  release: () => void;
}> {
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
      get(target, property) {
        return Reflect.get(target, property, target);
      },
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

class ImmediateLocks implements SessionLockManager {
  public async request<T>(
    _name: string,
    _options: Readonly<{ mode: "shared" | "exclusive"; signal?: AbortSignal }>,
    callback: () => T | PromiseLike<T>,
  ): Promise<T> {
    return callback();
  }
}

function memoryStorage(initial: Readonly<Record<string, string>> = {}): StorageArea {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

class AuthSessionCoordinator extends BaseAuthSessionCoordinator {
  public constructor(options: CoordinatorOptions = {}) {
    const indexedDB = options.indexedDB;
    super({
      ...options,
      legacyPersistence: options.legacyPersistence ?? {
        localStorage: memoryStorage(),
        sessionStorage: memoryStorage(),
        ...(indexedDB === undefined ? {} : { indexedDB }),
      },
    });
  }
}

async function purge(
  factory: IDBFactory,
  coordinator: AuthSessionCoordinator,
  certificate: ActivationCertificate,
): Promise<string> {
  const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
  return barrier.purgeAccountScope(certificate, {
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
  });
}

afterEach(() => {
  closeCoordinatorConnections();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AuthSessionCoordinator", () => {
  it("serializes concurrent writers in one authority/credentials/attempts transaction", async () => {
    const factory = new IDBFactory();
    const first = new AuthSessionCoordinator({ indexedDB: factory });
    const second = new AuthSessionCoordinator({ indexedDB: factory });
    await first.bootstrapAnonymous("generation-0");

    await Promise.all([
      first.putAttempt(attempt("x-1", "generation-0")),
      second.putAttempt(attempt("x-2", "generation-0")),
    ]);

    const snapshot = await readCoordinatorSnapshot(factory);
    expect(snapshot.authority).toMatchObject({ mode: "none", generation: "generation-0", revision: 2 });
    expect(snapshot.attempts.map((item) => item.attemptId).sort()).toEqual(["x-1", "x-2"]);
  });

  it("does not resolve a mutation at request success before transaction complete", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");

    const prototype = IDBObjectStore.prototype;
    const originalPut = prototype.put;
    let requestSucceededResolve = (): void => undefined;
    const requestSucceeded = new Promise<void>((resolve) => {
      requestSucceededResolve = resolve;
    });
    vi.spyOn(prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      const request = originalPut.apply(this, args);
      if (this.name === "attempts") request.addEventListener("success", requestSucceededResolve, { once: true });
      return request;
    });
    let resolved = false;
    const mutation = coordinator.putAttempt(attempt("request-complete", "generation-0")).then((value) => {
      resolved = true;
      return value;
    });

    await requestSucceeded;
    expect(resolved).toBe(false);
    await expect(mutation).resolves.toBeUndefined();
    expect(resolved).toBe(true);
    expect((await readCoordinatorSnapshot(factory)).attempts).toHaveLength(1);
  });

  it("does not deliver a committed transaction after pagehide advances the lifecycle generation", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");

    const prototype = IDBObjectStore.prototype;
    const originalPut = prototype.put;
    let requestSucceededResolve = (): void => undefined;
    const requestSucceeded = new Promise<void>((resolve) => {
      requestSucceededResolve = resolve;
    });
    vi.spyOn(prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      const request = originalPut.apply(this, args);
      if (this.name === "attempts") request.addEventListener("success", requestSucceededResolve, { once: true });
      return request;
    });

    const mutation = coordinator.putAttempt(attempt("pagehide-commit", "generation-0"));
    await requestSucceeded;
    closeCoordinatorConnections();

    await expect(mutation).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect((await readCoordinatorSnapshot(factory)).attempts.map((item) => item.attemptId)).toContain(
      "pagehide-commit",
    );
  });

  it("does not mutate authority when legacy cleanup was skipped or failed", async () => {
    const factory = new IDBFactory();
    const refusesRemoval: StorageArea = {
      length: 1,
      key: () => "first-tree:tokens",
      getItem: () => "plaintext-secret",
      removeItem: () => undefined,
    };
    const coordinator = new AuthSessionCoordinator({
      indexedDB: factory,
      legacyPersistence: {
        indexedDB: factory,
        localStorage: refusesRemoval,
        sessionStorage: memoryStorage(),
      },
    });
    await coordinator.bootstrapAnonymous("generation-0");
    const candidateAttempt = attempt("candidate-a", "generation-0");
    await coordinator.putAttempt(candidateAttempt);
    const before = await readCoordinatorSnapshot(factory);
    const target = activation("a", "generation-a");
    const targetCredential = await credential(target);
    const proof = await candidateProof(coordinator, candidateAttempt, targetCredential);

    await expect(
      coordinator.reserveAcquisitionTransition({ generation: "generation-0", revision: 1 }, proof, target, null),
    ).rejects.toMatchObject({ code: sessionErrorCodes.persistenceUnavailable });

    expect(await readCoordinatorSnapshot(factory)).toEqual(before);
  });

  it("cannot substitute a decoy scrub for the coordinator's captured persistence targets", async () => {
    const factory = new IDBFactory();
    const realStorage = memoryStorage({ "first-tree:tokens": "plaintext-secret" });
    const originalRemove = realStorage.removeItem;
    realStorage.removeItem = () => undefined;
    const coordinator = new AuthSessionCoordinator({
      indexedDB: factory,
      legacyPersistence: {
        indexedDB: factory,
        localStorage: realStorage,
        sessionStorage: memoryStorage(),
      },
    });
    await coordinator.bootstrapAnonymous("generation-bound-scrub");
    const candidateAttempt = attempt("candidate-bound-scrub", "generation-bound-scrub");
    await coordinator.putAttempt(candidateAttempt);
    const before = await readCoordinatorSnapshot(factory);
    const target = activation("bound-scrub", "generation-bound-scrub-target");
    const proof = await candidateProof(coordinator, candidateAttempt, await credential(target));
    await scrubLegacyPersistence({
      localStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
      indexedDB: new IDBFactory(),
    });

    await expect(
      coordinator.reserveAcquisitionTransition(
        { generation: before.authority.generation, revision: before.authority.revision },
        proof,
        target,
        null,
      ),
    ).rejects.toMatchObject({ code: sessionErrorCodes.persistenceUnavailable });
    expect(realStorage.getItem("first-tree:tokens")).toBe("plaintext-secret");
    expect(await readCoordinatorSnapshot(factory)).toEqual(before);
    realStorage.removeItem = originalRemove;
  });

  it("captures every legacy persistence target once before callers can swap getter results", async () => {
    const coordinatorFactory = new IDBFactory();
    const realLegacyFactory = new IDBFactory();
    const decoyLegacyFactory = new IDBFactory();
    const realLocalStorage = memoryStorage({ "first-tree:tokens": "real-local-secret" });
    const realSessionStorage = memoryStorage({ "first-tree:quickstart:agent": "real-session-secret" });
    const decoyLocalStorage = memoryStorage({ "first-tree:tokens": "decoy-local-secret" });
    const decoySessionStorage = memoryStorage({ "first-tree:quickstart:agent": "decoy-session-secret" });
    let selectedLocalStorage = realLocalStorage;
    let selectedSessionStorage = realSessionStorage;
    let selectedLegacyFactory = realLegacyFactory;
    const nestedReads = { localStorage: 0, sessionStorage: 0, indexedDB: 0 };
    const realLegacyPersistence = {
      get localStorage() {
        nestedReads.localStorage += 1;
        return selectedLocalStorage;
      },
      get sessionStorage() {
        nestedReads.sessionStorage += 1;
        return selectedSessionStorage;
      },
      get indexedDB() {
        nestedReads.indexedDB += 1;
        return selectedLegacyFactory;
      },
    };
    const decoyLegacyPersistence = {
      localStorage: decoyLocalStorage,
      sessionStorage: decoySessionStorage,
      indexedDB: decoyLegacyFactory,
    };
    let selectedLegacyPersistence = realLegacyPersistence;
    const optionReads = { indexedDB: 0, legacyPersistence: 0 };
    const coordinatorOptions = {
      get indexedDB() {
        optionReads.indexedDB += 1;
        return coordinatorFactory;
      },
      get legacyPersistence() {
        optionReads.legacyPersistence += 1;
        return selectedLegacyPersistence;
      },
    } satisfies CoordinatorOptions;
    const realDelete = vi.spyOn(realLegacyFactory, "deleteDatabase");
    const decoyDelete = vi.spyOn(decoyLegacyFactory, "deleteDatabase");
    const coordinator = new BaseAuthSessionCoordinator(coordinatorOptions);
    selectedLegacyPersistence = decoyLegacyPersistence;
    selectedLocalStorage = decoyLocalStorage;
    selectedSessionStorage = decoySessionStorage;
    selectedLegacyFactory = decoyLegacyFactory;

    const anonymous = await coordinator.bootstrapAnonymous("generation-captured-persistence");
    const cancellation = await coordinator.cancelAnonymousAuthority(
      anonymous,
      "generation-captured-persistence-cleaning",
    );
    if (cancellation.kind !== "cleaning") throw new Error("expected cleaning authority");
    await coordinator.completeAnonymousCleanup(cancellation.authority, "generation-captured-persistence-none");

    expect(optionReads).toEqual({ indexedDB: 1, legacyPersistence: 1 });
    expect(nestedReads).toEqual({ localStorage: 1, sessionStorage: 1, indexedDB: 1 });
    expect(realLocalStorage.getItem("first-tree:tokens")).toBeNull();
    expect(realSessionStorage.getItem("first-tree:quickstart:agent")).toBeNull();
    expect(decoyLocalStorage.getItem("first-tree:tokens")).toBe("decoy-local-secret");
    expect(decoySessionStorage.getItem("first-tree:quickstart:agent")).toBe("decoy-session-secret");
    expect(realDelete).toHaveBeenCalledWith("first-tree-chat-cache");
    expect(decoyDelete).not.toHaveBeenCalled();
  });

  it("consumes every incompatible attempt when auth generation rotates", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const candidateAttempt = attempt("x-1", "generation-0");
    await coordinator.putAttempt(candidateAttempt);
    await coordinator.putAttempt(attempt("x-2", "generation-0"));
    const next = activation("a", "generation-a");
    const nextCredential = await credential(next);
    const proof = await candidateProof(coordinator, candidateAttempt, nextCredential);
    const transition = await coordinator.reserveAcquisitionTransition(
      { generation: "generation-0", revision: 2 },
      proof,
      next,
      null,
    );
    await coordinator.completeAcquisitionTransition(transition, proof);

    const snapshot = await readCoordinatorSnapshot(factory);
    expect(snapshot.authority).toMatchObject({ mode: "active", generation: "generation-a" });
    expect(snapshot.attempts).toEqual([]);
  });

  it("keeps anonymous logout in durable cleaning until an exact verified scrub completes", async () => {
    const factory = new IDBFactory();
    const values = new Map([["first-tree:tokens", "plaintext-secret"]]);
    let removalAllowed = false;
    const localStorage: StorageArea = {
      get length() {
        return values.size;
      },
      key: (index) => [...values.keys()][index] ?? null,
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => {
        if (removalAllowed) values.delete(key);
      },
    };
    const coordinator = new AuthSessionCoordinator({
      indexedDB: factory,
      legacyPersistence: { indexedDB: factory, localStorage, sessionStorage: memoryStorage() },
    });
    const anonymous = await coordinator.bootstrapAnonymous("anonymous-cleaning-baseline");
    const pending = attempt("anonymous-cleaning-attempt", anonymous.generation);
    await coordinator.putAttempt(pending);
    const expected = await coordinator.readAuthority();
    const cancellation = await coordinator.cancelAnonymousAuthority(expected, "anonymous-cleaning-pending");
    expect(cancellation).toMatchObject({
      kind: "cleaning",
      authority: { mode: "cleaning", generation: "anonymous-cleaning-pending" },
    });
    expect(await readCoordinatorSnapshot(factory)).toMatchObject({
      authority: { mode: "cleaning" },
      attempts: [],
      credentials: [],
    });
    await expect(
      coordinator.putAttempt(attempt("blocked-during-cleaning", "anonymous-cleaning-pending")),
    ).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    await expect(
      coordinator.completeAnonymousCleanup(cancellation.authority, "anonymous-cleaning-terminal"),
    ).rejects.toMatchObject({ code: sessionErrorCodes.persistenceUnavailable });
    expect(await coordinator.readAuthority()).toEqual(cancellation.authority);

    removalAllowed = true;
    const cleaningSnapshot = await readCoordinatorSnapshot(factory);
    for (const forbiddenGeneration of ["anonymous-cleaning-baseline", "anonymous-cleaning-pending"]) {
      await expect(
        coordinator.completeAnonymousCleanup(cancellation.authority, forbiddenGeneration),
      ).rejects.toMatchObject({ code: sessionErrorCodes.invalidState });
      expect(await readCoordinatorSnapshot(factory)).toEqual(cleaningSnapshot);
    }
    await coordinator.completeAnonymousCleanup(cancellation.authority, "anonymous-cleaning-terminal");
    expect(localStorage.getItem("first-tree:tokens")).toBeNull();
    expect(await coordinator.readAuthority()).toMatchObject({
      mode: "none",
      generation: "anonymous-cleaning-terminal",
    });
    await expect(
      coordinator.completeAnonymousCleanup(cancellation.authority, "anonymous-cleaning-replay"),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });
    await expect(
      coordinator.putAttempt(attempt("anonymous-cleaning-stale-baseline", "anonymous-cleaning-baseline")),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });
  });

  it("cannot use a stale cleaning authority to finalize a later cleaning generation", async () => {
    const factory = new IDBFactory();
    const first = new AuthSessionCoordinator({ indexedDB: factory });
    const second = new AuthSessionCoordinator({ indexedDB: factory });
    const anonymous = await first.bootstrapAnonymous("anonymous-cleaning-race-baseline");
    const cancellation = await first.cancelAnonymousAuthority(anonymous, "anonymous-cleaning-race-one");
    if (cancellation.kind !== "cleaning") throw new Error("expected cleaning authority");

    await second.completeAnonymousCleanup(cancellation.authority, "anonymous-cleaning-race-winner");

    await expect(
      first.completeAnonymousCleanup(cancellation.authority, "anonymous-cleaning-race-late"),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });
    const winner = await first.readAuthority();
    expect(winner).toMatchObject({ mode: "none", generation: "anonymous-cleaning-race-winner" });

    const nextAttempt = attempt("anonymous-cleaning-bound-downgrade", winner.generation);
    await first.putAttempt(nextAttempt);
    const nextCancellation = await first.cancelAnonymousAuthority(winner, "anonymous-cleaning-race-two");
    if (nextCancellation.kind !== "cleaning") throw new Error("expected next cleaning authority");
    await expect(
      first.completeAnonymousCleanup(cancellation.authority, "anonymous-cleaning-race-replay"),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });
    expect(await first.readAuthority()).toEqual(nextCancellation.authority);

    await first.completeAnonymousCleanup(nextCancellation.authority, "anonymous-cleaning-race-terminal");
    expect(await first.readAuthority()).toMatchObject({
      mode: "none",
      generation: "anonymous-cleaning-race-terminal",
    });
  });

  it("lets explicit logout cancel attempts added on the same anonymous generation", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    const captured = await coordinator.bootstrapAnonymous("anonymous-cancel-stale");
    const newerAttempt = attempt("anonymous-cancel-newer-attempt", captured.generation);
    await coordinator.putAttempt(newerAttempt);
    await expect(coordinator.cancelAnonymousAuthority(captured, "anonymous-cancel-wins")).resolves.toMatchObject({
      kind: "cleaning",
      authority: { mode: "cleaning", generation: "anonymous-cancel-wins" },
    });
    expect(await readCoordinatorSnapshot(factory)).toMatchObject({
      authority: { mode: "cleaning", generation: "anonymous-cancel-wins" },
      attempts: [],
      credentials: [],
    });
  });

  it("binds transition completion to exact verified token bytes and permits a fresh exact proof", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const candidateAttempt = attempt("proof-bound", "generation-0");
    await coordinator.putAttempt(candidateAttempt);
    const target = activation("a", "generation-a");
    const firstCredential = await credential(target, 0, "pair-one");
    const firstProof = await candidateProof(coordinator, candidateAttempt, firstCredential);
    const transition = await coordinator.reserveAcquisitionTransition(
      { generation: "generation-0", revision: 1 },
      firstProof,
      target,
      null,
    );

    const secondCredential = await credential(target, 0, "pair-two");
    await expect(candidateProof(coordinator, candidateAttempt, secondCredential)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    await expect(
      coordinator.completeAcquisitionTransition(transition, Object.freeze({}) as VerifiedCandidateProof),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });

    const recoveryProof = await candidateProof(coordinator, candidateAttempt, firstCredential);
    await coordinator.completeAcquisitionTransition(transition, recoveryProof);
    await expect(coordinator.admitActivation(target)).resolves.toMatchObject({
      credential: { credentialFingerprint: firstCredential.credentialFingerprint },
    });
    await expect(coordinator.completeAcquisitionTransition(transition, recoveryProof)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    const beforeLateCancel = await readCoordinatorSnapshot(factory);
    await expect(coordinator.cancelAcquisitionTransition(transition, "generation-late-cancel")).resolves.toMatchObject({
      kind: "superseded",
    });
    expect(await readCoordinatorSnapshot(factory)).toEqual(beforeLateCancel);
  });

  it("rejects candidate proofs after their original lifecycle is invalidated", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const candidateAttempt = attempt("lifecycle-bound", "generation-0");
    await coordinator.putAttempt(candidateAttempt);
    const target = activation("a", "generation-a");
    const targetCredential = await credential(target);
    const controller = new AbortController();
    const proof = await candidateProof(coordinator, candidateAttempt, targetCredential, controller.signal);
    controller.abort();
    await expect(
      coordinator.reserveAcquisitionTransition({ generation: "generation-0", revision: 1 }, proof, target, null),
    ).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    await expect(coordinator.readAuthority()).resolves.toMatchObject({ mode: "none", revision: 1 });

    const secondController = new AbortController();
    const secondProof = await candidateProof(coordinator, candidateAttempt, targetCredential, secondController.signal);
    closeCoordinatorConnections();
    await expect(
      coordinator.reserveAcquisitionTransition({ generation: "generation-0", revision: 1 }, secondProof, target, null),
    ).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
  });

  it("snapshots the original candidate signal across request settlement", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const candidateAttempt = attempt("signal-snapshot", "generation-0");
    await coordinator.putAttempt(candidateAttempt);
    const target = activation("a", "generation-a");
    const targetCredential = await credential(target);
    const originalController = new AbortController();
    const replacementController = new AbortController();
    let markStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let resolveRequest = (_response: Response): void => undefined;
    const fetchMock = vi.fn(
      (_url: string, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
          markStarted();
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const mutableInput = {
      candidate: targetCredential,
      attempt: candidateAttempt,
      serverAuthority: target.serverAuthority,
      signal: originalController.signal,
    };

    const verification = coordinator.requestCandidateMe(mutableInput);
    await started;
    mutableInput.signal = replacementController.signal;
    originalController.abort();
    resolveRequest(jsonResponse({ user: { id: target.accountId } }));

    await expect(verification).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(originalController.signal);
    await expect(coordinator.readAuthority()).resolves.toMatchObject({ mode: "none", revision: 1 });
  });

  it("cannot mint a coordinator proof from caller-shaped dispatch callbacks", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const candidateAttempt = attempt("forged-dispatch", "generation-0");
    await coordinator.putAttempt(candidateAttempt);
    const target = activation("a", "generation-a");
    const targetCredential = await credential(target);
    const forgedDispatch = vi.fn(async () => jsonResponse({ user: { id: target.accountId } }));
    const fetchMock = vi.fn(async () => {
      throw new Error("owned candidate fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const attackerShapedInput = {
      candidate: targetCredential,
      attempt: candidateAttempt,
      serverAuthority: target.serverAuthority,
      signal: new AbortController().signal,
      dispatch: forgedDispatch,
      assertResponseCurrent: vi.fn(),
    };

    await expect(coordinator.requestCandidateMe(attackerShapedInput)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(forgedDispatch).not.toHaveBeenCalled();
    await expect(coordinator.readAuthority()).resolves.toMatchObject({ mode: "none", revision: 1 });
  });

  it("recovers when reservation commits but pagehide loses its result", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const candidateAttempt = attempt("ambiguous-reserve", "generation-0");
    await coordinator.putAttempt(candidateAttempt);
    const target = activation("a", "generation-a");
    const targetCredential = await credential(target);
    const proof = await candidateProof(coordinator, candidateAttempt, targetCredential);
    const prototype = IDBObjectStore.prototype;
    const originalPut = prototype.put;
    let transitionWriteResolve = (): void => undefined;
    const transitionWrite = new Promise<void>((resolve) => {
      transitionWriteResolve = resolve;
    });
    const putSpy = vi.spyOn(prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      const request = originalPut.apply(this, args);
      const value = args[0] as { authority?: { mode?: string } };
      if (this.name === "authority" && value.authority?.mode === "transition") {
        request.addEventListener("success", transitionWriteResolve, { once: true });
      }
      return request;
    });

    const reservation = coordinator.reserveAcquisitionTransition(
      { generation: "generation-0", revision: 1 },
      proof,
      target,
      null,
    );
    await transitionWrite;
    closeCoordinatorConnections();
    await expect(reservation).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    putSpy.mockRestore();

    const reloaded = new AuthSessionCoordinator({ indexedDB: factory });
    const persisted = await reloaded.readAuthority();
    expect(persisted).toMatchObject({ mode: "transition", generation: "generation-a" });
    if (persisted.mode !== "transition") throw new Error("expected committed transition fixture");
    const cancellation = await reloaded.cancelAcquisitionTransition(persisted.permit, "generation-recovered");
    expect(cancellation).toMatchObject({ kind: "cleaning", authority: { mode: "cleaning" } });
    if (cancellation.kind !== "cleaning") throw new Error("expected source-free cleaning authority");
    const cleaningSnapshot = await readCoordinatorSnapshot(factory);
    for (const forbiddenGeneration of ["generation-0", "generation-a", "generation-recovered"]) {
      await expect(
        reloaded.completeAnonymousCleanup(cancellation.authority, forbiddenGeneration),
      ).rejects.toMatchObject({ code: sessionErrorCodes.invalidState });
      expect(await readCoordinatorSnapshot(factory)).toEqual(cleaningSnapshot);
    }
    await reloaded.completeAnonymousCleanup(cancellation.authority, "generation-recovered-none");

    const nextAttempt = attempt("after-ambiguous-reserve", "generation-recovered-none");
    await reloaded.putAttempt(nextAttempt);
    const nextTarget = activation("b", "generation-b");
    const nextProof = await candidateProof(reloaded, nextAttempt, await credential(nextTarget));
    const cursor = await reloaded.readAuthority();
    await expect(
      reloaded.reserveAcquisitionTransition(
        { generation: cursor.generation, revision: cursor.revision },
        nextProof,
        nextTarget,
        null,
      ),
    ).resolves.toMatchObject({ target: nextTarget });
  });

  it("cancels an anonymous transition after proof loss or expiry and preserves a later authority", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const candidateAttempt = attempt("anonymous-recovery", "generation-0");
    await coordinator.putAttempt(candidateAttempt);
    const target = activation("a", "generation-a");
    const targetCredential = await credential(target);
    const controller = new AbortController();
    const proof = await candidateProof(coordinator, candidateAttempt, targetCredential, controller.signal);
    const permit = await coordinator.reserveAcquisitionTransition(
      { generation: "generation-0", revision: 1 },
      proof,
      target,
      null,
    );
    const expiryProof = await candidateProof(coordinator, candidateAttempt, targetCredential);
    await expect(
      coordinator.completeAcquisitionTransition(permit, expiryProof, undefined, permit.expiresAt + 1),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });

    const originalCrypto = globalThis.crypto;
    let digestStartedResolve = (): void => undefined;
    let releaseDigestResolve = (): void => undefined;
    const digestStarted = new Promise<void>((resolve) => {
      digestStartedResolve = resolve;
    });
    const releaseDigest = new Promise<void>((resolve) => {
      releaseDigestResolve = resolve;
    });
    vi.stubGlobal("crypto", {
      ...originalCrypto,
      randomUUID: originalCrypto.randomUUID.bind(originalCrypto),
      subtle: {
        digest: async (...args: Parameters<SubtleCrypto["digest"]>) => {
          digestStartedResolve();
          await releaseDigest;
          return originalCrypto.subtle.digest(...args);
        },
      },
    } as Crypto);
    const lateCompletion = coordinator.completeAcquisitionTransition(permit, proof);
    await digestStarted;
    closeCoordinatorConnections();
    releaseDigestResolve();
    await expect(lateCompletion).rejects.toMatchObject({
      code: sessionErrorCodes.staleOperation,
    });

    const reloaded = new AuthSessionCoordinator({ indexedDB: factory });
    await expect(reloaded.cancelAcquisitionTransition(permit, "generation-recovered")).resolves.toMatchObject({
      kind: "cleaning",
      authority: { mode: "cleaning", generation: "generation-recovered" },
    });
    const recovered = await readCoordinatorSnapshot(factory);
    expect(recovered.credentials).toEqual([]);
    expect(recovered.attempts).toEqual([]);
    await reloaded.completeAnonymousCleanup(recovered.authority, "generation-recovered-none");

    const next = activation("b", "generation-b");
    await activateAnonymous(factory, reloaded, next, "attempt-b");
    const beforeLateCancel = await readCoordinatorSnapshot(factory);
    await expect(reloaded.cancelAcquisitionTransition(permit, "generation-late")).resolves.toMatchObject({
      kind: "superseded",
    });
    expect(await readCoordinatorSnapshot(factory)).toEqual(beforeLateCancel);
  });

  it("converts source transitions into recoverable retirement before and after purge", async () => {
    for (const purgeBeforeCancel of [false, true]) {
      const factory = new IDBFactory();
      const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
      await coordinator.bootstrapAnonymous("generation-0");
      const source = activation(`source-${purgeBeforeCancel}`, `generation-source-${purgeBeforeCancel}`);
      await activateAnonymous(factory, coordinator, source, `source-attempt-${purgeBeforeCancel}`);
      const target = activation(`target-${purgeBeforeCancel}`, `generation-target-${purgeBeforeCancel}`);
      const targetAttempt = attempt(`target-attempt-${purgeBeforeCancel}`, source.authGeneration, source.sessionEpoch);
      await coordinator.putAttempt(targetAttempt);
      const targetCredential = await credential(target);
      const proof = await candidateProof(coordinator, targetAttempt, targetCredential);
      const before = await coordinator.readAuthority();
      const permit = await coordinator.reserveAcquisitionTransition(
        { generation: before.generation, revision: before.revision },
        proof,
        target,
        source,
      );
      await expect(coordinator.putAttempt(attempt("blocked-transition", target.authGeneration))).rejects.toMatchObject({
        code: sessionErrorCodes.admissionDenied,
      });
      await expect(coordinator.deleteAttempt(targetAttempt.attemptId)).rejects.toMatchObject({
        code: sessionErrorCodes.admissionDenied,
      });
      const receipt = purgeBeforeCancel ? await purge(factory, coordinator, source) : undefined;
      closeCoordinatorConnections();
      const recovering = new AuthSessionCoordinator({ indexedDB: factory });
      const cancelled = await recovering.cancelAcquisitionTransition(
        permit,
        `generation-cancelled-${purgeBeforeCancel}`,
      );
      expect(cancelled).toMatchObject({
        kind: "retiring",
        authority: {
          mode: "retiring",
          cause: "transition_cancelled",
          phase: purgeBeforeCancel ? "source_purged" : "revoked",
        },
      });
      if (receipt !== undefined && cancelled.kind === "retiring") {
        expect(cancelled.authority).toMatchObject({ cleanupReceipt: receipt });
      }
      await expect(recovering.completeAcquisitionTransition(permit, proof, receipt)).rejects.toMatchObject({
        code: sessionErrorCodes.staleOperation,
      });
      await expect(
        recovering.putAttempt(attempt("blocked", `generation-cancelled-${purgeBeforeCancel}`)),
      ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });
      await expect(recovering.deleteAttempt(targetAttempt.attemptId)).rejects.toMatchObject({
        code: sessionErrorCodes.admissionDenied,
      });

      const finalReceipt = receipt ?? (await purge(factory, recovering, source));
      if (cancelled.kind !== "retiring") throw new Error("expected source retirement");
      const retiringSnapshot = await readCoordinatorSnapshot(factory);
      for (const forbiddenGeneration of [
        source.authGeneration,
        target.authGeneration,
        cancelled.authority.generation,
      ]) {
        await expect(recovering.completeRetirement(source, finalReceipt, forbiddenGeneration)).rejects.toMatchObject({
          code: sessionErrorCodes.invalidState,
        });
        expect(await readCoordinatorSnapshot(factory)).toEqual(retiringSnapshot);
      }
      await recovering.completeRetirement(source, finalReceipt, `generation-none-${purgeBeforeCancel}`);
      await expect(recovering.readAuthority()).resolves.toMatchObject({
        mode: "none",
        generation: `generation-none-${purgeBeforeCancel}`,
      });
    }
  });

  it("keeps a directly retired source transition from finalizing as its target generation", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-direct-baseline");
    const source = activation("direct-source", "generation-direct-source");
    await activateAnonymous(factory, coordinator, source, "direct-source-attempt");
    const target = activation("direct-target", "generation-direct-target");
    const targetAttempt = attempt("direct-target-attempt", source.authGeneration, source.sessionEpoch);
    await coordinator.putAttempt(targetAttempt);
    const targetProof = await candidateProof(coordinator, targetAttempt, await credential(target));
    const before = await coordinator.readAuthority();
    await coordinator.reserveAcquisitionTransition(
      { generation: before.generation, revision: before.revision },
      targetProof,
      target,
      source,
    );

    await expect(coordinator.beginRetirement(source, "logout", "generation-direct-retiring")).resolves.toBe("retired");
    const receipt = await purge(factory, coordinator, source);
    const retiringSnapshot = await readCoordinatorSnapshot(factory);
    for (const forbiddenGeneration of [source.authGeneration, target.authGeneration, "generation-direct-retiring"]) {
      await expect(coordinator.completeRetirement(source, receipt, forbiddenGeneration)).rejects.toMatchObject({
        code: sessionErrorCodes.invalidState,
      });
      expect(await readCoordinatorSnapshot(factory)).toEqual(retiringSnapshot);
    }

    await coordinator.completeRetirement(source, receipt, "generation-direct-none");
    await expect(coordinator.readAuthority()).resolves.toMatchObject({
      mode: "none",
      generation: "generation-direct-none",
    });
  });

  it("rejects a verified proof whose mapped attempt payload differs from stored X", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const storedAttempt = attempt("mapped-attempt", "generation-0");
    await coordinator.putAttempt(storedAttempt);
    const remapped = createSessionAttempt({
      ...storedAttempt,
      kind: "acquisition",
      payload: { mappedTab: "attacker-tab", returnTabId: "attacker-return" },
    });
    if (remapped.kind !== "acquisition") throw new Error("expected acquisition attempt fixture");
    const target = activation("a", "generation-a");
    const targetCredential = await credential(target);
    await expect(candidateProof(coordinator, remapped, targetCredential)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    await expect(coordinator.readAuthority()).resolves.toMatchObject({ mode: "none", revision: 1 });
  });

  it("linearizes retirement before purge and preserves a newer activation from a late logout", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const departing = activation("a", "generation-a");
    await activateAnonymous(factory, coordinator, departing, "attempt-a");

    await expect(coordinator.beginRetirement(departing, "logout", "generation-1")).resolves.toBe("retired");
    await expect(coordinator.admitActivation(departing)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    const receipt = await purge(factory, coordinator, departing);
    await expect(purge(factory, coordinator, departing)).resolves.toBe(receipt);
    await coordinator.completeRetirement(departing, receipt, "generation-2");

    const next = activation("b", "generation-b");
    await activateAnonymous(factory, coordinator, next, "attempt-b");
    const beforeLateLogout = await readCoordinatorSnapshot(factory);

    await expect(coordinator.beginRetirement(departing, "logout", "generation-stale")).resolves.toBe("superseded");
    expect(await readCoordinatorSnapshot(factory)).toEqual(beforeLateLogout);
    await expect(coordinator.admitActivation(next)).resolves.toMatchObject({
      credential: { credentialFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u) },
    });
  });

  it("reserves account replacement without persisting target credentials before source purge", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const departing = activation("a", "generation-a");
    await activateAnonymous(factory, coordinator, departing, "attempt-a");

    const target = activation("b", "generation-b");
    const targetCredential = await credential(target);
    const targetAttempt = attempt("attempt-b", "generation-a", departing.sessionEpoch);
    await coordinator.putAttempt(targetAttempt);
    const beforeReservation = await coordinator.readAuthority();
    const proof = await candidateProof(coordinator, targetAttempt, targetCredential);
    const targetPermit = await coordinator.reserveAcquisitionTransition(
      { generation: beforeReservation.generation, revision: beforeReservation.revision },
      proof,
      target,
      departing,
    );

    const reserved = await readCoordinatorSnapshot(factory);
    expect(reserved.authority).toMatchObject({
      mode: "transition",
      source: departing,
      phase: "revoked",
      permit: targetPermit,
    });
    expect(reserved.credentials).toEqual([]);
    await expect(coordinator.admitActivation(departing)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });

    const receipt = await purge(factory, coordinator, departing);
    await coordinator.completeAcquisitionTransition(targetPermit, proof, receipt);
    await expect(coordinator.admitActivation(target)).resolves.toMatchObject({
      credential: { credentialFingerprint: targetCredential.credentialFingerprint },
    });
    await expect(coordinator.beginRetirement(departing, "logout", "generation-late")).resolves.toBe("superseded");
  });

  it("keeps activation and view leases stable across an exact credential refresh CAS", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const certificate = activation("a", "generation-a");
    await activateAnonymous(factory, coordinator, certificate, "attempt-a");
    const controller = new AbortController();
    const view = createViewLease({
      activation: certificate,
      organizationId: "org-a",
      orgRevision: "org-revision-a",
      ownerTabId: "owner-tab-a",
      documentId: "document-a",
      signal: controller.signal,
    });
    expect(view.ownerTabId).toBe("owner-tab-a");
    const before = await coordinator.readActiveSession();
    const replacement = await credential(certificate, 1, "rotated-a");
    const original = await credential(certificate);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: original.refreshToken });
      return jsonResponse({ accessToken: replacement.accessToken, refreshToken: replacement.refreshToken });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(coordinator.refreshActiveCredential(view, before.credential)).resolves.toEqual({
      sessionEpoch: certificate.sessionEpoch,
      credentialRevision: 1,
      credentialFingerprint: replacement.credentialFingerprint,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const after = await coordinator.admitView(view);
    expect(after.authority.session).toEqual(certificate);
    expect(after.credential).toMatchObject({
      credentialRevision: 1,
      credentialFingerprint: replacement.credentialFingerprint,
    });
    fetchMock.mockClear();
    await expect(coordinator.refreshActiveCredential(view, before.credential)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired access credential only through the exact installed account runtime", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const certificate = activation("account-refresh", "generation-account-refresh");
    await activateAnonymous(factory, coordinator, certificate, "attempt-account-refresh");
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const expired = await credential(certificate, 0, "expired-account-refresh", {
      access: nowSeconds - 60,
      refresh: nowSeconds + 3_600,
    });
    await replaceCoordinatorSnapshotForTest(factory, (snapshot) => ({ ...snapshot, credentials: [expired] }));
    const before = await coordinator.readActiveSession();
    const replacement = await credential(certificate, 1, "rotated-account-refresh");
    const controller = new AbortController();
    const lease = createAccountLease({
      activation: certificate,
      accountRevision: "account-revision-refresh",
      ownerTabId: "owner-tab-refresh",
      documentId: "document-refresh",
      signal: controller.signal,
    });
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const disposeRuntime = installAccountStoreRuntime({ barrier, lease });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).not.toHaveProperty("Authorization");
      expect(init?.headers).not.toHaveProperty("Cookie");
      expect(init?.headers).toMatchObject({ "X-First-Tree-Expected-Authority": SERVER_AUTHORITY });
      expect(init?.credentials).toBe("omit");
      expect(init?.signal).not.toBe(controller.signal);
      expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: expired.refreshToken });
      return jsonResponse({ accessToken: replacement.accessToken, refreshToken: replacement.refreshToken });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      coordinator.refreshAccountCredential(lease, before.credential, "owned-401-account-refresh"),
    ).resolves.toEqual({
      sessionEpoch: certificate.sessionEpoch,
      credentialRevision: 1,
      credentialFingerprint: replacement.credentialFingerprint,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/refresh",
      expect.objectContaining({ method: "POST", cache: "no-store", redirect: "error" }),
    );
    await expect(coordinator.admitAccountLease(lease)).resolves.toMatchObject({
      credential: {
        credentialRevision: 1,
        credentialFingerprint: replacement.credentialFingerprint,
      },
    });
    fetchMock.mockClear();
    await expect(
      coordinator.refreshAccountCredential(lease, before.credential, "owned-401-account-refresh-stale"),
    ).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    disposeRuntime();
  });

  it.each([
    ["network", () => Promise.reject(new Error("unavailable"))],
    ["401", async () => new Response("unauthorized", { status: 401 })],
    ["malformed", async () => new Response("not-json", { headers: { "Content-Type": "application/json" } })],
  ])("does not commit an account refresh after a %s response", async (label, responseFactory) => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous(`baseline-account-refresh-${label}`);
    const certificate = activation(`account-refresh-${label}`, `generation-account-refresh-${label}`);
    await activateAnonymous(factory, coordinator, certificate, `attempt-account-refresh-${label}`);
    const before = await coordinator.readActiveSession();
    const lease = createAccountLease({
      activation: certificate,
      accountRevision: `account-revision-refresh-${label}`,
      ownerTabId: `owner-tab-refresh-${label}`,
      documentId: `document-refresh-${label}`,
      signal: new AbortController().signal,
    });
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const disposeRuntime = installAccountStoreRuntime({ barrier, lease });
    vi.stubGlobal("fetch", vi.fn(responseFactory));

    await expect(
      coordinator.refreshAccountCredential(lease, before.credential, `owned-401-account-${label}`),
    ).rejects.toMatchObject(
      label === "401"
        ? {
            code: sessionErrorCodes.admissionDenied,
            detail: { kind: "refresh_http_status", status: 401, retirement: "retired" },
          }
        : { code: sessionErrorCodes.admissionDenied },
    );
    if (label === "401") {
      await expect(coordinator.readAuthority()).resolves.toMatchObject({
        mode: "retiring",
        source: certificate,
        cause: "owned_401",
        phase: "revoked",
      });
    } else {
      expect((await coordinator.readActiveSession()).credential).toEqual(before.credential);
    }
    disposeRuntime();
  });

  it("does not commit a pending account refresh after its original lifecycle aborts", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("baseline-account-refresh-abort");
    const certificate = activation("account-refresh-abort", "generation-account-refresh-abort");
    await activateAnonymous(factory, coordinator, certificate, "attempt-account-refresh-abort");
    const before = await coordinator.readActiveSession();
    const controller = new AbortController();
    const lease = createAccountLease({
      activation: certificate,
      accountRevision: "account-revision-refresh-abort",
      ownerTabId: "owner-tab-refresh-abort",
      documentId: "document-refresh-abort",
      signal: controller.signal,
    });
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const disposeRuntime = installAccountStoreRuntime({ barrier, lease });
    let startedResolve = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            startedResolve();
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
              once: true,
            });
          }),
      ),
    );

    const refresh = coordinator.refreshAccountCredential(lease, before.credential, "owned-401-account-abort");
    await started;
    controller.abort();
    await expect(refresh).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect((await coordinator.readActiveSession()).credential).toEqual(before.credential);
    disposeRuntime();
  });

  it("drops an account refresh response when its exact runtime is replaced", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("baseline-account-refresh-replaced");
    const certificate = activation("account-refresh-replaced", "generation-account-refresh-replaced");
    await activateAnonymous(factory, coordinator, certificate, "attempt-account-refresh-replaced");
    const before = await coordinator.readActiveSession();
    const replacement = await credential(certificate, 1, "rotated-account-refresh-replaced");
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const firstController = new AbortController();
    const firstLease = createAccountLease({
      activation: certificate,
      accountRevision: "account-revision-refresh-first",
      ownerTabId: "owner-tab-refresh-replaced",
      documentId: "document-refresh-replaced",
      signal: firstController.signal,
    });
    const disposeFirst = installAccountStoreRuntime({ barrier, lease: firstLease });
    let resolveResponse = (_response: Response): void => undefined;
    let requestStartedResolve = (): void => undefined;
    const requestStarted = new Promise<void>((resolve) => {
      requestStartedResolve = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve;
            requestStartedResolve();
          }),
      ),
    );

    const refresh = coordinator.refreshAccountCredential(firstLease, before.credential, "owned-401-account-replaced");
    await requestStarted;
    const secondLease = createAccountLease({
      ...firstLease,
      accountRevision: "account-revision-refresh-second",
      signal: new AbortController().signal,
    });
    const disposeSecond = installAccountStoreRuntime({ barrier, lease: secondLease });
    resolveResponse(jsonResponse({ accessToken: replacement.accessToken, refreshToken: replacement.refreshToken }));

    await expect(refresh).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect((await coordinator.readActiveSession()).credential).toEqual(before.credential);
    disposeSecond();
    disposeFirst();
  });

  it.each([
    ["wrong subject", () => credential(activation("other-account", "other"), 1)],
    [
      "wrong token type",
      async (certificate: ActivationCertificate) => ({
        accessToken: jwt(certificate.accountId, "refresh", "wrong-access-kind"),
        refreshToken: jwt(certificate.accountId, "refresh", "refresh-kind"),
      }),
    ],
    [
      "expired pair",
      async (certificate: ActivationCertificate) => {
        const expiredAt = Math.floor(Date.now() / 1_000) - 60;
        return {
          accessToken: jwt(certificate.accountId, "access", "expired-access", expiredAt),
          refreshToken: jwt(certificate.accountId, "refresh", "expired-refresh", expiredAt),
        };
      },
    ],
  ])("rejects an account refresh response with a %s", async (label, replacementFactory) => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous(`baseline-account-invalid-${label}`);
    const certificate = activation(`account-invalid-${label}`, `generation-account-invalid-${label}`);
    await activateAnonymous(factory, coordinator, certificate, `attempt-account-invalid-${label}`);
    const before = await coordinator.readActiveSession();
    const replacement = await replacementFactory(certificate);
    const lease = createAccountLease({
      activation: certificate,
      accountRevision: `account-revision-invalid-${label}`,
      ownerTabId: `owner-tab-invalid-${label}`,
      documentId: `document-invalid-${label}`,
      signal: new AbortController().signal,
    });
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const disposeRuntime = installAccountStoreRuntime({ barrier, lease });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ accessToken: replacement.accessToken, refreshToken: replacement.refreshToken })),
    );

    await expect(
      coordinator.refreshAccountCredential(lease, before.credential, `owned-401-account-invalid-${label}`),
    ).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    expect((await coordinator.readActiveSession()).credential).toEqual(before.credential);
    disposeRuntime();
  });

  it("drops a refresh replacement when its exact view aborts during credential hashing", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const certificate = activation("a", "generation-a");
    await activateAnonymous(factory, coordinator, certificate, "attempt-a");
    const controller = new AbortController();
    const view = createViewLease({
      activation: certificate,
      organizationId: "org-a",
      orgRevision: "org-revision-a",
      ownerTabId: "owner-tab-a",
      documentId: "document-a",
      signal: controller.signal,
    });
    const before = await coordinator.readActiveSession();
    const replacement = await credential(certificate, 1, "late-refresh");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ accessToken: replacement.accessToken, refreshToken: replacement.refreshToken })),
    );
    const originalCrypto = globalThis.crypto;
    let digestStartedResolve = (): void => undefined;
    let releaseDigestResolve = (): void => undefined;
    const digestStarted = new Promise<void>((resolve) => {
      digestStartedResolve = resolve;
    });
    const releaseDigest = new Promise<void>((resolve) => {
      releaseDigestResolve = resolve;
    });
    let digestCalls = 0;
    vi.stubGlobal("crypto", {
      ...originalCrypto,
      randomUUID: originalCrypto.randomUUID.bind(originalCrypto),
      subtle: {
        digest: async (...args: Parameters<SubtleCrypto["digest"]>) => {
          digestCalls += 1;
          if (digestCalls === 2) {
            digestStartedResolve();
            await releaseDigest;
          }
          return originalCrypto.subtle.digest(...args);
        },
      },
    } as Crypto);

    const update = coordinator.refreshActiveCredential(view, before.credential);
    await digestStarted;
    controller.abort();
    releaseDigestResolve();
    await expect(update).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect((await coordinator.readActiveSession()).credential).toEqual(before.credential);
  });

  it("does not let a copied access admission or replacement signal cross capability domains", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const certificate = activation("a", "generation-a");
    await activateAnonymous(factory, coordinator, certificate, "attempt-a");
    const controller = new AbortController();
    const view = createViewLease({
      activation: certificate,
      organizationId: "org-a",
      orgRevision: "org-revision-a",
      ownerTabId: "owner-tab-a",
      documentId: "document-a",
      signal: controller.signal,
    });
    const before = await coordinator.readActiveSession();
    const access = await coordinator.startActiveDispatch(view, before.credential, "access", () => Promise.resolve(401));
    const copied = { ...access.admission, tokenKind: "refresh" };
    await expect(coordinator.beginOwned401Retirement(copied, view, "generation-copied")).rejects.toMatchObject({
      code: sessionErrorCodes.invalidState,
    });

    const replacementView = createViewLease({ ...view, signal: new AbortController().signal });
    controller.abort();
    await expect(coordinator.assertActiveDispatchResponse(access.admission, replacementView)).rejects.toMatchObject({
      code: sessionErrorCodes.staleOperation,
    });
    expect((await coordinator.readActiveSession()).credential).toEqual(before.credential);
  });

  it.each([
    ["network", () => Promise.reject(new Error("secret refresh failure"))],
    ["401", async () => new Response("unauthorized", { status: 401 })],
    ["malformed", async () => new Response("not-json", { headers: { "Content-Type": "application/json" } })],
    ["missing refresh token", async () => jsonResponse({ accessToken: "not-used" })],
  ])("does not replace credentials after a %s refresh outcome", async (_label, responseFactory) => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const certificate = activation("a", "generation-a");
    await activateAnonymous(factory, coordinator, certificate, "attempt-a");
    const view = createViewLease({
      activation: certificate,
      organizationId: "org-a",
      orgRevision: "org-revision-a",
      ownerTabId: "owner-tab-a",
      documentId: "document-a",
      signal: new AbortController().signal,
    });
    const before = await coordinator.readActiveSession();
    vi.stubGlobal("fetch", vi.fn(responseFactory));

    await expect(coordinator.refreshActiveCredential(view, before.credential)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    expect((await coordinator.readActiveSession()).credential).toEqual(before.credential);
  });

  it("keeps the current credential unchanged while a refresh is pending and after it is aborted", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const certificate = activation("a", "generation-a");
    await activateAnonymous(factory, coordinator, certificate, "attempt-a");
    const controller = new AbortController();
    const view = createViewLease({
      activation: certificate,
      organizationId: "org-a",
      orgRevision: "org-revision-a",
      ownerTabId: "owner-tab-a",
      documentId: "document-a",
      signal: controller.signal,
    });
    const before = await coordinator.readActiveSession();
    let startedResolve = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            startedResolve();
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
              once: true,
            });
          }),
      ),
    );

    const refresh = coordinator.refreshActiveCredential(view, before.credential);
    await started;
    expect((await coordinator.readActiveSession()).credential).toEqual(before.credential);
    controller.abort();
    await expect(refresh).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect((await coordinator.readActiveSession()).credential).toEqual(before.credential);
  });

  it("keeps acquisition and management attempts and permits in separate domains", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const managementAttempt = createSessionAttempt({
      attemptId: "management-x",
      kind: "management",
      flowKind: "identity-link",
      serverAuthority: SERVER_AUTHORITY,
      baselineGeneration: "generation-0",
      sourceEpoch: null,
      expiresAt: Date.now() + 60_000,
      payload: { ownerTabId: "tab-a" },
    });
    await coordinator.putAttempt(managementAttempt);
    const target = activation("target", "generation-target");
    const targetCredential = await credential(target);

    await expect(
      coordinator.requestCandidateMe({
        candidate: targetCredential,
        attempt: managementAttempt as unknown as AcquisitionSessionAttempt,
        serverAuthority: SERVER_AUTHORITY,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });

    await expect(
      coordinator.reserveAcquisitionTransition(
        { generation: "generation-0", revision: 1 },
        Object.freeze({}) as VerifiedCandidateProof,
        target,
        null,
      ),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });

    const managementPermit = createManagementDeliveryPermit({
      kind: "management_delivery",
      permitId: "management-permit",
      attemptId: managementAttempt.attemptId,
      serverAuthority: SERVER_AUTHORITY,
      sourceEpoch: "source-epoch",
      accountId: "account-a",
      organizationId: "org-a",
      ownerTabId: "tab-a",
      expiresAt: Date.now() + 60_000,
    });
    await expect(
      coordinator.reserveAcquisitionTransition(
        { generation: "generation-0", revision: 1 },
        managementPermit as unknown as VerifiedCandidateProof,
        target,
        null,
      ),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });
  });

  it("orders dispatch with retirement and rejects a response delivered after retirement", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const certificate = activation("a", "generation-a");
    await activateAnonymous(factory, coordinator, certificate, "attempt-a");
    const controller = new AbortController();
    const view = createViewLease({
      activation: certificate,
      organizationId: "org-a",
      orgRevision: "org-revision-a",
      ownerTabId: "owner-tab-a",
      documentId: "document-a",
      signal: controller.signal,
    });
    const { credential: cursor } = await coordinator.readActiveSession();
    const persisted = await readCoordinatorSnapshot(factory);
    const expectedAccessToken = persisted.credentials[0]?.accessToken;
    let resolveRequest = (_value: string): void => undefined;
    const requestPromise = new Promise<string>((resolve) => {
      resolveRequest = resolve;
    });
    const dispatch = await coordinator.startActiveDispatch(view, cursor, "access", (token) => {
      expect(token).toEqual({ kind: "access", token: expectedAccessToken });
      return requestPromise;
    });

    await coordinator.beginRetirement(certificate, "logout", "generation-retiring");
    resolveRequest("late-response");
    await expect(dispatch.request).resolves.toBe("late-response");
    await expect(coordinator.assertActiveDispatchResponse(dispatch.admission, view)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });

    const dispatchStart = vi.fn();
    await expect(coordinator.startActiveDispatch(view, cursor, "access", dispatchStart)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    expect(dispatchStart).not.toHaveBeenCalled();
  });

  it("uses only transactional coordinator state when Web Storage propagation is stale", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const certificate = activation("a", "generation-a");
    await activateAnonymous(factory, coordinator, certificate, "attempt-a");
    const staleRendererStorage = new Map<string, string>([["first-tree:tokens", "stale-a"]]);

    await coordinator.beginRetirement(certificate, "logout", "generation-retiring");
    staleRendererStorage.set("first-tree:tokens", "stale-a-after-retirement");

    await expect(coordinator.admitActivation(certificate)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    expect(staleRendererStorage.get("first-tree:tokens")).toBe("stale-a-after-retirement");
  });

  it("rejects a latched authority read and shared callback when the view aborts mid-open", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const certificate = activation("a", "generation-a");
    await activateAnonymous(factory, coordinator, certificate, "attempt-a");

    const firstController = new AbortController();
    const firstView = createViewLease({
      activation: certificate,
      organizationId: "org-a",
      orgRevision: "revision-a",
      ownerTabId: "owner-tab-a",
      documentId: "document-a",
      signal: firstController.signal,
    });
    const firstLatch = deferNextOpen(factory);
    const admission = coordinator.admitView(firstView);
    await firstLatch.started;
    firstController.abort();
    firstLatch.release();
    await expect(admission).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });

    const secondController = new AbortController();
    const secondView = createViewLease({
      ...firstView,
      documentId: "document-b",
      signal: secondController.signal,
    });
    const secondLatch = deferNextOpen(factory);
    const callback = vi.fn();
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const shared = barrier.withShared(secondView, callback);
    await secondLatch.started;
    secondController.abort();
    secondLatch.release();
    await expect(shared).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect(callback).not.toHaveBeenCalled();
  });

  it("snapshots an account lease signal once and fences admission to that exact lifecycle", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const certificate = activation("a", "generation-a");
    await activateAnonymous(factory, coordinator, certificate, "attempt-a");

    const firstController = new AbortController();
    const secondController = new AbortController();
    let currentSignal = firstController.signal;
    let signalReads = 0;
    const mutableLease = Object.defineProperties(
      {},
      {
        activation: { enumerable: true, get: () => certificate },
        accountRevision: { enumerable: true, get: () => "account-revision-a" },
        ownerTabId: { enumerable: true, get: () => "owner-tab-a" },
        documentId: { enumerable: true, get: () => "document-a" },
        signal: {
          enumerable: true,
          get: () => {
            signalReads += 1;
            return currentSignal;
          },
        },
      },
    );
    const latch = deferNextOpen(factory);
    const admission = coordinator.admitAccountLease(mutableLease);
    await latch.started;
    currentSignal = secondController.signal;
    firstController.abort();
    latch.release();

    await expect(admission).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect(signalReads).toBe(1);
    await expect(
      coordinator.admitAccountLease(
        createAccountLease({
          activation: certificate,
          accountRevision: "account-revision-b",
          ownerTabId: "owner-tab-a",
          documentId: "document-a",
          signal: secondController.signal,
        }),
      ),
    ).resolves.toMatchObject({ authority: { session: certificate } });
  });

  it("classifies an active me 401 without exposing response content", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("baseline-active-me-401");
    const certificate = activation("active-me-401", "generation-active-me-401");
    await activateAnonymous(factory, coordinator, certificate, "attempt-active-me-401");
    const lease = createAccountLease({
      activation: certificate,
      accountRevision: "account-revision-active-me-401",
      ownerTabId: "owner-tab-active-me-401",
      documentId: "document-active-me-401",
      signal: new AbortController().signal,
    });
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const disposeRuntime = installAccountStoreRuntime({ barrier, lease });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("sensitive provider error", { status: 401 })),
    );

    await expect(coordinator.requestActiveMe(lease)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
      detail: { kind: "active_me_http_status", status: 401 },
    });
    disposeRuntime();
  });

  it("accepts only the exact one-shot active me 401 error object as refresh authority", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("baseline-active-me-401-capability");
    const certificate = activation("active-me-401-capability", "generation-active-me-401-capability");
    await activateAnonymous(factory, coordinator, certificate, "attempt-active-me-401-capability");
    const before = await coordinator.readActiveSession();
    const replacement = await credential(certificate, 1, "active-me-401-capability-rotated");
    const lease = createAccountLease({
      activation: certificate,
      accountRevision: "account-revision-active-me-401-capability",
      ownerTabId: "owner-tab-active-me-401-capability",
      documentId: "document-active-me-401-capability",
      signal: new AbortController().signal,
    });
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const disposeRuntime = installAccountStoreRuntime({ barrier, lease });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: replacement.accessToken, refreshToken: replacement.refreshToken }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const rejection = await sessionRejection(coordinator.requestActiveMe(lease));
    const prototypeCopy = Object.assign(Object.create(Object.getPrototypeOf(rejection)), rejection) as SessionError;
    const lookalikes: unknown[] = [
      { ...rejection },
      new SessionError(rejection.code, rejection.message, rejection.detail),
      prototypeCopy,
    ];
    for (const [index, lookalike] of lookalikes.entries()) {
      await expect(
        coordinator.refreshAccountCredentialAfterActiveMe401(lease, lookalike, `owned-401-lookalike-${String(index)}`),
      ).rejects.toMatchObject({
        code: index === 0 ? sessionErrorCodes.invalidState : sessionErrorCodes.staleOperation,
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      coordinator.refreshAccountCredentialAfterActiveMe401(lease, rejection, "owned-401-exact-capability"),
    ).resolves.toEqual({
      sessionEpoch: certificate.sessionEpoch,
      credentialRevision: 1,
      credentialFingerprint: replacement.credentialFingerprint,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const persisted = await readCoordinatorSnapshot(factory);
    expect(persisted.credentials).toEqual([replacement]);
    await expect(
      coordinator.refreshAccountCredentialAfterActiveMe401(lease, rejection, "owned-401-reused-capability"),
    ).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(before.credential.credentialRevision).toBe(0);
    disposeRuntime();
  });

  it("rejects an exact active me 401 capability after its source lifecycle aborts", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("baseline-active-me-401-source-abort");
    const certificate = activation("active-me-401-source-abort", "generation-active-me-401-source-abort");
    await activateAnonymous(factory, coordinator, certificate, "attempt-active-me-401-source-abort");
    const controller = new AbortController();
    const lease = createAccountLease({
      activation: certificate,
      accountRevision: "account-revision-active-me-401-source-abort",
      ownerTabId: "owner-tab-active-me-401-source-abort",
      documentId: "document-active-me-401-source-abort",
      signal: controller.signal,
    });
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const disposeRuntime = installAccountStoreRuntime({ barrier, lease });
    const fetchMock = vi.fn().mockResolvedValue(new Response("expired", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const rejection = await sessionRejection(coordinator.requestActiveMe(lease));

    controller.abort();
    await expect(
      coordinator.refreshAccountCredentialAfterActiveMe401(lease, rejection, "owned-401-source-abort"),
    ).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await coordinator.readActiveSession()).credential.credentialRevision).toBe(0);
    disposeRuntime();
  });

  it.each([
    "success",
    "401",
  ] as const)("drops a proof-owned %s refresh when its exact account runtime is replaced in flight", async (responseKind) => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous(`baseline-active-me-401-runtime-replaced-${responseKind}`);
    const certificate = activation(
      `active-me-401-runtime-replaced-${responseKind}`,
      `generation-active-me-401-runtime-replaced-${responseKind}`,
    );
    await activateAnonymous(
      factory,
      coordinator,
      certificate,
      `attempt-active-me-401-runtime-replaced-${responseKind}`,
    );
    const firstController = new AbortController();
    const firstLease = createAccountLease({
      activation: certificate,
      accountRevision: `account-revision-active-me-401-runtime-replaced-${responseKind}-first`,
      ownerTabId: `owner-tab-active-me-401-runtime-replaced-${responseKind}`,
      documentId: `document-active-me-401-runtime-replaced-${responseKind}`,
      signal: firstController.signal,
    });
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const disposeFirst = installAccountStoreRuntime({ barrier, lease: firstLease });
    let resolveRefresh = (_response: Response): void => undefined;
    const heldRefresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const replacement = await credential(certificate, 1, `runtime-replaced-${responseKind}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockImplementationOnce(() => heldRefresh);
    vi.stubGlobal("fetch", fetchMock);
    const rejection = await sessionRejection(coordinator.requestActiveMe(firstLease));
    const refreshing = coordinator.refreshAccountCredentialAfterActiveMe401(
      firstLease,
      rejection,
      `owned-401-runtime-replaced-${responseKind}`,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const secondController = new AbortController();
    const secondLease = createAccountLease({
      ...firstLease,
      accountRevision: `account-revision-active-me-401-runtime-replaced-${responseKind}-second`,
      signal: secondController.signal,
    });
    const disposeSecond = installAccountStoreRuntime({ barrier, lease: secondLease });
    resolveRefresh(
      responseKind === "401"
        ? new Response("stale expired refresh", { status: 401 })
        : jsonResponse({ accessToken: replacement.accessToken, refreshToken: replacement.refreshToken }),
    );

    await expect(refreshing).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    const persisted = await readCoordinatorSnapshot(factory);
    expect(persisted.authority).toMatchObject({ mode: "active", session: certificate });
    expect(persisted.credentials[0]?.credentialRevision).toBe(0);
    await expect(
      coordinator.refreshAccountCredentialAfterActiveMe401(
        firstLease,
        rejection,
        `owned-401-runtime-replaced-replay-${responseKind}`,
      ),
    ).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    secondController.abort();
    disposeSecond();
    disposeFirst();
  });

  it("serializes a claimed active me 401 refresh through credential transaction completion", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("baseline-active-me-401-serialized");
    const certificate = activation("active-me-401-serialized", "generation-active-me-401-serialized");
    await activateAnonymous(factory, coordinator, certificate, "attempt-active-me-401-serialized");
    const replacement = await credential(certificate, 1, "active-me-401-serialized-rotated");
    const lease = createAccountLease({
      activation: certificate,
      accountRevision: "account-revision-active-me-401-serialized",
      ownerTabId: "owner-tab-active-me-401-serialized",
      documentId: "document-active-me-401-serialized",
      signal: new AbortController().signal,
    });
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const disposeRuntime = installAccountStoreRuntime({ barrier, lease });
    let resolveRefresh = (_response: Response): void => undefined;
    const heldRefresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockImplementationOnce(() => heldRefresh)
      .mockResolvedValueOnce(
        jsonResponse({
          user: { id: certificate.accountId },
          memberships: [{ organizationId: "org-serialized" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const rejection = await sessionRejection(coordinator.requestActiveMe(lease));

    const refreshing = coordinator.refreshAccountCredentialAfterActiveMe401(lease, rejection, "owned-401-serialized");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await expect(coordinator.requestActiveMe(lease)).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveRefresh(jsonResponse({ accessToken: replacement.accessToken, refreshToken: replacement.refreshToken }));
    await expect(refreshing).resolves.toMatchObject({ credentialRevision: 1 });
    const identity = await coordinator.requestActiveMe(lease);
    expect(readVerifiedActiveMeProof(identity.proof, lease).membershipIds).toEqual(["org-serialized"]);
    const persisted = await readCoordinatorSnapshot(factory);
    expect(persisted.credentials).toEqual([replacement]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    disposeRuntime();
  });

  it.each([
    "success",
    "401",
  ] as const)("does not let a stale proof-owned %s refresh overwrite or retire a concurrently committed credential", async (staleResponseKind) => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous(`baseline-active-me-401-concurrent-${staleResponseKind}`);
    const certificate = activation(
      `active-me-401-concurrent-${staleResponseKind}`,
      `generation-active-me-401-concurrent-${staleResponseKind}`,
    );
    await activateAnonymous(factory, coordinator, certificate, `attempt-active-me-401-concurrent-${staleResponseKind}`);
    const before = await coordinator.readActiveSession();
    const winner = await credential(certificate, 1, `active-me-401-winner-${staleResponseKind}`);
    const stale = await credential(certificate, 1, `active-me-401-stale-${staleResponseKind}`);
    const lease = createAccountLease({
      activation: certificate,
      accountRevision: `account-revision-active-me-401-concurrent-${staleResponseKind}`,
      ownerTabId: `owner-tab-active-me-401-concurrent-${staleResponseKind}`,
      documentId: `document-active-me-401-concurrent-${staleResponseKind}`,
      signal: new AbortController().signal,
    });
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const disposeRuntime = installAccountStoreRuntime({ barrier, lease });
    let resolveStale = (_response: Response): void => undefined;
    const heldStale = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockImplementationOnce(() => heldStale)
      .mockResolvedValueOnce(jsonResponse({ accessToken: winner.accessToken, refreshToken: winner.refreshToken }));
    vi.stubGlobal("fetch", fetchMock);
    const rejection = await sessionRejection(coordinator.requestActiveMe(lease));
    const staleRefresh = coordinator.refreshAccountCredentialAfterActiveMe401(
      lease,
      rejection,
      `owned-401-stale-${staleResponseKind}`,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await coordinator.refreshAccountCredential(lease, before.credential, `owned-401-winner-${staleResponseKind}`);
    resolveStale(
      staleResponseKind === "401"
        ? new Response("expired stale refresh", { status: 401 })
        : jsonResponse({ accessToken: stale.accessToken, refreshToken: stale.refreshToken }),
    );

    await expect(staleRefresh).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });
    const persisted = await readCoordinatorSnapshot(factory);
    expect(persisted.authority).toMatchObject({ mode: "active", session: certificate });
    expect(persisted.credentials).toEqual([winner]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    disposeRuntime();
  });

  it("does not mint active me 401 authority after the dispatched credential changes", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("baseline-stale-active-me-401");
    const certificate = activation("stale-active-me-401", "generation-stale-active-me-401");
    await activateAnonymous(factory, coordinator, certificate, "attempt-stale-active-me-401");
    const before = await coordinator.readActiveSession();
    const lease = createAccountLease({
      activation: certificate,
      accountRevision: "account-revision-stale-active-me-401",
      ownerTabId: "owner-tab-stale-active-me-401",
      documentId: "document-stale-active-me-401",
      signal: new AbortController().signal,
    });
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const disposeRuntime = installAccountStoreRuntime({ barrier, lease });
    let resolveRejectedMe = (_response: Response): void => undefined;
    const rejectedMe = new Promise<Response>((resolve) => {
      resolveRejectedMe = resolve;
    });
    const replacement = await credential(certificate, 1, "newer-before-stale-401");
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => rejectedMe)
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: replacement.accessToken, refreshToken: replacement.refreshToken }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const staleRequest = coordinator.requestActiveMe(lease);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await coordinator.refreshAccountCredential(lease, before.credential, "unused-newer-credential-401");
    resolveRejectedMe(new Response("expired old access", { status: 401 }));
    let staleRejection: unknown;
    try {
      await staleRequest;
    } catch (error) {
      staleRejection = error;
    }
    expect(staleRejection).toMatchObject({ code: sessionErrorCodes.admissionDenied });
    expect(staleRejection).not.toMatchObject({ detail: { kind: "active_me_http_status", status: 401 } });

    await expect(
      coordinator.refreshAccountCredentialAfterActiveMe401(lease, staleRejection, "owned-401-must-not-refresh-newer"),
    ).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await coordinator.readActiveSession()).credential).toEqual({
      sessionEpoch: certificate.sessionEpoch,
      credentialRevision: 1,
      credentialFingerprint: replacement.credentialFingerprint,
    });
    disposeRuntime();
  });

  it("owns active me dispatch and lets only the newest exact account lifecycle prove memberships", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const certificate = activation("active-me", "generation-active-me");
    await activateAnonymous(factory, coordinator, certificate, "attempt-active-me");
    const controller = new AbortController();
    const lease = createAccountLease({
      activation: certificate,
      accountRevision: "account-revision-active-me",
      ownerTabId: "owner-tab-active-me",
      documentId: "document-active-me",
      signal: controller.signal,
    });
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const disposeRuntime = installAccountStoreRuntime({ barrier, lease });

    let resolveFirst = (_response: Response): void => undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce(
        jsonResponse({
          user: { id: certificate.accountId },
          defaultOrganizationId: "org-new",
          memberships: [{ organizationId: "org-new" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = coordinator.requestActiveMe(lease);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = await coordinator.requestActiveMe(lease);
    expect(readVerifiedActiveMeProof(second.proof, lease)).toEqual({
      membershipIds: ["org-new"],
      defaultOrganizationId: "org-new",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/me");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });

    resolveFirst(
      jsonResponse({
        user: { id: certificate.accountId },
        defaultOrganizationId: "org-old",
        memberships: [{ organizationId: "org-old" }],
      }),
    );
    await expect(first).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });

    controller.abort();
    expect(() => readVerifiedActiveMeProof(second.proof, lease)).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );
    disposeRuntime();
  });

  it("drops an active me response when its exact account runtime is replaced", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const certificate = activation("active-me-replaced", "generation-active-me-replaced");
    await activateAnonymous(factory, coordinator, certificate, "attempt-active-me-replaced");
    const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks: new ImmediateLocks() });
    const firstController = new AbortController();
    const firstLease = createAccountLease({
      activation: certificate,
      accountRevision: "account-revision-active-me-first",
      ownerTabId: "owner-tab-active-me-replaced",
      documentId: "document-active-me-replaced",
      signal: firstController.signal,
    });
    const disposeFirst = installAccountStoreRuntime({ barrier, lease: firstLease });

    let resolveFirst = (_response: Response): void => undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce(
        jsonResponse({
          user: { id: certificate.accountId },
          defaultOrganizationId: "org-current",
          memberships: [{ organizationId: "org-current" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = coordinator.requestActiveMe(firstLease);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstDispatchedSignal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal | undefined;
    expect(firstDispatchedSignal).toBeDefined();
    expect(firstDispatchedSignal).not.toBe(firstController.signal);

    const secondController = new AbortController();
    const secondLease = createAccountLease({
      ...firstLease,
      accountRevision: "account-revision-active-me-second",
      signal: secondController.signal,
    });
    const disposeSecond = installAccountStoreRuntime({ barrier, lease: secondLease });
    expect(firstController.signal.aborted).toBe(false);
    expect(firstDispatchedSignal?.aborted).toBe(true);

    const second = await coordinator.requestActiveMe(secondLease);
    expect(readVerifiedActiveMeProof(second.proof, secondLease)).toEqual({
      membershipIds: ["org-current"],
      defaultOrganizationId: "org-current",
    });

    resolveFirst(
      jsonResponse({
        user: { id: certificate.accountId },
        defaultOrganizationId: "org-stale",
        memberships: [{ organizationId: "org-stale" }],
      }),
    );
    await expect(first).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });

    const thirdController = new AbortController();
    const thirdLease = createAccountLease({
      ...secondLease,
      accountRevision: "account-revision-active-me-third",
      signal: thirdController.signal,
    });
    const disposeThird = installAccountStoreRuntime({ barrier, lease: thirdLease });
    expect(() => readVerifiedActiveMeProof(second.proof, secondLease)).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );
    expect(() => claimVerifiedActiveMeProof(second.proof, secondLease)).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );

    thirdController.abort();
    disposeThird();
    disposeSecond();
    disposeFirst();
  });

  it("lets logout retire a refreshed session but ignores an old-revision owned 401", async () => {
    const firstFactory = new IDBFactory();
    const first = new AuthSessionCoordinator({ indexedDB: firstFactory });
    await first.bootstrapAnonymous("generation-0");
    const certificate = activation("a", "generation-a");
    await activateAnonymous(firstFactory, first, certificate, "attempt-a");
    const controller = new AbortController();
    const view = createViewLease({
      activation: certificate,
      organizationId: "org-a",
      orgRevision: "org-revision-a",
      ownerTabId: "owner-tab-a",
      documentId: "document-a",
      signal: controller.signal,
    });
    const before = await first.readActiveSession();
    const oldDispatch = await first.startActiveDispatch(view, before.credential, "access", () => Promise.resolve(401));
    const refreshed = await credential(certificate, 1, "refreshed-a");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken })),
    );
    await first.refreshActiveCredential(view, before.credential);

    await expect(first.beginOwned401Retirement(oldDispatch.admission, view, "generation-old-401")).resolves.toBe(
      "superseded",
    );
    await expect(first.beginRetirement(certificate, "logout", "generation-logout")).resolves.toBe("retired");

    const secondFactory = new IDBFactory();
    const second = new AuthSessionCoordinator({ indexedDB: secondFactory });
    await second.bootstrapAnonymous("generation-0");
    await activateAnonymous(secondFactory, second, certificate, "attempt-a");
    const current = await second.readActiveSession();
    const currentDispatch = await second.startActiveDispatch(view, current.credential, "access", () =>
      Promise.resolve(401),
    );
    await expect(
      second.beginOwned401Retirement(currentDispatch.admission, view, "generation-current-401"),
    ).resolves.toBe("retired");
  });

  it("fails closed on impossible persisted cleaning, retirement, and transition graphs", async () => {
    const cleaningFactory = new IDBFactory();
    const cleaningCoordinator = new AuthSessionCoordinator({ indexedDB: cleaningFactory });
    const anonymous = await cleaningCoordinator.bootstrapAnonymous("generation-validator-baseline");
    const cleaningResult = await cleaningCoordinator.cancelAnonymousAuthority(
      anonymous,
      "generation-validator-cleaning",
    );
    if (cleaningResult.kind !== "cleaning") throw new Error("expected cleaning authority");
    const cleaningSnapshot = await readCoordinatorSnapshot(cleaningFactory);

    const transitionFactory = new IDBFactory();
    const transitionCoordinator = new AuthSessionCoordinator({ indexedDB: transitionFactory });
    await transitionCoordinator.bootstrapAnonymous("generation-validator-none");
    const source = activation("validator-source", "generation-validator-source");
    await activateAnonymous(transitionFactory, transitionCoordinator, source, "validator-source-attempt");
    const target = activation("validator-target", "generation-validator-target");
    const targetAttempt = attempt("validator-target-attempt", source.authGeneration, source.sessionEpoch);
    await transitionCoordinator.putAttempt(targetAttempt);
    const targetProof = await candidateProof(transitionCoordinator, targetAttempt, await credential(target));
    const transitionCursor = await transitionCoordinator.readAuthority();
    const transitionPermit = await transitionCoordinator.reserveAcquisitionTransition(
      { generation: transitionCursor.generation, revision: transitionCursor.revision },
      targetProof,
      target,
      source,
    );
    const transitionSnapshot = await readCoordinatorSnapshot(transitionFactory);
    if (transitionSnapshot.authority.mode !== "transition") throw new Error("expected transition authority");
    const persistedTransitionAttempt = transitionSnapshot.attempts[0];
    if (!persistedTransitionAttempt) throw new Error("expected transition attempt");
    const retirement = await transitionCoordinator.cancelAcquisitionTransition(
      transitionPermit,
      "generation-validator-retiring",
    );
    if (retirement.kind !== "retiring") throw new Error("expected retiring authority");
    const retiringSnapshot = await readCoordinatorSnapshot(transitionFactory);
    if (retiringSnapshot.authority.mode !== "retiring") throw new Error("expected persisted retirement");

    const anonymousTransitionFactory = new IDBFactory();
    const anonymousTransitionCoordinator = new AuthSessionCoordinator({ indexedDB: anonymousTransitionFactory });
    await anonymousTransitionCoordinator.bootstrapAnonymous("generation-validator-anonymous-baseline");
    const anonymousAttempt = attempt("validator-anonymous-target-attempt", "generation-validator-anonymous-baseline");
    await anonymousTransitionCoordinator.putAttempt(anonymousAttempt);
    const anonymousTarget = activation("validator-anonymous-target", "generation-validator-anonymous-target");
    const anonymousProof = await candidateProof(
      anonymousTransitionCoordinator,
      anonymousAttempt,
      await credential(anonymousTarget),
    );
    const anonymousCursor = await anonymousTransitionCoordinator.readAuthority();
    await anonymousTransitionCoordinator.reserveAcquisitionTransition(
      { generation: anonymousCursor.generation, revision: anonymousCursor.revision },
      anonymousProof,
      anonymousTarget,
      null,
    );
    const anonymousTransitionSnapshot = await readCoordinatorSnapshot(anonymousTransitionFactory);
    if (anonymousTransitionSnapshot.authority.mode !== "transition") {
      throw new Error("expected anonymous transition authority");
    }
    const anonymousPersistedAttempt = anonymousTransitionSnapshot.attempts[0];
    if (!anonymousPersistedAttempt) throw new Error("expected anonymous transition attempt");

    const recycledTarget = {
      ...transitionSnapshot.authority.permit.target,
      authGeneration: source.authGeneration,
    };
    const malformedSnapshots: readonly unknown[] = [
      {
        ...cleaningSnapshot,
        authority: { ...cleaningSnapshot.authority, cause: "invalid-cleaning-cause" },
      },
      {
        ...cleaningSnapshot,
        authority: { ...cleaningSnapshot.authority, forbiddenGenerations: [] },
      },
      {
        ...cleaningSnapshot,
        authority: {
          ...cleaningSnapshot.authority,
          cause: "transition_cancelled",
          forbiddenGenerations: [anonymous.generation, anonymous.generation],
        },
      },
      {
        ...cleaningSnapshot,
        authority: {
          ...cleaningSnapshot.authority,
          forbiddenGenerations: [cleaningResult.authority.generation],
        },
      },
      {
        ...retiringSnapshot,
        authority: { ...retiringSnapshot.authority, generation: source.authGeneration },
      },
      {
        ...retiringSnapshot,
        authority: { ...retiringSnapshot.authority, forbiddenGenerations: [source.authGeneration] },
      },
      {
        ...retiringSnapshot,
        authority: {
          ...retiringSnapshot.authority,
          forbiddenGenerations: [retiringSnapshot.authority.generation],
        },
      },
      { ...retiringSnapshot, attempts: [persistedTransitionAttempt] },
      {
        ...transitionSnapshot,
        attempts: [
          persistedTransitionAttempt,
          attempt("validator-extra-transition-attempt", source.authGeneration, source.sessionEpoch),
        ],
      },
      {
        ...transitionSnapshot,
        attempts: [{ ...persistedTransitionAttempt, sourceEpoch: "epoch-another-source" }],
      },
      {
        ...transitionSnapshot,
        authority: {
          ...transitionSnapshot.authority,
          generation: source.authGeneration,
          permit: { ...transitionSnapshot.authority.permit, target: recycledTarget },
        },
      },
      {
        ...anonymousTransitionSnapshot,
        attempts: [
          {
            ...anonymousPersistedAttempt,
            baselineGeneration: anonymousTransitionSnapshot.authority.generation,
          },
        ],
      },
    ];
    for (const malformed of malformedSnapshots) {
      expect(() => validateCoordinatorSnapshot(malformed)).toThrowError(
        expect.objectContaining({ code: sessionErrorCodes.recoveryRequired }),
      );
    }

    const rawFactory = new IDBFactory();
    const rawCoordinator = new AuthSessionCoordinator({ indexedDB: rawFactory });
    await rawCoordinator.bootstrapAnonymous("generation-validator-raw");
    await writeRawCoordinatorSnapshotForTest(rawFactory, {
      ...cleaningSnapshot,
      authority: { ...cleaningSnapshot.authority, forbiddenGenerations: [""] },
    });
    await expect(rawCoordinator.readAuthority()).rejects.toMatchObject({
      code: sessionErrorCodes.recoveryRequired,
    });
  });

  it("rejects a persisted token swap that retains the old cursor and never dispatches it", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const certificate = activation("a", "generation-a");
    await activateAnonymous(factory, coordinator, certificate, "attempt-a");
    const controller = new AbortController();
    const view = createViewLease({
      activation: certificate,
      organizationId: "org-a",
      orgRevision: "org-revision-a",
      ownerTabId: "owner-tab-a",
      documentId: "document-a",
      signal: controller.signal,
    });
    const before = await coordinator.readActiveSession();
    await replaceCoordinatorSnapshotForTest(factory, (snapshot) => {
      const current = snapshot.credentials[0];
      if (!current) throw new Error("missing credential fixture");
      return {
        ...snapshot,
        authority: { ...snapshot.authority, revision: snapshot.authority.revision + 1 } as AuthAuthority,
        credentials: [{ ...current, accessToken: jwt(certificate.accountId, "access", "swapped") }],
      };
    });

    const start = vi.fn();
    await expect(coordinator.startActiveDispatch(view, before.credential, "access", start)).rejects.toMatchObject({
      code: sessionErrorCodes.recoveryRequired,
    });
    expect(start).not.toHaveBeenCalled();
    await expect(coordinator.readActiveSession()).rejects.toMatchObject({
      code: sessionErrorCodes.recoveryRequired,
    });
  });

  it("fails closed when the authority row is missing or IndexedDB is unavailable", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(AUTH_COORDINATOR_DATABASE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(["authority", "credentials", "attempts"], "readwrite");
    transaction.objectStore("authority").delete("head");
    await transactionDone(transaction);
    database.close();

    await expect(coordinator.readAuthority()).rejects.toMatchObject({
      code: sessionErrorCodes.recoveryRequired,
    });

    const original = globalThis.indexedDB;
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    try {
      expect(() => new AuthSessionCoordinator()).toThrowError(
        expect.objectContaining({ code: sessionErrorCodes.persistenceUnavailable }),
      );
    } finally {
      globalThis.indexedDB = original;
    }
  });
});
