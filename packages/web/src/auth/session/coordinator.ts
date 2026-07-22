import { SessionError, sessionErrorCodes, toSessionError } from "./errors.js";
import {
  type ActivationCertificate,
  type AuthAuthority,
  type CoordinatorSnapshot,
  type CredentialRecord,
  type RetirementCause,
  sameActivation,
  type TransitionPermit,
  validateActivationCertificate,
  validateCoordinatorSnapshot,
  validateCredentialRecord,
  validateSessionAttempt,
  validateTransitionPermit,
  validateViewLease,
} from "./types.js";

export const AUTH_COORDINATOR_DATABASE_NAME = "first-tree-auth-coordinator:v1";

const COORDINATOR_DATABASE_VERSION = 1;
const AUTHORITY_STORE = "authority";
const CREDENTIALS_STORE = "credentials";
const ATTEMPTS_STORE = "attempts";
const AUTHORITY_KEY = "head";
const ALL_STORES = [AUTHORITY_STORE, CREDENTIALS_STORE, ATTEMPTS_STORE] as const;

type AuthorityRow = Readonly<{
  key: typeof AUTHORITY_KEY;
  authority: AuthAuthority;
}>;

type CoordinatorDecision<T> =
  | Readonly<{ kind: "unchanged"; value: T }>
  | Readonly<{ kind: "commit"; snapshot: CoordinatorSnapshot; value: T }>;

export type CoordinatorPlanner<T> = (snapshot: CoordinatorSnapshot) => CoordinatorDecision<T>;

export type AuthorityCursor = Readonly<{
  generation: string;
  revision: number;
}>;

export type RetirementResult = "retired" | "already_retiring" | "superseded";

export type CoordinatorOptions = Readonly<{
  indexedDB?: IDBFactory;
  onBlocked?: (databaseName: string) => void;
}>;

const coordinatorConnections = new Set<IDBDatabase>();
let coordinatorLifecycleGeneration = 0;

function invariantFailure(message: string): SessionError {
  return new SessionError(sessionErrorCodes.recoveryRequired, message);
}

function requireGeneration(generation: string): string {
  if (generation.length === 0 || generation.length > 512) {
    throw new SessionError(sessionErrorCodes.invalidState, "Auth generation must be a non-empty bounded string");
  }
  return generation;
}

function requireCleanupReceipt(receipt: string): string {
  if (receipt.length === 0 || receipt.length > 2048) {
    throw new SessionError(sessionErrorCodes.invalidState, "Cleanup receipt must be a non-empty bounded string");
  }
  return receipt;
}

function getIndexedDbFactory(explicitFactory?: IDBFactory): IDBFactory {
  if (explicitFactory) return explicitFactory;
  if (typeof indexedDB === "undefined") {
    throw new SessionError(
      sessionErrorCodes.persistenceUnavailable,
      "IndexedDB is required for authenticated sessions",
    );
  }
  return indexedDB;
}

function openCoordinatorDatabase(
  factory: IDBFactory,
  onBlocked?: (databaseName: string) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const lifecycleGeneration = coordinatorLifecycleGeneration;
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(AUTH_COORDINATOR_DATABASE_NAME, COORDINATOR_DATABASE_VERSION);
    } catch (error) {
      reject(toSessionError(error, sessionErrorCodes.persistenceUnavailable, "Auth coordinator could not be opened"));
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (lifecycleGeneration !== coordinatorLifecycleGeneration) {
        request.transaction?.abort();
        database.close();
        return;
      }
      if (!database.objectStoreNames.contains(AUTHORITY_STORE)) {
        database.createObjectStore(AUTHORITY_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(CREDENTIALS_STORE)) {
        database.createObjectStore(CREDENTIALS_STORE, { keyPath: "sessionEpoch" });
      }
      if (!database.objectStoreNames.contains(ATTEMPTS_STORE)) {
        database.createObjectStore(ATTEMPTS_STORE, { keyPath: "attemptId" });
      }
    };
    request.onblocked = () => onBlocked?.(AUTH_COORDINATOR_DATABASE_NAME);
    request.onerror = () => {
      reject(
        toSessionError(request.error, sessionErrorCodes.persistenceUnavailable, "Auth coordinator open request failed"),
      );
    };
    request.onsuccess = () => {
      const database = request.result;
      if (lifecycleGeneration !== coordinatorLifecycleGeneration) {
        database.close();
        reject(new SessionError(sessionErrorCodes.staleOperation, "Auth coordinator open was cancelled by lifecycle"));
        return;
      }
      coordinatorConnections.add(database);
      database.onversionchange = () => {
        database.close();
        coordinatorConnections.delete(database);
      };
      resolve(database);
    };
  });
}

