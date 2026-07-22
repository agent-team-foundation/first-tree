import {
  claimVerifiedCandidateProof,
  readVerifiedCandidateProof,
  type VerifiedCandidateProof,
} from "../../api/candidate-client.js";
import { createCandidateTokenSnapshot, fingerprintCandidateTokenSnapshot } from "./candidate-tokens.js";
import { claimVerifiedPurgeCompletion, type VerifiedPurgeCompletion } from "./content-barrier.js";
import { SessionError, sessionErrorCodes, toSessionError } from "./errors.js";
import { claimLegacyScrubCompletion, type LegacyScrubCompletion } from "./legacy-scrub.js";
import { createAccountScopeKey } from "./scope.js";
import {
  type AcquisitionSessionAttempt,
  type AcquisitionTransitionPermit,
  type ActivationCertificate,
  type ActiveAuthority,
  type AuthAuthority,
  type CoordinatorSnapshot,
  type CredentialCursor,
  type CredentialRecord,
  createCredentialRecord,
  credentialCursor,
  type RetirementCause,
  sameActivation,
  sameCredentialCursor,
  type ViewLease,
  validateAcquisitionTransitionPermit,
  validateActivationCertificate,
  validateCoordinatorSnapshot,
  validateCredentialCursor,
  validateCredentialRecord,
  validateSessionAttempt,
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

type CoordinatorPlanner<T> = (snapshot: CoordinatorSnapshot) => CoordinatorDecision<T>;

export type AuthorityCursor = Readonly<{
  generation: string;
  revision: number;
}>;

export type RetirementResult = "retired" | "already_retiring" | "superseded";

export type ActiveSessionProjection = Readonly<{
  authority: ActiveAuthority;
  credential: CredentialCursor;
}>;

const activeDispatchAdmissionBrand: unique symbol = Symbol("first-tree.active-dispatch-admission");

export type ActiveDispatchAdmission = Readonly<{
  kind: "active_dispatch";
  tokenKind: ActiveDispatchToken["kind"];
  activation: ActivationCertificate;
  credential: CredentialCursor;
  organizationId: string;
  orgRevision: string;
  ownerTabId: string;
  documentId: string;
  [activeDispatchAdmissionBrand]: true;
}>;

export type ActiveDispatch<T> = Readonly<{
  admission: ActiveDispatchAdmission;
  request: T;
}>;

export type ActiveDispatchToken =
  | Readonly<{ kind: "access"; token: string }>
  | Readonly<{ kind: "refresh"; token: string }>;

function validateActiveDispatchAdmission(value: unknown): ActiveDispatchAdmission {
  if (
    typeof value !== "object" ||
    value === null ||
    !(activeDispatchAdmissionBrand in value) ||
    (value as ActiveDispatchAdmission)[activeDispatchAdmissionBrand] !== true
  ) {
    throw new SessionError(sessionErrorCodes.invalidState, "Dispatch admission is malformed");
  }
  return value as ActiveDispatchAdmission;
}

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

function createVerifiedTransitionTarget(
  value: unknown,
  serverAuthority: string,
  accountId: string,
): ActivationCertificate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionError(sessionErrorCodes.invalidState, "Transition target metadata is malformed");
  }
  const metadata = value as Readonly<Record<string, unknown>>;
  return validateActivationCertificate({
    v: 1,
    sessionEpoch: metadata.sessionEpoch,
    authGeneration: metadata.authGeneration,
    transitionPermitId: metadata.transitionPermitId,
    serverAuthority,
    accountId,
    scopeKey: createAccountScopeKey(serverAuthority, accountId),
  });
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
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Auth coordinator transaction was cancelled");
  }
  const lifecycleGeneration = coordinatorLifecycleGeneration;
  const database = await openCoordinatorDatabase(factory, onBlocked);
  if (signal?.aborted || lifecycleGeneration !== coordinatorLifecycleGeneration) {
    closeCoordinatorDatabase(database);
    throw new SessionError(sessionErrorCodes.staleOperation, "Auth coordinator transaction crossed a lifecycle fence");
  }
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

    const abortForSignal = (): void => {
      failure = new SessionError(sessionErrorCodes.staleOperation, "Auth coordinator transaction was cancelled");
      try {
        transaction.abort();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "InvalidStateError")) failure = error;
      }
    };
    signal?.addEventListener("abort", abortForSignal, { once: true });

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
      signal?.removeEventListener("abort", abortForSignal);
      if (signal?.aborted || lifecycleGeneration !== coordinatorLifecycleGeneration) {
        reject(new SessionError(sessionErrorCodes.staleOperation, "Auth coordinator result crossed a lifecycle fence"));
        return;
      }
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
      signal?.removeEventListener("abort", abortForSignal);
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

