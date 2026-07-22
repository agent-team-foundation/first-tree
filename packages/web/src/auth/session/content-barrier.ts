import type { AuthSessionCoordinator } from "./coordinator.js";
import { SessionError, sessionErrorCodes, toSessionError } from "./errors.js";
import { deleteDatabaseBarrier } from "./idb-delete-barrier.js";
import { LEGACY_DATABASE_NAMES, type LegacyStorageAreas, scrubLegacyWebStorage } from "./legacy-scrub.js";
import { PERSISTENT_CONTENT_DATABASE_INVENTORY } from "./persistence-inventory.js";
import { createScopedDatabaseName } from "./scope.js";
import {
  type ActivationCertificate,
  type ViewLease,
  validateActivationCertificate,
  validateViewLease,
} from "./types.js";

export const CONTENT_SCOPE_LOCK_PREFIX = "first-tree:content-scope:v4:";

export type SessionLockMode = "shared" | "exclusive";

export type SessionLockOptions = Readonly<{
  mode: SessionLockMode;
  signal?: AbortSignal;
}>;

export type SessionLockManager = Readonly<{
  request<T>(name: string, options: SessionLockOptions, callback: () => T | PromiseLike<T>): Promise<T>;
}>;

export type ContentDatabaseSpec = Readonly<{
  logicalName: string;
  namespaceVersion: number;
  databaseVersion: number;
  upgrade: (database: IDBDatabase, oldVersion: number, newVersion: number | null, transaction: IDBTransaction) => void;
  onBlocked?: (databaseName: string) => void;
}>;

export type ContentBarrierOptions = Readonly<{
  coordinator: AuthSessionCoordinator;
  registry?: ContentDatabaseRegistry;
  indexedDB?: IDBFactory;
  locks?: SessionLockManager;
}>;

export type PurgeAccountScopeOptions = LegacyStorageAreas &
  Readonly<{
    onBlocked?: (databaseName: string) => void;
  }>;

const verifiedPurgeCompletionBrand: unique symbol = Symbol("first-tree.verified-purge-completion");

export type VerifiedPurgeCompletion = Readonly<{
  [verifiedPurgeCompletionBrand]: true;
}>;

type VerifiedPurgeState = {
  source: ActivationCertificate;
  receipt: string;
  signal: AbortSignal;
  state: "available" | "claimed" | "consumed" | "revoked";
};

const verifiedPurgeCompletions = new WeakMap<VerifiedPurgeCompletion, VerifiedPurgeState>();

export type VerifiedPurgeClaim = Readonly<{
  source: ActivationCertificate;
  receipt: string;
  signal: AbortSignal;
  settle: (committed: boolean) => void;
}>;

type OperationToken = {
  active: boolean;
  generation: number;
  lease: ViewLease;
  transactions: Set<IDBTransaction>;
  pendingOpenCount: number;
  cancelled: Promise<void>;
  resolveCancellation: () => void;
  abortListener: () => void;
};

type QueuedLockToken = Readonly<{
  generation: number;
  signal: AbortSignal;
  release: () => void;
}>;

type RegisteredHandle = Readonly<{
  database: IDBDatabase;
  scopeKey: string;
  sessionEpoch: string;
}>;

function staleOperation(message: string): SessionError {
  return new SessionError(sessionErrorCodes.staleOperation, message);
}

function getIndexedDbFactory(explicitFactory?: IDBFactory): IDBFactory {
  if (explicitFactory) return explicitFactory;
  if (typeof indexedDB === "undefined") {
    throw new SessionError(sessionErrorCodes.persistenceUnavailable, "IndexedDB is required for account content");
  }
  return indexedDB;
}

class BrowserSessionLockManager implements SessionLockManager {
  public request<T>(name: string, options: SessionLockOptions, callback: () => T | PromiseLike<T>): Promise<T> {
    if (typeof navigator === "undefined" || !navigator.locks) {
      return Promise.reject(
        new SessionError(sessionErrorCodes.platformUnavailable, "Web Locks are required for authenticated storage"),
      );
    }
    const browserOptions: LockOptions = { mode: options.mode };
    if (options.signal) browserOptions.signal = options.signal;
    // Web Locks adopts a thenable returned by the callback, although TypeScript's DOM
    // declaration models the callback as returning its generic directly.
    return navigator.locks.request(name, browserOptions, () => callback()) as Promise<T>;
  }
}

