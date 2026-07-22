import type { AuthSessionCoordinator } from "./coordinator.js";
import { SessionError, sessionErrorCodes, toSessionError } from "./errors.js";
import { createScopedDatabaseName, isDatabaseNameForScope } from "./scope.js";
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

export class ContentDatabaseRegistry {
  private generation = 0;
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

export class ContentPurgeOperation {
  private readonly factory: IDBFactory;
  private readonly source: ActivationCertificate;
  private readonly onBlocked: ((databaseName: string) => void) | undefined;

  public constructor(factory: IDBFactory, source: ActivationCertificate, onBlocked?: (databaseName: string) => void) {
    this.factory = factory;
    this.source = source;
    this.onBlocked = onBlocked;
  }

  public async deleteDatabases(databaseNames: readonly string[]): Promise<void> {
    const uniqueNames = new Set(databaseNames);
    if (uniqueNames.size !== databaseNames.length) {
      throw new SessionError(sessionErrorCodes.invalidState, "Scoped database deletion list contains duplicates");
    }
    for (const databaseName of databaseNames) {
      if (!isDatabaseNameForScope(databaseName, this.source.scopeKey)) {
        throw new SessionError(sessionErrorCodes.invalidState, "Scoped database deletion target has another scope");
      }
      await deleteDatabaseBarrier(this.factory, databaseName, this.onBlocked);
    }
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
          return value;
        } finally {
          this.registry.finishOperation(token);
        }
      });
      await this.coordinator.admitView(lease);
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

  public async withExclusive<T>(
    sourceValue: unknown,
    callback: (operation: ContentPurgeOperation) => T | PromiseLike<T>,
    onBlocked?: (databaseName: string) => void,
  ): Promise<T> {
    const source = validateActivationCertificate(sourceValue);
    const lockName = `${CONTENT_SCOPE_LOCK_PREFIX}${source.scopeKey}`;
    return this.locks.request(lockName, { mode: "exclusive" }, async () => {
      await this.coordinator.assertPurgeSource(source);
      this.registry.invalidateEpoch(source.sessionEpoch);
      this.registry.closeScopeHandles(source.scopeKey);
      const value = await callback(new ContentPurgeOperation(this.factory, source, onBlocked));
      await this.coordinator.assertPurgeSource(source);
      return value;
    });
  }

  public openDatabase(token: OperationToken, spec: ContentDatabaseSpec): Promise<IDBDatabase> {
    if (!Number.isSafeInteger(spec.databaseVersion) || spec.databaseVersion < 1) {
      return Promise.reject(
        new SessionError(sessionErrorCodes.invalidState, "IndexedDB schema version must be a positive integer"),
      );
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
          if (
            typeof upgradeResult === "object" &&
            upgradeResult !== null &&
            "then" in upgradeResult &&
            typeof upgradeResult.then === "function"
          ) {
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
        try {
          this.registry.registerHandle(token, request.result);
          settled = true;
          this.registry.finishPendingOpen(token);
          resolve(request.result);
        } catch (error) {
          request.result.close();
          rejectOnce(error);
        }
      };
    });
  }

  public runTransaction(
    token: OperationToken,
    database: IDBDatabase,
    stores: string | readonly string[],
    mode: IDBTransactionMode,
    start: (transaction: IDBTransaction) => void,
  ): Promise<void> {
    this.registry.assertHandle(token, database);
    if (mode !== "readonly" && mode !== "readwrite") {
      return Promise.reject(
        new SessionError(sessionErrorCodes.invalidState, "Scoped content transactions must be readonly or readwrite"),
      );
    }
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(stores, mode);
      this.registry.registerTransaction(token, transaction);
    } catch (error) {
      return Promise.reject(
        toSessionError(error, sessionErrorCodes.persistenceUnavailable, "Scoped database transaction failed to start"),
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
        start(transaction);
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

export function deleteDatabaseBarrier(
  factory: IDBFactory,
  databaseName: string,
  onBlocked?: (databaseName: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.deleteDatabase(databaseName);
    } catch (error) {
      reject(toSessionError(error, sessionErrorCodes.persistenceUnavailable, "Database deletion could not start"));
      return;
    }
    request.onblocked = () => onBlocked?.(databaseName);
    request.onerror = () => {
      reject(toSessionError(request.error, sessionErrorCodes.persistenceUnavailable, "Database deletion failed"));
    };
    request.onsuccess = () => resolve();
  });
}