function openTransaction(database: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
  if (mode === "readonly") return database.transaction(ALL_STORES, mode);
  try {
    return database.transaction(ALL_STORES, mode, { durability: "strict" });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return database.transaction(ALL_STORES, mode);
  }
}

function closeCoordinatorDatabase(database: IDBDatabase): void {
  database.close();
  coordinatorConnections.delete(database);
}

function parseSnapshot(
  authorityValue: unknown,
  credentialsValue: unknown,
  attemptsValue: unknown,
  allowMissingAuthority: boolean,
): CoordinatorSnapshot | null {
  if (!Array.isArray(credentialsValue) || !Array.isArray(attemptsValue)) {
    throw invariantFailure("Auth coordinator stores are malformed");
  }

  let authority: AuthAuthority | null;
  if (authorityValue === undefined) {
    authority = null;
  } else if (
    typeof authorityValue === "object" &&
    authorityValue !== null &&
    !Array.isArray(authorityValue) &&
    "key" in authorityValue &&
    authorityValue.key === AUTHORITY_KEY &&
    "authority" in authorityValue
  ) {
    authority = authorityValue.authority as AuthAuthority;
  } else {
    throw invariantFailure("Auth coordinator authority row is malformed");
  }

  if (authority === null) {
    if (credentialsValue.length !== 0 || attemptsValue.length !== 0 || !allowMissingAuthority) {
      throw invariantFailure("Auth coordinator authority is missing");
    }
    return null;
  }
  return validateCoordinatorSnapshot({ authority, credentials: credentialsValue, attempts: attemptsValue });
}

function assertNextSnapshot(current: CoordinatorSnapshot | null, next: CoordinatorSnapshot): CoordinatorSnapshot {
  const validated = validateCoordinatorSnapshot(next);
  if (current === null) {
    if (validated.authority.revision !== 0) {
      throw invariantFailure("Initial auth authority revision must be zero");
    }
  } else if (validated.authority.revision !== current.authority.revision + 1) {
    throw invariantFailure("Every coordinator mutation must advance the authority revision exactly once");
  }
  return validated;
}

function applySnapshot(transaction: IDBTransaction, snapshot: CoordinatorSnapshot): void {
  const authorityStore = transaction.objectStore(AUTHORITY_STORE);
  const credentialsStore = transaction.objectStore(CREDENTIALS_STORE);
  const attemptsStore = transaction.objectStore(ATTEMPTS_STORE);

  authorityStore.clear();
  credentialsStore.clear();
  attemptsStore.clear();
  const authorityRow: AuthorityRow = { key: AUTHORITY_KEY, authority: snapshot.authority };
  authorityStore.put(authorityRow);
  for (const credential of snapshot.credentials) credentialsStore.put(credential);
  for (const attempt of snapshot.attempts) attemptsStore.put(attempt);
}