function keepCoordinatorSnapshot<T>(value: T): CoordinatorDecision<T> {
  return Object.freeze({ kind: "unchanged", value });
}

function replaceCoordinatorSnapshot<T>(snapshot: CoordinatorSnapshot, value: T): CoordinatorDecision<T> {
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

function sameTransitionPermit(left: AcquisitionTransitionPermit, right: AcquisitionTransitionPermit): boolean {
  return (
    left.kind === right.kind &&
    left.permitId === right.permitId &&
    left.attemptId === right.attemptId &&
    left.targetCredentialFingerprint === right.targetCredentialFingerprint &&
    left.expiresAt === right.expiresAt &&
    sameActivation(left.target, right.target)
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]))
  );
}

function sameAcquisitionAttempt(left: AcquisitionSessionAttempt, right: AcquisitionSessionAttempt): boolean {
  return (
    left.v === right.v &&
    left.kind === right.kind &&
    left.attemptId === right.attemptId &&
    left.serverAuthority === right.serverAuthority &&
    left.baselineGeneration === right.baselineGeneration &&
    left.sourceEpoch === right.sourceEpoch &&
    left.expiresAt === right.expiresAt &&
    sameJsonValue(left.payload, right.payload)
  );
}

function activeProjection(snapshot: CoordinatorSnapshot, activation?: ActivationCertificate): ActiveSessionProjection {
  const authority = snapshot.authority;
  if (authority.mode !== "active" || (activation && !sameActivation(authority.session, activation))) {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Captured activation is no longer authoritative");
  }
  const credential = matchingCredential(snapshot, authority.session);
  if (!credential) throw invariantFailure("Active activation does not own its exact credential");
  return Object.freeze({ authority, credential: credentialCursor(credential) });
}

function sameCredentialRecord(left: CredentialRecord, right: CredentialRecord): boolean {
  return (
    sameActivation(left.activation, right.activation) &&
    left.sessionEpoch === right.sessionEpoch &&
    left.credentialRevision === right.credentialRevision &&
    left.credentialFingerprint === right.credentialFingerprint &&
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken
  );
}

async function verifyCredentialBytes(record: CredentialRecord): Promise<void> {
  let snapshot: ReturnType<typeof createCandidateTokenSnapshot>;
  try {
    snapshot = createCandidateTokenSnapshot({
      accessToken: record.accessToken,
      refreshToken: record.refreshToken,
    });
  } catch {
    throw invariantFailure("Persisted credential pair is structurally invalid");
  }
  if (snapshot.accountIdCandidate !== record.activation.accountId) {
    throw invariantFailure("Persisted credential subject does not match its activation");
  }
  const fingerprinted = await fingerprintCandidateTokenSnapshot(snapshot, record.activation.serverAuthority);
  if (fingerprinted.credentialFingerprint !== record.credentialFingerprint) {
    throw invariantFailure("Persisted credential bytes do not match their fingerprint");
  }
}

function sameView(left: ViewLease, right: ViewLease): boolean {
  return (
    sameActivation(left.activation, right.activation) &&
    left.organizationId === right.organizationId &&
    left.orgRevision === right.orgRevision &&
    left.ownerTabId === right.ownerTabId &&
    left.documentId === right.documentId &&
    left.signal === right.signal
  );
}

export class AuthSessionCoordinator {
  private readonly factory: IDBFactory;
  private readonly onBlocked: ((databaseName: string) => void) | undefined;

  public constructor(options: CoordinatorOptions = {}) {
    this.factory = getIndexedDbFactory(options.indexedDB);
    this.onBlocked = options.onBlocked;
  }