function getLockManager(explicitManager?: SessionLockManager): SessionLockManager {
  if (explicitManager) return explicitManager;
  if (typeof navigator === "undefined" || !navigator.locks) {
    throw new SessionError(sessionErrorCodes.platformUnavailable, "Web Locks are required for authenticated storage");
  }
  return new BrowserSessionLockManager();
}

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "InvalidStateError")) throw error;
  }
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  try {
    return typeof (value as Readonly<{ then?: unknown }>).then === "function";
  } catch {
    // A hostile getter is asynchronous-capability-shaped and cannot be allowed
    // to escape the synchronous IndexedDB upgrade/transaction boundary.
    return true;
  }
}

function createVerifiedPurgeCompletion(
  source: ActivationCertificate,
  receipt: string,
  signal: AbortSignal,
): VerifiedPurgeCompletion {
  const completion = Object.freeze({ [verifiedPurgeCompletionBrand]: true as const });
  verifiedPurgeCompletions.set(completion, { source, receipt, signal, state: "available" });
  return completion;
}

function revokeVerifiedPurgeCompletion(completion: VerifiedPurgeCompletion): void {
  const state = verifiedPurgeCompletions.get(completion);
  if (state && state.state !== "consumed") state.state = "revoked";
}

/** Internal coordinator bridge. The completion cannot be forged or replayed. */
export function claimVerifiedPurgeCompletion(value: unknown): VerifiedPurgeClaim {
  if (typeof value !== "object" || value === null) {
    throw new SessionError(sessionErrorCodes.invalidState, "Verified purge completion is malformed");
  }
  const completion = value as VerifiedPurgeCompletion;
  const state = verifiedPurgeCompletions.get(completion);
  if (!state || state.state !== "available") {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Verified purge completion is unavailable");
  }
  state.state = "claimed";
  let settled = false;
  return Object.freeze({
    source: state.source,
    receipt: state.receipt,
    signal: state.signal,
    settle: (committed: boolean): void => {
      if (settled) return;
      settled = true;
      state.state = committed ? "consumed" : "available";
    },
  });
}

function createPurgeReceipt(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new SessionError(sessionErrorCodes.platformUnavailable, "Secure randomness is required for account purge");
  }
  return `purge-v1:${globalThis.crypto.randomUUID()}`;
}

type LifecycleFence = Readonly<{
  generation: number;
  signal: AbortSignal;
}>;

export class ContentDatabaseRegistry {
  private generation = 0;
  private lifecycleController = new AbortController();
  private readonly operations = new Set<OperationToken>();
  private readonly handles = new Map<IDBDatabase, RegisteredHandle>();
  private readonly queuedLocks = new Set<AbortController>();