async function executeCoordinatorTransaction<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  allowMissingAuthority: boolean,
  onBlocked: ((databaseName: string) => void) | undefined,
  planner: (snapshot: CoordinatorSnapshot | null) => CoordinatorDecision<T>,
): Promise<T> {
  const database = await openCoordinatorDatabase(factory, onBlocked);
  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = openTransaction(database, mode);
    } catch (error) {
      closeCoordinatorDatabase(database);
      reject(
        toSessionError(error, sessionErrorCodes.persistenceUnavailable, "Auth coordinator transaction failed to start"),
      );
      return;
    }

    let failure: unknown;
    let plannedValue: T | undefined;
    let hasPlannedValue = false;
    let completedRequests = 0;

    const authorityRequest = transaction.objectStore(AUTHORITY_STORE).get(AUTHORITY_KEY);
    const credentialsRequest = transaction.objectStore(CREDENTIALS_STORE).getAll();
    const attemptsRequest = transaction.objectStore(ATTEMPTS_STORE).getAll();

    const abortWith = (error: unknown): void => {
      failure = error;
      try {
        transaction.abort();
      } catch (abortError) {
        failure = failure ?? abortError;
      }
    };

    const planWhenReady = (): void => {
      completedRequests += 1;
      if (completedRequests !== 3 || failure !== undefined) return;
      try {
        const authorityValue: unknown = authorityRequest.result;
        const credentialsValue: unknown = credentialsRequest.result;
        const attemptsValue: unknown = attemptsRequest.result;
        const current = parseSnapshot(authorityValue, credentialsValue, attemptsValue, allowMissingAuthority);
        const decision = planner(current);
        if (decision.kind !== "unchanged" && decision.kind !== "commit") {
          throw invariantFailure("Auth coordinator planner returned an unsupported decision");
        }
        plannedValue = decision.value;
        hasPlannedValue = true;
        if (decision.kind === "commit") {
          if (mode !== "readwrite") throw invariantFailure("Readonly coordinator transaction cannot mutate state");
          applySnapshot(transaction, assertNextSnapshot(current, decision.snapshot));
        }
      } catch (error) {
        abortWith(error);
      }
    };

    const recordRequestFailure = (request: IDBRequest): void => {
      failure = request.error ?? invariantFailure("Auth coordinator request failed");
    };
    authorityRequest.onsuccess = planWhenReady;
    credentialsRequest.onsuccess = planWhenReady;
    attemptsRequest.onsuccess = planWhenReady;
    authorityRequest.onerror = () => recordRequestFailure(authorityRequest);
    credentialsRequest.onerror = () => recordRequestFailure(credentialsRequest);
    attemptsRequest.onerror = () => recordRequestFailure(attemptsRequest);

    transaction.oncomplete = () => {
      closeCoordinatorDatabase(database);
      if (!hasPlannedValue) {
        reject(invariantFailure("Auth coordinator transaction completed without a decision"));
        return;
      }
      resolve(plannedValue as T);
    };
    transaction.onerror = () => {
      failure = failure ?? transaction.error ?? invariantFailure("Auth coordinator transaction failed");
    };
    transaction.onabort = () => {
      closeCoordinatorDatabase(database);
      reject(
        toSessionError(
          failure ?? transaction.error,
          sessionErrorCodes.persistenceUnavailable,
          "Auth coordinator transaction did not commit",
        ),
      );
    };
  });
}

export function keepCoordinatorSnapshot<T>(value: T): CoordinatorDecision<T> {
  return Object.freeze({ kind: "unchanged", value });
}

export function replaceCoordinatorSnapshot<T>(snapshot: CoordinatorSnapshot, value: T): CoordinatorDecision<T> {
  return Object.freeze({ kind: "commit", snapshot, value });
}

export function closeCoordinatorConnections(): void {
  coordinatorLifecycleGeneration += 1;
  for (const database of coordinatorConnections) database.close();
  coordinatorConnections.clear();
}

function nextSnapshot(
  current: CoordinatorSnapshot,
  authority: AuthAuthority,
  credentials = current.credentials,
  attempts = current.attempts,
): CoordinatorSnapshot {
  return { authority, credentials, attempts };
}

function matchingCredential(snapshot: CoordinatorSnapshot, activation: ActivationCertificate): CredentialRecord | null {
  const credential = snapshot.credentials.find((item) => item.sessionEpoch === activation.sessionEpoch);
  if (!credential || !sameActivation(credential.activation, activation)) return null;
  return credential;
}

