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
  AuthSessionCoordinator,
  ContentScopeBarrier,
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

function jwt(accountId: string, kind: "access" | "refresh", marker: string): string {
  return `${base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify({ sub: accountId, type: kind, exp: 2_100_000_000, marker }),
  )}.signature`;
}

async function credential(certificate: ActivationCertificate, revision = 0, suffix = certificate.sessionEpoch) {
  const accessToken = jwt(certificate.accountId, "access", `access-${suffix}`);
  const refreshToken = jwt(certificate.accountId, "refresh", `refresh-${suffix}`);
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
  factory: IDBFactory,
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
  const legacyScrub = await scrubLegacyPersistence({
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    indexedDB: factory,
  });
  const transition = await coordinator.reserveAcquisitionTransition(
    { generation: beforeReservation.generation, revision: beforeReservation.revision },
    proof,
    certificate,
    null,
    legacyScrub,
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

function memoryStorage(): StorageArea {
  const values = new Map<string, string>();
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
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const candidateAttempt = attempt("candidate-a", "generation-0");
    await coordinator.putAttempt(candidateAttempt);
    const before = await readCoordinatorSnapshot(factory);
    const target = activation("a", "generation-a");
    const targetCredential = await credential(target);
    const proof = await candidateProof(coordinator, candidateAttempt, targetCredential);

    await expect(
      coordinator.reserveAcquisitionTransition({ generation: "generation-0", revision: 1 }, proof, target, null),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });

    const refusesRemoval: StorageArea = {
      length: 1,
      key: () => "first-tree:tokens",
      getItem: () => "plaintext-secret",
      removeItem: () => undefined,
    };
    await expect(
      scrubLegacyPersistence({
        localStorage: refusesRemoval,
        sessionStorage: memoryStorage(),
        indexedDB: factory,
      }),
    ).rejects.toMatchObject({ code: sessionErrorCodes.persistenceUnavailable });

    expect(await readCoordinatorSnapshot(factory)).toEqual(before);
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
    const scrub = await scrubLegacyPersistence({
      localStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
      indexedDB: factory,
    });

    const transition = await coordinator.reserveAcquisitionTransition(
      { generation: "generation-0", revision: 2 },
      proof,
      next,
      null,
      scrub,
    );
    await coordinator.completeAcquisitionTransition(transition, proof);

    const snapshot = await readCoordinatorSnapshot(factory);
    expect(snapshot.authority).toMatchObject({ mode: "active", generation: "generation-a" });
    expect(snapshot.attempts).toEqual([]);
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
    const scrub = await scrubLegacyPersistence({
      localStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
      indexedDB: factory,
    });
    const transition = await coordinator.reserveAcquisitionTransition(
      { generation: "generation-0", revision: 1 },
      firstProof,
      target,
      null,
      scrub,
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
    const scrub = await scrubLegacyPersistence({
      localStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
      indexedDB: factory,
    });
    controller.abort();
    await expect(
      coordinator.reserveAcquisitionTransition({ generation: "generation-0", revision: 1 }, proof, target, null, scrub),
    ).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    await expect(coordinator.readAuthority()).resolves.toMatchObject({ mode: "none", revision: 1 });

    const secondController = new AbortController();
    const secondProof = await candidateProof(coordinator, candidateAttempt, targetCredential, secondController.signal);
    closeCoordinatorConnections();
    await expect(
      coordinator.reserveAcquisitionTransition(
        { generation: "generation-0", revision: 1 },
        secondProof,
        target,
        null,
        scrub,
      ),
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

  it("consumes a legacy scrub proof when reservation commits but pagehide loses its result", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-0");
    const candidateAttempt = attempt("ambiguous-reserve", "generation-0");
    await coordinator.putAttempt(candidateAttempt);
    const target = activation("a", "generation-a");
    const targetCredential = await credential(target);
    const proof = await candidateProof(coordinator, candidateAttempt, targetCredential);
    const scrub = await scrubLegacyPersistence({
      localStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
      indexedDB: factory,
    });

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
      scrub,
    );
    await transitionWrite;
    closeCoordinatorConnections();
    await expect(reservation).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    putSpy.mockRestore();

    const reloaded = new AuthSessionCoordinator({ indexedDB: factory });
    const persisted = await reloaded.readAuthority();
    expect(persisted).toMatchObject({ mode: "transition", generation: "generation-a" });
    if (persisted.mode !== "transition") throw new Error("expected committed transition fixture");
    await reloaded.cancelAcquisitionTransition(persisted.permit, "generation-recovered");

    const nextAttempt = attempt("after-ambiguous-reserve", "generation-recovered");
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
        scrub,
      ),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });
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
    const scrub = await scrubLegacyPersistence({
      localStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
      indexedDB: factory,
    });
    const permit = await coordinator.reserveAcquisitionTransition(
      { generation: "generation-0", revision: 1 },
      proof,
      target,
      null,
      scrub,
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
      kind: "anonymous",
      authority: { mode: "none", generation: "generation-recovered" },
    });
    const recovered = await readCoordinatorSnapshot(factory);
    expect(recovered.credentials).toEqual([]);
    expect(recovered.attempts).toEqual([]);

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
      await recovering.completeRetirement(source, finalReceipt, `generation-none-${purgeBeforeCancel}`);
      await expect(recovering.readAuthority()).resolves.toMatchObject({
        mode: "none",
        generation: `generation-none-${purgeBeforeCancel}`,
      });
    }
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
