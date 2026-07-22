import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ActivationCertificate,
  AUTH_COORDINATOR_DATABASE_NAME,
  type AuthAuthority,
  AuthSessionCoordinator,
  type CoordinatorSnapshot,
  closeCoordinatorConnections,
  createAccountScopeKey,
  createActivationCertificate,
  createCredentialRecord,
  createSessionAttempt,
  createTransitionPermit,
  replaceCoordinatorSnapshot,
  SessionError,
  sessionErrorCodes,
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

function attempt(attemptId: string, generation: string, sourceEpoch: string | null = null) {
  return createSessionAttempt({
    attemptId,
    kind: "acquisition",
    serverAuthority: SERVER_AUTHORITY,
    baselineGeneration: generation,
    sourceEpoch,
    expiresAt: Date.now() + 60_000,
    payload: { mappedTab: `tab-${attemptId}` },
  });
}

function permit(certificate: ActivationCertificate, attemptId: string) {
  return createTransitionPermit({
    permitId: certificate.transitionPermitId,
    attemptId,
    target: certificate,
    expiresAt: Date.now() + 60_000,
  });
}

async function activateAnonymous(
  coordinator: AuthSessionCoordinator,
  certificate: ActivationCertificate,
  attemptId: string,
): Promise<void> {
  const beforeAttempt = await coordinator.readAuthority();
  await coordinator.putAttempt(attempt(attemptId, beforeAttempt.generation));
  const beforeReservation = await coordinator.readAuthority();
  const transition = permit(certificate, attemptId);
  await coordinator.reserveTransition(
    { generation: beforeReservation.generation, revision: beforeReservation.revision },
    transition,
    null,
    `null-source-${attemptId}`,
  );
  await coordinator.completeTransition(transition, credential(certificate), `null-source-${attemptId}`);
}

function mutateRevision(snapshot: CoordinatorSnapshot): CoordinatorSnapshot {
  return {
    ...snapshot,
    authority: { ...snapshot.authority, revision: snapshot.authority.revision + 1 } as AuthAuthority,
  };
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

afterEach(() => closeCoordinatorConnections());

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

    const snapshot = await first.readSnapshot();
    expect(snapshot.authority).toMatchObject({ mode: "none", generation: "generation-0", revision: 2 });
    expect(snapshot.attempts.map((item) => item.attemptId).sort()).toEqual(["x-1", "x-2"]);
  });

  it("does not resolve a mutation at request success before transaction complete", async () => {
    const coordinator = new AuthSessionCoordinator({ indexedDB: new IDBFactory() });
    await coordinator.bootstrapAnonymous("generation-0");

    let plannerReachedResolve = (): void => undefined;
    const plannerReached = new Promise<void>((resolve) => {
      plannerReachedResolve = resolve;
    });
    let resolved = false;
    const mutation = coordinator
      .commit((snapshot) => {
        plannerReachedResolve();
        return replaceCoordinatorSnapshot(mutateRevision(snapshot), "committed");
      })
      .then((value) => {
        resolved = true;
        return value;
      });

    await plannerReached;
    expect(resolved).toBe(false);
    await expect(mutation).resolves.toBe("committed");
    expect(resolved).toBe(true);
  });

  it("aborts a planner failure after reads and leaves the prior snapshot unchanged", async () => {
    const coordinator = new AuthSessionCoordinator({ indexedDB: new IDBFactory() });
    await coordinator.bootstrapAnonymous("generation-0");
    const before = await coordinator.readSnapshot();

    await expect(
      coordinator.commit(() => {
        throw new SessionError(sessionErrorCodes.admissionDenied, "stale candidate");
      }),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });

    expect(await coordinator.readSnapshot()).toEqual(before);
  });

  it("consumes every incompatible attempt when auth generation rotates", async () => {
    const coordinator = new AuthSessionCoordinator({ indexedDB: new IDBFactory() });
    await coordinator.bootstrapAnonymous("generation-0");
    await coordinator.putAttempt(attempt("x-1", "generation-0"));
    await coordinator.putAttempt(attempt("x-2", "generation-0"));
    const next = activation("a", "generation-a");
    const transition = permit(next, "x-1");

    await coordinator.reserveTransition(
      { generation: "generation-0", revision: 2 },
      transition,
      null,
      "null-source-x-1",
    );
    await coordinator.completeTransition(transition, credential(next), "null-source-x-1");

    const snapshot = await coordinator.readSnapshot();
    expect(snapshot.authority).toMatchObject({ mode: "active", generation: "generation-a" });
    expect(snapshot.attempts).toEqual([]);
  });

  it("linearizes retirement before purge and preserves a newer activation from a late logout", async () => {
    const coordinator = new AuthSessionCoordinator({ indexedDB: new IDBFactory() });
    await coordinator.bootstrapAnonymous("generation-0");
    const departing = activation("a", "generation-a");
    await activateAnonymous(coordinator, departing, "attempt-a");

    await expect(coordinator.beginRetirement(departing, "logout", "generation-1")).resolves.toBe("retired");
    await expect(coordinator.admitActivation(departing)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    await coordinator.markPurgeComplete(departing, "receipt-a");
    await expect(coordinator.markPurgeComplete(departing, "receipt-a")).resolves.toBeUndefined();
    await expect(coordinator.markPurgeComplete(departing, "different-receipt")).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });
    await coordinator.completeRetirement(departing, "receipt-a", "generation-2");

    const next = activation("b", "generation-b");
    await activateAnonymous(coordinator, next, "attempt-b");
    const beforeLateLogout = await coordinator.readSnapshot();

    await expect(coordinator.beginRetirement(departing, "logout", "generation-stale")).resolves.toBe("superseded");
    expect(await coordinator.readSnapshot()).toEqual(beforeLateLogout);
    await expect(coordinator.admitActivation(next)).resolves.toMatchObject({ accessToken: "access-epoch-b" });
  });

  it("reserves account replacement without persisting target credentials before source purge", async () => {
    const coordinator = new AuthSessionCoordinator({ indexedDB: new IDBFactory() });
    await coordinator.bootstrapAnonymous("generation-0");
    const departing = activation("a", "generation-a");
    await activateAnonymous(coordinator, departing, "attempt-a");

    const target = activation("b", "generation-b");
    const targetAttempt = attempt("attempt-b", "generation-a", departing.sessionEpoch);
    await coordinator.putAttempt(targetAttempt);
    const beforeReservation = await coordinator.readAuthority();
    const targetPermit = permit(target, targetAttempt.attemptId);
    await coordinator.reserveTransition(
      { generation: beforeReservation.generation, revision: beforeReservation.revision },
      targetPermit,
      departing,
    );

    const reserved = await coordinator.readSnapshot();
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

    await coordinator.markPurgeComplete(departing, "source-a-purged");
    await coordinator.completeTransition(targetPermit, credential(target), "source-a-purged");
    await expect(coordinator.admitActivation(target)).resolves.toMatchObject({ accessToken: "access-epoch-b" });
    await expect(coordinator.beginRetirement(departing, "logout", "generation-late")).resolves.toBe("superseded");
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

    await expect(coordinator.readSnapshot()).rejects.toMatchObject({ code: sessionErrorCodes.recoveryRequired });

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