  public createQueuedLock(externalSignal?: AbortSignal): QueuedLockToken {
    if (externalSignal?.aborted) throw staleOperation("Captured view has been invalidated");
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    this.queuedLocks.add(controller);
    let released = false;
    return Object.freeze({
      generation: this.generation,
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        externalSignal?.removeEventListener("abort", forwardAbort);
        this.queuedLocks.delete(controller);
      },
    });
  }

  public assertGeneration(generation: number): void {
    if (generation !== this.generation) throw staleOperation("Document lifecycle changed before storage admission");
  }

  public captureLifecycle(): LifecycleFence {
    return Object.freeze({ generation: this.generation, signal: this.lifecycleController.signal });
  }

  public assertOperation(token: OperationToken): void {
    this.assertCurrent(token);
  }

  public createOperation(lease: ViewLease, generation = this.generation): OperationToken {
    this.assertGeneration(generation);
    let resolveCancellation = (): void => undefined;
    const cancelled = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const token: OperationToken = {
      active: true,
      generation,
      lease,
      transactions: new Set(),
      pendingOpenCount: 0,
      cancelled,
      resolveCancellation,
      abortListener: () => undefined,
    };
    this.operations.add(token);
    const invalidate = (): void => this.invalidateOperation(token);
    token.abortListener = invalidate;
    lease.signal.addEventListener("abort", invalidate, { once: true });
    return token;
  }

  public finishOperation(token: OperationToken): void {
    token.active = false;
    token.lease.signal.removeEventListener("abort", token.abortListener);
    this.operations.delete(token);
  }

  public async raceCancellation<T>(token: OperationToken, operation: PromiseLike<T>): Promise<T> {
    const cancelled = token.cancelled.then(() => {
      throw staleOperation("Account-content operation was cancelled by the document lifecycle");
    });
    return Promise.race([Promise.resolve(operation), cancelled]);
  }

  public isCurrent(token: OperationToken): boolean {
    return token.active && token.generation === this.generation && !token.lease.signal.aborted;
  }

  public registerPendingOpen(token: OperationToken): void {
    this.assertCurrent(token);
    token.pendingOpenCount += 1;
  }

  public finishPendingOpen(token: OperationToken): void {
    token.pendingOpenCount = Math.max(0, token.pendingOpenCount - 1);
  }

  public registerTransaction(token: OperationToken, transaction: IDBTransaction): void {
    this.assertCurrent(token);
    token.transactions.add(transaction);
  }

  public finishTransaction(token: OperationToken, transaction: IDBTransaction): void {
    token.transactions.delete(transaction);
  }

  public registerHandle(token: OperationToken, database: IDBDatabase): void {
    this.assertCurrent(token);
    const record: RegisteredHandle = {
      database,
      scopeKey: token.lease.activation.scopeKey,
      sessionEpoch: token.lease.activation.sessionEpoch,
    };
    this.handles.set(database, record);
    database.onversionchange = () => this.closeHandle(database);
  }

  public assertHandle(token: OperationToken, database: IDBDatabase): void {
    this.assertCurrent(token);
    const handle = this.handles.get(database);
    if (
      !handle ||
      handle.scopeKey !== token.lease.activation.scopeKey ||
      handle.sessionEpoch !== token.lease.activation.sessionEpoch
    ) {
      throw staleOperation("IndexedDB handle is not owned by the captured account activation");
    }
  }

  public closeHandle(database: IDBDatabase): void {
    database.close();
    this.handles.delete(database);
  }

  public closeAllHandles(): void {
    for (const database of this.handles.keys()) database.close();
    this.handles.clear();
  }

  public closeScopeHandles(scopeKey: string): void {
    for (const [database, handle] of this.handles) {
      if (handle.scopeKey === scopeKey) this.closeHandle(database);
    }
  }

  public cancelPendingOpens(): void {
    this.cancelQueuedLocks();
    for (const token of this.operations) {
      if (token.pendingOpenCount > 0) this.invalidateOperation(token);
    }
  }

  public cancelQueuedLocks(): void {
    for (const controller of this.queuedLocks) controller.abort();
    this.queuedLocks.clear();
  }

  public invalidateEpoch(sessionEpoch: string): void {
    for (const token of this.operations) {
      if (token.lease.activation.sessionEpoch === sessionEpoch) this.invalidateOperation(token);
    }
    for (const [database, handle] of this.handles) {
      if (handle.sessionEpoch === sessionEpoch) this.closeHandle(database);
    }
  }

  public invalidateAllOperations(): void {
    this.lifecycleController.abort(new SessionError(sessionErrorCodes.staleOperation, "Document lifecycle changed"));
    this.lifecycleController = new AbortController();
    this.generation += 1;
    this.cancelQueuedLocks();
    for (const token of this.operations) this.invalidateOperation(token);
    this.closeAllHandles();
  }

  private assertCurrent(token: OperationToken): void {
    if (!this.isCurrent(token)) throw staleOperation("Account-content operation is stale");
  }

  private invalidateOperation(token: OperationToken): void {
    if (!token.active) return;
    token.active = false;
    token.resolveCancellation();
    for (const transaction of token.transactions) abortTransaction(transaction);
    token.transactions.clear();
  }
}