  private async captureVerifiedCredential(
    activation?: ActivationCertificate,
    signal?: AbortSignal,
  ): Promise<CredentialRecord> {
    const captured = await executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<CredentialRecord> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        const projection = activeProjection(snapshot, activation);
        const record = matchingCredential(snapshot, projection.authority.session);
        if (!record) throw invariantFailure("Active activation does not own its exact credential");
        return keepCoordinatorSnapshot(record);
      },
      signal,
    );
    await verifyCredentialBytes(captured);
    if (signal?.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Credential verification crossed a lifecycle fence");
    }
    return captured;
  }

  private async finishCredentialAdmission(
    captured: CredentialRecord,
    activation?: ActivationCertificate,
    signal?: AbortSignal,
  ): Promise<ActiveSessionProjection> {
    return executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<ActiveSessionProjection> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        const projection = activeProjection(snapshot, activation ?? captured.activation);
        const current = matchingCredential(snapshot, projection.authority.session);
        if (!current || !sameCredentialRecord(current, captured)) {
          throw new SessionError(sessionErrorCodes.admissionDenied, "Credential changed during admission");
        }
        return keepCoordinatorSnapshot(projection);
      },
      signal,
    );
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

  public async readAuthority(): Promise<AuthAuthority> {
    return executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<AuthAuthority> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        return keepCoordinatorSnapshot(snapshot.authority);
      },
    );
  }

  public async readActiveSession(): Promise<ActiveSessionProjection> {
    const captured = await this.captureVerifiedCredential();
    return this.finishCredentialAdmission(captured);
  }

  /**
   * Runs a synchronous planner over one fresh, overlapping authority/credentials/attempts transaction.
   * The returned promise resolves only after the transaction's `complete` event.
   */
  private async commit<T>(planner: CoordinatorPlanner<T>, signal?: AbortSignal): Promise<T> {
    return executeCoordinatorTransaction(
      this.factory,
      "readwrite",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<T> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        return planner(snapshot);
      },
      signal,
    );
  }

  public async admitActivation(activationValue: unknown): Promise<ActiveSessionProjection> {
    const activation = validateActivationCertificate(activationValue);
    const captured = await this.captureVerifiedCredential(activation);
    return this.finishCredentialAdmission(captured, activation);
  }

  public async admitView(viewValue: unknown): Promise<ActiveSessionProjection> {
    const view = validateViewLease(viewValue);
    if (view.signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Captured view has been invalidated");
    }
    const captured = await this.captureVerifiedCredential(view.activation, view.signal);
    const projection = await this.finishCredentialAdmission(captured, view.activation, view.signal);
    if (view.signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Captured view was invalidated during admission");
    }
    return projection;
  }

  /**
   * Orders dispatch behind every earlier retirement writer. `start` is called
   * synchronously while the fresh readonly authority transaction is live; its
   * return value is deliberately wrapped so a network promise is never awaited
   * from inside IndexedDB.
   */
  public async startActiveDispatch<T>(
    viewValue: unknown,
    expectedCredentialValue: unknown,
    tokenKind: ActiveDispatchToken["kind"],
    start: (credential: ActiveDispatchToken) => T,
  ): Promise<ActiveDispatch<T>> {
    const view = validateViewLease(viewValue);
    const expectedCredential = validateCredentialCursor(expectedCredentialValue);
    if (tokenKind !== "access" && tokenKind !== "refresh") {
      throw new SessionError(sessionErrorCodes.invalidState, "Dispatch token kind is unsupported");
    }
    if (view.signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Captured view has been invalidated");
    }
    const captured = await this.captureVerifiedCredential(view.activation, view.signal);
    if (!sameCredentialCursor(credentialCursor(captured), expectedCredential)) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Captured credential revision is stale");
    }

    return executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<ActiveDispatch<T>> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        if (view.signal.aborted) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Captured view has been invalidated");
        }
        const projection = activeProjection(snapshot, view.activation);
        if (!sameCredentialCursor(projection.credential, expectedCredential)) {
          throw new SessionError(sessionErrorCodes.admissionDenied, "Captured credential revision is stale");
        }
        const record = matchingCredential(snapshot, view.activation);
        if (!record) throw invariantFailure("Active activation does not own its exact credential");
        if (!sameCredentialRecord(record, captured)) {
          throw new SessionError(sessionErrorCodes.admissionDenied, "Credential changed before dispatch");
        }
        const token: ActiveDispatchToken = Object.freeze(
          tokenKind === "access"
            ? { kind: "access" as const, token: record.accessToken }
            : { kind: "refresh" as const, token: record.refreshToken },
        );
        const request = start(token);
        if (view.signal.aborted) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Captured view was invalidated during dispatch");
        }
        const admission: ActiveDispatchAdmission = Object.freeze({
          kind: "active_dispatch",
          tokenKind,
          activation: view.activation,
          credential: projection.credential,
          organizationId: view.organizationId,
          orgRevision: view.orgRevision,
          ownerTabId: view.ownerTabId,
          documentId: view.documentId,
          [activeDispatchAdmissionBrand]: true as const,
        });
        return keepCoordinatorSnapshot(Object.freeze({ admission, request }));
      },
      view.signal,
    );
  }

  /** Fresh post-response authority gate. It intentionally tolerates a routine credential rotation. */
  public async assertActiveDispatchResponse(admissionValue: unknown, viewValue: unknown): Promise<void> {
    const admission = validateActiveDispatchAdmission(admissionValue);
    const view = validateViewLease(viewValue);
    if (
      view.signal.aborted ||
      !sameView(view, {
        activation: admission.activation,
        organizationId: admission.organizationId,
        orgRevision: admission.orgRevision,
        ownerTabId: admission.ownerTabId,
        documentId: admission.documentId,
        signal: view.signal,
      })
    ) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Dispatch view is no longer current");
    }
    await this.admitView(view);
    if (view.signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Dispatch view was invalidated after authority check");
    }
  }

  /** Exact credential revision CAS that preserves the activation and every view lease. */
  public async replaceActiveCredential(
    admissionValue: unknown,
    viewValue: unknown,
    replacementValue: unknown,
  ): Promise<CredentialCursor> {
    const admission = validateActiveDispatchAdmission(admissionValue);
    const view = validateViewLease(viewValue);
    if (admission.tokenKind !== "refresh") {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Only an admitted refresh may replace credentials");
    }
    if (
      view.signal.aborted ||
      !sameActivation(view.activation, admission.activation) ||
      view.organizationId !== admission.organizationId ||
      view.orgRevision !== admission.orgRevision ||
      view.ownerTabId !== admission.ownerTabId ||
      view.documentId !== admission.documentId
    ) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Refresh delivery view is no longer current");
    }
    await this.assertActiveDispatchResponse(admission, view);
    const activation = admission.activation;
    const expectedCredential = admission.credential;
    const replacement = validateCredentialRecord(replacementValue);
    if (
      !sameActivation(replacement.activation, activation) ||
      replacement.sessionEpoch !== activation.sessionEpoch ||
      replacement.credentialRevision !== expectedCredential.credentialRevision + 1
    ) {
      throw new SessionError(sessionErrorCodes.invalidState, "Replacement credential does not advance this activation");
    }
    await verifyCredentialBytes(replacement);
    if (view.signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Refresh delivery view was invalidated while verifying");
    }
    const captured = await this.captureVerifiedCredential(activation, view.signal);
    if (!sameCredentialCursor(credentialCursor(captured), expectedCredential)) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Credential changed before refresh verification");
    }

    return this.commit((snapshot): CoordinatorDecision<CredentialCursor> => {
      if (view.signal.aborted) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Refresh delivery view was invalidated before commit");
      }
      const projection = activeProjection(snapshot, activation);
      if (!sameCredentialCursor(projection.credential, expectedCredential)) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Credential changed before refresh commit");
      }
      const current = matchingCredential(snapshot, activation);
      if (!current) throw invariantFailure("Active activation does not own its exact credential");
      if (!sameCredentialRecord(current, captured)) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Credential changed before refresh commit");
      }
      const nextAuthority: ActiveAuthority = {
        ...projection.authority,
        revision: projection.authority.revision + 1,
      };
      const nextCredential = credentialCursor(replacement);
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, nextAuthority, [replacement]), nextCredential);
    }, view.signal);
  }

  public async reserveAcquisitionTransition(
    expected: AuthorityCursor,
    proofValue: VerifiedCandidateProof,
    targetValue: unknown,
    sourceValue: unknown | null,
    anonymousScrubValue?: LegacyScrubCompletion,
    now = Date.now(),
  ): Promise<AcquisitionTransitionPermit> {
    let evidence: ReturnType<typeof readVerifiedCandidateProof>;
    try {
      evidence = readVerifiedCandidateProof(proofValue);
    } catch {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Verified candidate proof is unavailable");
    }
    const target = createVerifiedTransitionTarget(targetValue, evidence.serverAuthority, evidence.accountId);
    const source = sourceValue === null ? null : validateActivationCertificate(sourceValue);
    let scrubClaim: ReturnType<typeof claimLegacyScrubCompletion> | undefined;
    if (source === null) {
      try {
        scrubClaim = claimLegacyScrubCompletion(anonymousScrubValue);
      } catch {
        throw new SessionError(
          sessionErrorCodes.admissionDenied,
          "Verified legacy scrub is required before activation",
        );
      }
    } else if (anonymousScrubValue !== undefined) {
      throw new SessionError(sessionErrorCodes.invalidState, "Account replacement cannot consume an anonymous scrub");
    }
    const cleanupReceipt = scrubClaim?.receipt;
    if (
      target.serverAuthority !== evidence.serverAuthority ||
      target.accountId !== evidence.accountId ||
      target.accountId !== evidence.candidate.accountIdCandidate ||
      evidence.attempt.sourceEpoch !== (source?.sessionEpoch ?? null)
    ) {
      throw new SessionError(
        sessionErrorCodes.admissionDenied,
        "Verified candidate does not match the transition target",
      );
    }
    const permit = validateAcquisitionTransitionPermit({
      v: 1,
      kind: "acquisition_transition",
      permitId: target.transitionPermitId,
      attemptId: evidence.attempt.attemptId,
      target,
      targetCredentialFingerprint: evidence.candidate.credentialFingerprint,
      expiresAt: Math.min(
        evidence.attempt.expiresAt,
        evidence.candidate.accessExpiresAt,
        evidence.candidate.refreshExpiresAt,
      ),
    });
    if (permit.expiresAt <= now) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Verified candidate is expired");
    }

    let committed = false;
    try {
      const result = await this.commit((snapshot): CoordinatorDecision<AcquisitionTransitionPermit> => {
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
          attempt.kind !== "acquisition" ||
          !sameAcquisitionAttempt(attempt, evidence.attempt) ||
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
        return replaceCoordinatorSnapshot(nextSnapshot(snapshot, transition, [], [attempt]), permit);
      });
      committed = true;
      return result;
    } finally {
      scrubClaim?.settle(committed);
    }
  }

  public async completeAcquisitionTransition(
    permitValue: unknown,
    proofValue: VerifiedCandidateProof,
    cleanupReceiptValue?: string,
    now = Date.now(),
  ): Promise<void> {
    const permit = validateAcquisitionTransitionPermit(permitValue);
    const cleanupReceipt = cleanupReceiptValue === undefined ? undefined : requireCleanupReceipt(cleanupReceiptValue);
    let proofClaim: ReturnType<typeof claimVerifiedCandidateProof>;
    try {
      proofClaim = claimVerifiedCandidateProof(proofValue);
    } catch {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Verified candidate proof is unavailable");
    }
    const evidence = proofClaim.evidence;
    const credential = createCredentialRecord({
      activation: permit.target,
      credentialRevision: 0,
      credentialFingerprint: evidence.candidate.credentialFingerprint,
      accessToken: evidence.candidate.accessToken,
      refreshToken: evidence.candidate.refreshToken,
    });
    let committed = false;
    try {
      if (
        permit.targetCredentialFingerprint !== credential.credentialFingerprint ||
        evidence.serverAuthority !== permit.target.serverAuthority ||
        evidence.accountId !== permit.target.accountId ||
        evidence.candidate.accountIdCandidate !== permit.target.accountId ||
        evidence.attempt.attemptId !== permit.attemptId ||
        evidence.candidate.credentialFingerprint !== permit.targetCredentialFingerprint ||
        permit.expiresAt !==
          Math.min(evidence.attempt.expiresAt, evidence.candidate.accessExpiresAt, evidence.candidate.refreshExpiresAt)
      ) {
        throw new SessionError(sessionErrorCodes.invalidState, "Transition credential does not match its target");
      }
      await verifyCredentialBytes(credential);

      await this.commit((snapshot): CoordinatorDecision<void> => {
        const authority = snapshot.authority;
        if (
          authority.mode !== "transition" ||
          !sameTransitionPermit(authority.permit, permit) ||
          authority.phase !== "source_purged" ||
          (authority.source === null
            ? cleanupReceipt !== undefined
            : cleanupReceipt === undefined || authority.cleanupReceipt !== cleanupReceipt) ||
          authority.generation !== permit.target.authGeneration ||
          permit.expiresAt <= now
        ) {
          throw new SessionError(sessionErrorCodes.admissionDenied, "Transition is not ready for activation");
        }
        const attempt = snapshot.attempts.find((item) => item.attemptId === permit.attemptId);
        if (
          !attempt ||
          attempt.kind !== "acquisition" ||
          !sameAcquisitionAttempt(attempt, evidence.attempt) ||
          attempt.expiresAt <= now ||
          attempt.serverAuthority !== permit.target.serverAuthority
        ) {
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
      committed = true;
    } finally {
      proofClaim.settle(committed);
    }
  }

  public async beginRetirement(
    capturedValue: unknown,
    cause: Exclude<RetirementCause, "owned_401">,
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

  public async beginOwned401Retirement(
    admissionValue: unknown,
    viewValue: unknown,
    nextGeneration: string,
  ): Promise<RetirementResult> {
    const admission = validateActiveDispatchAdmission(admissionValue);
    const view = validateViewLease(viewValue);
    const generation = requireGeneration(nextGeneration);
    if (
      view.signal.aborted ||
      !sameActivation(view.activation, admission.activation) ||
      view.organizationId !== admission.organizationId ||
      view.orgRevision !== admission.orgRevision ||
      view.ownerTabId !== admission.ownerTabId ||
      view.documentId !== admission.documentId
    ) {
      return "superseded";
    }

    return this.commit((snapshot): CoordinatorDecision<RetirementResult> => {
      if (view.signal.aborted) return keepCoordinatorSnapshot("superseded");
      const authority = snapshot.authority;
      if (authority.mode !== "active" || !sameActivation(authority.session, admission.activation)) {
        return keepCoordinatorSnapshot("superseded");
      }
      const credential = matchingCredential(snapshot, admission.activation);
      if (!credential || !sameCredentialCursor(credentialCursor(credential), admission.credential)) {
        return keepCoordinatorSnapshot("superseded");
      }
      if (generation === authority.generation || generation === admission.activation.authGeneration) {
        throw new SessionError(sessionErrorCodes.invalidState, "Retirement must rotate the auth generation");
      }
      const retiring: AuthAuthority = {
        v: 6,
        mode: "retiring",
        generation,
        revision: authority.revision + 1,
        source: admission.activation,
        cause: "owned_401",
        phase: "revoked",
      };
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, retiring, [], []), "retired");
    });
  }

  public async assertPurgeSource(capturedValue: unknown, signal?: AbortSignal): Promise<AuthAuthority> {
    const captured = validateActivationCertificate(capturedValue);
    return executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<AuthAuthority> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        const authority = snapshot.authority;
        if (authority.mode === "retiring" && sameActivation(authority.source, captured)) {
          return keepCoordinatorSnapshot(authority);
        }
        if (authority.mode === "transition" && authority.source && sameActivation(authority.source, captured)) {
          return keepCoordinatorSnapshot(authority);
        }
        throw new SessionError(sessionErrorCodes.admissionDenied, "Captured activation does not own a pending purge");
      },
      signal,
    );
  }

  public async commitVerifiedPurge(completionValue: VerifiedPurgeCompletion): Promise<string> {
    const claim = claimVerifiedPurgeCompletion(completionValue);
    const captured = validateActivationCertificate(claim.source);
    const receipt = requireCleanupReceipt(claim.receipt);
    try {
      await executeCoordinatorTransaction(
        this.factory,
        "readwrite",
        false,
        this.onBlocked,
        (snapshot): CoordinatorDecision<void> => {
          if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
          if (claim.signal.aborted) {
            throw new SessionError(sessionErrorCodes.staleOperation, "Verified purge crossed a lifecycle fence");
          }
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
        },
        claim.signal,
      );
      claim.settle(true);
      return receipt;
    } catch (error) {
      claim.settle(false);
      throw error;
    }
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