function sameTransitionPermit(left: TransitionPermit, right: TransitionPermit): boolean {
  return (
    left.permitId === right.permitId &&
    left.attemptId === right.attemptId &&
    left.expiresAt === right.expiresAt &&
    sameActivation(left.target, right.target)
  );
}

export class AuthSessionCoordinator {
  private readonly factory: IDBFactory;
  private readonly onBlocked: ((databaseName: string) => void) | undefined;

  public constructor(options: CoordinatorOptions = {}) {
    this.factory = getIndexedDbFactory(options.indexedDB);
    this.onBlocked = options.onBlocked;
  }

  public async bootstrapAnonymous(generation: string): Promise<AuthAuthority> {
    const initialGeneration = requireGeneration(generation);
    return executeCoordinatorTransaction(
      this.factory,
      "readwrite",
      true,
      this.onBlocked,
      (snapshot): CoordinatorDecision<AuthAuthority> => {
        if (snapshot !== null) return keepCoordinatorSnapshot(snapshot.authority);
        const authority: AuthAuthority = { v: 6, mode: "none", generation: initialGeneration, revision: 0 };
        return replaceCoordinatorSnapshot({ authority, credentials: [], attempts: [] }, authority);
      },
    );
  }

  public async readSnapshot(): Promise<CoordinatorSnapshot> {
    return executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<CoordinatorSnapshot> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        return keepCoordinatorSnapshot(snapshot);
      },
    );
  }

  public async readAuthority(): Promise<AuthAuthority> {
    return (await this.readSnapshot()).authority;
  }

  /**
   * Runs a synchronous planner over one fresh, overlapping authority/credentials/attempts transaction.
   * The returned promise resolves only after the transaction's `complete` event.
   */
  public async commit<T>(planner: CoordinatorPlanner<T>): Promise<T> {
    return executeCoordinatorTransaction(
      this.factory,
      "readwrite",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<T> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        return planner(snapshot);
      },
    );
  }

  public async admitActivation(activationValue: unknown): Promise<CredentialRecord> {
    const activation = validateActivationCertificate(activationValue);
    const snapshot = await this.readSnapshot();
    if (snapshot.authority.mode !== "active" || !sameActivation(snapshot.authority.session, activation)) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Captured activation is no longer authoritative");
    }
    const credential = matchingCredential(snapshot, activation);
    if (!credential) throw invariantFailure("Active activation does not own its exact credential");
    return credential;
  }

  public async admitView(viewValue: unknown): Promise<CredentialRecord> {
    const view = validateViewLease(viewValue);
    if (view.signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Captured view has been invalidated");
    }
    return this.admitActivation(view.activation);
  }

  public async reserveTransition(
    expected: AuthorityCursor,
    permitValue: unknown,
    sourceValue: unknown | null,
    nullSourceReceipt?: string,
    now = Date.now(),
  ): Promise<void> {
    const permit = validateTransitionPermit(permitValue);
    const source = sourceValue === null ? null : validateActivationCertificate(sourceValue);
    const cleanupReceipt = source === null ? requireCleanupReceipt(nullSourceReceipt ?? "") : undefined;

    await this.commit((snapshot): CoordinatorDecision<void> => {
      const authority = snapshot.authority;
      if (authority.generation !== expected.generation || authority.revision !== expected.revision) {
        throw new SessionError(
          sessionErrorCodes.admissionDenied,
          "Auth authority changed before transition reservation",
        );
      }
      const sourceMatches =
        source === null
          ? authority.mode === "none"
          : authority.mode === "active" && sameActivation(authority.session, source);
      if (!sourceMatches) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Transition source is no longer authoritative");
      }
      if (permit.target.authGeneration === authority.generation) {
        throw new SessionError(sessionErrorCodes.invalidState, "Transition must rotate the auth generation");
      }
      const attempt = snapshot.attempts.find((item) => item.attemptId === permit.attemptId);
      if (
        !attempt ||
        attempt.expiresAt <= now ||
        permit.expiresAt <= now ||
        attempt.baselineGeneration !== authority.generation ||
        attempt.serverAuthority !== permit.target.serverAuthority ||
        attempt.sourceEpoch !== (source?.sessionEpoch ?? null)
      ) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Transition attempt is missing, expired, or stale");
      }
      const transition: AuthAuthority = {
        v: 6,
        mode: "transition",
        generation: permit.target.authGeneration,
        revision: authority.revision + 1,
        permit,
        source,
        phase: source === null ? "source_purged" : "revoked",
        ...(cleanupReceipt === undefined ? {} : { cleanupReceipt }),
      };
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, transition, [], [attempt]), undefined);
    });
  }

  public async completeTransition(
    permitValue: unknown,
    credentialValue: unknown,
    cleanupReceiptValue: string,
    now = Date.now(),
  ): Promise<void> {
    const permit = validateTransitionPermit(permitValue);
    const credential = validateCredentialRecord(credentialValue);
    const cleanupReceipt = requireCleanupReceipt(cleanupReceiptValue);
    if (!sameActivation(permit.target, credential.activation)) {
      throw new SessionError(sessionErrorCodes.invalidState, "Transition credential does not match its target");
    }

    await this.commit((snapshot): CoordinatorDecision<void> => {
      const authority = snapshot.authority;
      if (
        authority.mode !== "transition" ||
        !sameTransitionPermit(authority.permit, permit) ||
        authority.phase !== "source_purged" ||
        authority.cleanupReceipt !== cleanupReceipt ||
        authority.generation !== permit.target.authGeneration ||
        permit.expiresAt <= now
      ) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Transition is not ready for activation");
      }
      const attempt = snapshot.attempts.find((item) => item.attemptId === permit.attemptId);
      if (!attempt || attempt.expiresAt <= now || attempt.serverAuthority !== permit.target.serverAuthority) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Transition attempt is missing, expired, or stale");
      }
      const active: AuthAuthority = {
        v: 6,
        mode: "active",
        generation: permit.target.authGeneration,
        revision: authority.revision + 1,
        session: permit.target,
      };
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, active, [credential], []), undefined);
    });
  }

  public async beginRetirement(
    capturedValue: unknown,
    cause: RetirementCause,
    nextGeneration: string,
  ): Promise<RetirementResult> {
    const captured = validateActivationCertificate(capturedValue);
    const generation = requireGeneration(nextGeneration);
    return this.commit((snapshot): CoordinatorDecision<RetirementResult> => {
      const authority = snapshot.authority;
      if (authority.mode === "retiring" && sameActivation(authority.source, captured)) {
        return keepCoordinatorSnapshot("already_retiring");
      }

      const ownsActive = authority.mode === "active" && sameActivation(authority.session, captured);
      const ownsTransition =
        cause === "logout" &&
        authority.mode === "transition" &&
        authority.source !== null &&
        sameActivation(authority.source, captured);
      if (!ownsActive && !ownsTransition) return keepCoordinatorSnapshot("superseded");
      if (generation === authority.generation || generation === captured.authGeneration) {
        throw new SessionError(sessionErrorCodes.invalidState, "Retirement must rotate the auth generation");
      }

      const retiring: AuthAuthority = {
        v: 6,
        mode: "retiring",
        generation,
        revision: authority.revision + 1,
        source: captured,
        cause,
        phase: "revoked",
      };
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, retiring, [], []), "retired");
    });
  }

  public async assertPurgeSource(capturedValue: unknown): Promise<AuthAuthority> {
    const captured = validateActivationCertificate(capturedValue);
    const authority = await this.readAuthority();
    if (authority.mode === "retiring" && sameActivation(authority.source, captured)) return authority;
    if (authority.mode === "transition" && authority.source && sameActivation(authority.source, captured)) {
      return authority;
    }
    throw new SessionError(sessionErrorCodes.admissionDenied, "Captured activation does not own a pending purge");
  }

  public async markPurgeComplete(capturedValue: unknown, receiptValue: string): Promise<void> {
    const captured = validateActivationCertificate(capturedValue);
    const receipt = requireCleanupReceipt(receiptValue);
    await this.commit((snapshot): CoordinatorDecision<void> => {
      const authority = snapshot.authority;
      if (authority.mode === "retiring" && sameActivation(authority.source, captured)) {
        if (authority.phase === "source_purged") {
          if (authority.cleanupReceipt === receipt) return keepCoordinatorSnapshot(undefined);
          throw new SessionError(sessionErrorCodes.admissionDenied, "Source purge receipt is already immutable");
        }
        const next: AuthAuthority = {
          ...authority,
          revision: authority.revision + 1,
          phase: "source_purged",
          cleanupReceipt: receipt,
        };
        return replaceCoordinatorSnapshot(nextSnapshot(snapshot, next), undefined);
      }
      if (authority.mode === "transition" && authority.source && sameActivation(authority.source, captured)) {
        if (authority.phase === "source_purged") {
          if (authority.cleanupReceipt === receipt) return keepCoordinatorSnapshot(undefined);
          throw new SessionError(sessionErrorCodes.admissionDenied, "Source purge receipt is already immutable");
        }
        const next: AuthAuthority = {
          ...authority,
          revision: authority.revision + 1,
          phase: "source_purged",
          cleanupReceipt: receipt,
        };
        return replaceCoordinatorSnapshot(nextSnapshot(snapshot, next), undefined);
      }
      throw new SessionError(sessionErrorCodes.admissionDenied, "Captured activation no longer owns the purge");
    });
  }

  public async completeRetirement(
    capturedValue: unknown,
    cleanupReceiptValue: string,
    anonymousGeneration: string,
  ): Promise<void> {
    const captured = validateActivationCertificate(capturedValue);
    const cleanupReceipt = requireCleanupReceipt(cleanupReceiptValue);
    const generation = requireGeneration(anonymousGeneration);
    await this.commit((snapshot): CoordinatorDecision<void> => {
      const authority = snapshot.authority;
      if (
        authority.mode !== "retiring" ||
        !sameActivation(authority.source, captured) ||
        authority.phase !== "source_purged" ||
        authority.cleanupReceipt !== cleanupReceipt
      ) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Retirement cleanup receipt is not authoritative");
      }
      if (generation === authority.generation || generation === captured.authGeneration) {
        throw new SessionError(
          sessionErrorCodes.invalidState,
          "Anonymous finalization must rotate the auth generation",
        );
      }
      const next: AuthAuthority = {
        v: 6,
        mode: "none",
        generation,
        revision: authority.revision + 1,
      };
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, next, [], []), undefined);
    });
  }

  public async putAttempt(attemptValue: unknown): Promise<void> {
    const attempt = validateSessionAttempt(attemptValue);
    await this.commit((snapshot): CoordinatorDecision<void> => {
      if (attempt.baselineGeneration !== snapshot.authority.generation) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Attempt baseline generation is stale");
      }
      const attempts = [...snapshot.attempts.filter((item) => item.attemptId !== attempt.attemptId), attempt];
      const authority = { ...snapshot.authority, revision: snapshot.authority.revision + 1 } as AuthAuthority;
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, authority, snapshot.credentials, attempts), undefined);
    });
  }

  public async deleteAttempt(attemptId: string): Promise<boolean> {
    if (attemptId.length === 0) {
      throw new SessionError(sessionErrorCodes.invalidState, "Attempt id must not be empty");
    }
    return this.commit((snapshot): CoordinatorDecision<boolean> => {
      if (!snapshot.attempts.some((attempt) => attempt.attemptId === attemptId)) {
        return keepCoordinatorSnapshot(false);
      }
      const authority = { ...snapshot.authority, revision: snapshot.authority.revision + 1 } as AuthAuthority;
      const attempts = snapshot.attempts.filter((attempt) => attempt.attemptId !== attemptId);
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, authority, snapshot.credentials, attempts), true);
    });
  }
}