export class ContentOperation {
  private readonly barrier: ContentScopeBarrier;
  private readonly token: OperationToken;

  public constructor(barrier: ContentScopeBarrier, token: OperationToken) {
    this.barrier = barrier;
    this.token = token;
  }

  public get lease(): ViewLease {
    return this.token.lease;
  }

  public assertOrganization(organizationId: string): void {
    if (organizationId !== this.token.lease.organizationId) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Content operation targeted a different organization");
    }
  }

  public physicalDatabaseName(spec: Pick<ContentDatabaseSpec, "logicalName" | "namespaceVersion">): string {
    return createScopedDatabaseName(spec.logicalName, spec.namespaceVersion, this.token.lease.activation.scopeKey);
  }

  public openDatabase(spec: ContentDatabaseSpec): Promise<IDBDatabase> {
    return this.barrier.openDatabase(this.token, spec);
  }

  public runTransaction(
    database: IDBDatabase,
    stores: string | readonly string[],
    mode: IDBTransactionMode,
    start: (transaction: IDBTransaction) => void,
  ): Promise<void> {
    return this.barrier.runTransaction(this.token, database, stores, mode, start);
  }

  public closeDatabase(database: IDBDatabase): void {
    this.barrier.closeDatabase(database);
  }
}

export class ContentScopeBarrier {
  public readonly registry: ContentDatabaseRegistry;
  private readonly coordinator: AuthSessionCoordinator;
  private readonly factory: IDBFactory;
  private readonly locks: SessionLockManager;

  public constructor(options: ContentBarrierOptions) {
    this.coordinator = options.coordinator;
    this.registry = options.registry ?? new ContentDatabaseRegistry();
    this.factory = getIndexedDbFactory(options.indexedDB);
    this.locks = getLockManager(options.locks);
  }

  public async withShared<T>(
    leaseValue: unknown,
    callback: (operation: ContentOperation) => T | PromiseLike<T>,
  ): Promise<T> {
    const lease = validateViewLease(leaseValue);
    if (lease.signal.aborted) throw staleOperation("Captured view has been invalidated");
    const lockName = `${CONTENT_SCOPE_LOCK_PREFIX}${lease.activation.scopeKey}`;
    const queuedLock = this.registry.createQueuedLock(lease.signal);
    try {
      const result = await this.locks.request(lockName, { mode: "shared", signal: queuedLock.signal }, async () => {
        this.registry.assertGeneration(queuedLock.generation);
        await this.coordinator.admitView(lease);
        this.registry.assertGeneration(queuedLock.generation);
        const token = this.registry.createOperation(lease, queuedLock.generation);
        const operation = new ContentOperation(this, token);
        try {
          const value = await this.registry.raceCancellation(token, Promise.resolve(callback(operation)));
          if (!this.registry.isCurrent(token)) throw staleOperation("Account-content operation became stale");
          await this.coordinator.admitView(lease);
          this.registry.assertGeneration(queuedLock.generation);
          if (!this.registry.isCurrent(token)) throw staleOperation("Account-content operation became stale");
          return value;
        } finally {
          this.registry.finishOperation(token);
        }
      });
      await this.coordinator.admitView(lease);
      this.registry.assertGeneration(queuedLock.generation);
      return result;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw staleOperation("Content-scope lock request was cancelled");
      }
      throw error;
    } finally {
      queuedLock.release();
    }
  }

  public async purgeAccountScope(sourceValue: unknown, options: PurgeAccountScopeOptions): Promise<string> {
    const source = validateActivationCertificate(sourceValue);
    const lockName = `${CONTENT_SCOPE_LOCK_PREFIX}${source.scopeKey}`;
    const lifecycle = this.registry.captureLifecycle();
    try {
      return await this.locks.request(lockName, { mode: "exclusive", signal: lifecycle.signal }, async () => {
        this.registry.assertGeneration(lifecycle.generation);
        await this.coordinator.assertPurgeSource(source, lifecycle.signal);
        this.registry.assertGeneration(lifecycle.generation);
        this.registry.invalidateEpoch(source.sessionEpoch);
        this.registry.closeScopeHandles(source.scopeKey);

        const scopedNames = PERSISTENT_CONTENT_DATABASE_INVENTORY.map((entry) =>
          createScopedDatabaseName(entry.logicalName, entry.namespaceVersion, source.scopeKey),
        );
        const databaseNames = [...scopedNames, ...LEGACY_DATABASE_NAMES];
        if (new Set(databaseNames).size !== databaseNames.length) {
          throw new SessionError(sessionErrorCodes.invalidState, "Persistent database inventory contains duplicates");
        }
        for (const databaseName of databaseNames) {
          this.registry.assertGeneration(lifecycle.generation);
          await this.raceLifecycle(lifecycle, deleteDatabaseBarrier(this.factory, databaseName, options.onBlocked));
        }

        this.registry.assertGeneration(lifecycle.generation);
        scrubLegacyWebStorage(options);
        this.registry.assertGeneration(lifecycle.generation);
        const finalPurgeAuthority = await this.coordinator.assertPurgeSource(source, lifecycle.signal);
        this.registry.assertGeneration(lifecycle.generation);

        if (finalPurgeAuthority.mode !== "retiring" && finalPurgeAuthority.mode !== "transition") {
          throw new SessionError(sessionErrorCodes.admissionDenied, "Purge authority changed before completion");
        }

        const receipt =
          finalPurgeAuthority.phase === "source_purged" && finalPurgeAuthority.cleanupReceipt
            ? finalPurgeAuthority.cleanupReceipt
            : createPurgeReceipt();
        const completion = createVerifiedPurgeCompletion(source, receipt, lifecycle.signal);
        try {
          await this.coordinator.commitVerifiedPurge(completion);
        } finally {
          revokeVerifiedPurgeCompletion(completion);
        }
        this.registry.assertGeneration(lifecycle.generation);
        return receipt;
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw staleOperation("Account purge was cancelled by the document lifecycle");
      }
      throw error;
    }
  }

  private async raceLifecycle<T>(lifecycle: LifecycleFence, operation: Promise<T>): Promise<T> {
    if (lifecycle.signal.aborted) throw staleOperation("Account purge was cancelled by the document lifecycle");
    return new Promise<T>((resolve, reject) => {
      const cancel = (): void => reject(staleOperation("Account purge was cancelled by the document lifecycle"));
      lifecycle.signal.addEventListener("abort", cancel, { once: true });
      void operation.then(
        (value) => {
          lifecycle.signal.removeEventListener("abort", cancel);
          resolve(value);
        },
        (error: unknown) => {
          lifecycle.signal.removeEventListener("abort", cancel);
          reject(error);
        },
      );
    });
  }

  public async openDatabase(token: OperationToken, spec: ContentDatabaseSpec): Promise<IDBDatabase> {
    this.registry.assertOperation(token);
    await this.coordinator.admitView(token.lease);
    this.registry.assertOperation(token);
    if (!Number.isSafeInteger(spec.databaseVersion) || spec.databaseVersion < 1) {
      throw new SessionError(sessionErrorCodes.invalidState, "IndexedDB schema version must be a positive integer");
    }
    const databaseName = createScopedDatabaseName(
      spec.logicalName,
      spec.namespaceVersion,
      token.lease.activation.scopeKey,
    );
    this.registry.registerPendingOpen(token);

    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.factory.open(databaseName, spec.databaseVersion);
      } catch (error) {
        this.registry.finishPendingOpen(token);
        reject(toSessionError(error, sessionErrorCodes.persistenceUnavailable, "Scoped database could not be opened"));
        return;
      }

      let settled = false;
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        this.registry.finishPendingOpen(token);
        reject(error);
      };
      const abortStaleUpgrade = (): void => {
        if (request.transaction) abortTransaction(request.transaction);
        request.result.close();
      };

      request.onblocked = () => spec.onBlocked?.(databaseName);
      request.onerror = () => {
        const error = this.registry.isCurrent(token)
          ? toSessionError(
              request.error,
              sessionErrorCodes.persistenceUnavailable,
              "Scoped database open request failed",
            )
          : staleOperation("Scoped database open completed after invalidation");
        rejectOnce(error);
      };
      request.onupgradeneeded = (event) => {
        if (!this.registry.isCurrent(token)) {
          abortStaleUpgrade();
          return;
        }
        const transaction = request.transaction;
        if (!transaction) {
          rejectOnce(new SessionError(sessionErrorCodes.persistenceUnavailable, "Database upgrade has no transaction"));
          return;
        }
        try {
          const upgradeResult: unknown = spec.upgrade(request.result, event.oldVersion, event.newVersion, transaction);
          if (isThenable(upgradeResult)) {
            throw new SessionError(sessionErrorCodes.invalidState, "Scoped database upgrades must be synchronous");
          }
          if (!this.registry.isCurrent(token)) abortStaleUpgrade();
        } catch (error) {
          abortTransaction(transaction);
          rejectOnce(toSessionError(error, sessionErrorCodes.persistenceUnavailable, "Scoped database upgrade failed"));
        }
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        if (!this.registry.isCurrent(token)) {
          request.result.close();
          rejectOnce(staleOperation("Scoped database opened after invalidation"));
          return;
        }
        void this.coordinator.admitView(token.lease).then(
          () => {
            try {
              this.registry.registerHandle(token, request.result);
              settled = true;
              this.registry.finishPendingOpen(token);
              resolve(request.result);
            } catch (error) {
              request.result.close();
              rejectOnce(error);
            }
          },
          (error: unknown) => {
            request.result.close();
            rejectOnce(error);
          },
        );
      };
    });
  }

  public async runTransaction(
    token: OperationToken,
    database: IDBDatabase,
    stores: string | readonly string[],
    mode: IDBTransactionMode,
    start: (transaction: IDBTransaction) => void,
  ): Promise<void> {
    this.registry.assertHandle(token, database);
    await this.coordinator.admitView(token.lease);
    this.registry.assertHandle(token, database);
    if (mode !== "readonly" && mode !== "readwrite") {
      throw new SessionError(
        sessionErrorCodes.invalidState,
        "Scoped content transactions must be readonly or readwrite",
      );
    }
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(stores, mode);
      this.registry.registerTransaction(token, transaction);
    } catch (error) {
      throw toSessionError(
        error,
        sessionErrorCodes.persistenceUnavailable,
        "Scoped database transaction failed to start",
      );
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.registry.finishTransaction(token, transaction);
        callback();
      };
      transaction.oncomplete = () => {
        finish(() => {
          if (!this.registry.isCurrent(token)) {
            reject(staleOperation("Scoped database transaction completed after invalidation"));
            return;
          }
          resolve();
        });
      };
      transaction.onerror = () => {
        finish(() => {
          reject(
            toSessionError(
              transaction.error,
              sessionErrorCodes.persistenceUnavailable,
              "Scoped database transaction failed",
            ),
          );
        });
      };
      transaction.onabort = () => {
        finish(() => {
          const error = this.registry.isCurrent(token)
            ? toSessionError(
                transaction.error,
                sessionErrorCodes.persistenceUnavailable,
                "Scoped database transaction aborted",
              )
            : staleOperation("Scoped database transaction was invalidated");
          reject(error);
        });
      };
      try {
        const startResult: unknown = start(transaction);
        if (isThenable(startResult)) {
          throw new SessionError(sessionErrorCodes.invalidState, "Scoped transaction starters must be synchronous");
        }
        if (!this.registry.isCurrent(token)) abortTransaction(transaction);
      } catch (error) {
        abortTransaction(transaction);
        finish(() => {
          reject(
            toSessionError(
              error,
              sessionErrorCodes.persistenceUnavailable,
              "Scoped database transaction failed to start",
            ),
          );
        });
      }
    });
  }

  public closeDatabase(database: IDBDatabase): void {
    this.registry.closeHandle(database);
  }
}
