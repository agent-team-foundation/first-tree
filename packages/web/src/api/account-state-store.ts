/**
 * Small authenticated browser state that must survive reload without crossing
 * an account, server, session epoch, or organization boundary.
 *
 * The physical database is account+server scoped by ContentScopeBarrier. Rows
 * use an explicit account/organization partition discriminator: account-level
 * navigation state can be read before an organization view exists, while
 * drafts and other content remain bound to one exact organization view.
 */

import { type CapturedAccountStoreRuntime, captureAccountStoreRuntime } from "../auth/session/account-store-runtime.js";
import type {
  AccountContentOperation,
  ContentDatabaseSpec,
  ContentOperation,
} from "../auth/session/content-barrier.js";
import { type CapturedContentStoreRuntime, captureContentStoreRuntime } from "../auth/session/content-store-runtime.js";
import { SessionError, sessionErrorCodes } from "../auth/session/errors.js";
import { PERSISTENT_CONTENT_DATABASES } from "../auth/session/persistence-inventory.js";
import {
  type AccountLease,
  type JsonValue,
  type ViewLease,
  validateAccountLease,
  validateViewLease,
} from "../auth/session/types.js";

const STORE = "entries";
const INDEX_BY_PARTITION = "by_partition";
const SHARED_TAB_ID = "";
const ACCOUNT_PARTITION_ID = "account";
const MAX_KIND_LENGTH = 128;
const MAX_KEY_LENGTH = 2048;
const MAX_TAB_ID_LENGTH = 512;
const MAX_JSON_DEPTH = 24;
const MAX_JSON_NODES = 50_000;
const MAX_VALUE_BYTES = 2 * 1024 * 1024;
const MAX_PRUNE_ENTRIES = 10_000;

type PartitionKind = "account" | "organization";

export const ACCOUNT_STATE_DATABASE_SPEC: ContentDatabaseSpec = Object.freeze({
  ...PERSISTENT_CONTENT_DATABASES.accountState,
  databaseVersion: 1,
  upgrade: (database: IDBDatabase): void => {
    if (database.objectStoreNames.contains(STORE)) return;
    const entries = database.createObjectStore(STORE, {
      keyPath: ["sessionEpoch", "partitionKind", "partitionId", "kind", "tabId", "key"],
    });
    entries.createIndex(INDEX_BY_PARTITION, ["sessionEpoch", "partitionKind", "partitionId", "kind", "tabId"], {
      unique: false,
    });
  },
});

export type AccountStateLocator = Readonly<{
  kind: string;
  key: string;
  /** Omit for partition-wide state. Supply the current opaque tab id for tab-owned state. */
  tabId?: string;
}>;

export type AccountStateEntry<T extends JsonValue = JsonValue> = Readonly<{
  kind: string;
  key: string;
  tabId?: string;
  value: T;
  updatedAt: number;
}>;

export type PutAccountStateOptions = Readonly<{
  /** Retain only the newest N entries within this epoch/partition/kind/tab. */
  maxEntries?: number;
}>;

export type AccountStateCompareExchangeResult<T extends JsonValue = JsonValue> = Readonly<{
  committed: boolean;
  previous: AccountStateEntry<T> | null;
}>;

type StoredAccountState = Readonly<{
  v: 1;
  sessionEpoch: string;
  partitionKind: PartitionKind;
  partitionId: string;
  kind: string;
  key: string;
  tabId: string;
  value: JsonValue;
  updatedAt: number;
}>;

type NormalizedLocator = Readonly<{
  kind: string;
  key: string;
  tabId: string;
}>;

type CapturedEntry<T extends JsonValue> = Readonly<{
  kind: string;
  key: string;
  tabId?: string;
  value: T;
  updatedAt: number;
}>;

type Partition = Readonly<{
  sessionEpoch: string;
  partitionKind: PartitionKind;
  partitionId: string;
  ownerTabId: string;
}>;

type DatabaseOperation = Pick<
  AccountContentOperation,
  "physicalDatabaseName" | "openDatabase" | "runTransaction" | "closeDatabase"
>;

type DatabaseRunner = <T>(callback: (operation: DatabaseOperation, database: IDBDatabase) => Promise<T>) => Promise<T>;

function invalidState(message: string): SessionError {
  return new SessionError(sessionErrorCodes.invalidState, message);
}

function requireBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw invalidState(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function normalizeLocator(locatorValue: AccountStateLocator, ownerTabId: string): NormalizedLocator {
  const kindValue = locatorValue.kind;
  const keyValue = locatorValue.key;
  const tabIdValue = locatorValue.tabId;
  const normalized = Object.freeze({
    kind: requireBoundedString(kindValue, "Account-state kind", MAX_KIND_LENGTH),
    key: requireBoundedString(keyValue, "Account-state key", MAX_KEY_LENGTH),
    tabId:
      tabIdValue === undefined
        ? SHARED_TAB_ID
        : requireBoundedString(tabIdValue, "Account-state tab id", MAX_TAB_ID_LENGTH),
  });
  if (normalized.tabId !== SHARED_TAB_ID && normalized.tabId !== ownerTabId) {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Account-state tab id is not owned by this lease");
  }
  return normalized;
}

function captureEntry<T extends JsonValue>(entryValue: AccountStateEntry<T>): CapturedEntry<T> {
  // Snapshot each caller-controlled property once. TypeScript's Readonly does
  // not prevent a runtime object from exposing mutable or side-effecting
  // getters between locator validation and value normalization.
  const kind = entryValue.kind;
  const key = entryValue.key;
  const tabId = entryValue.tabId;
  const value = entryValue.value;
  const updatedAt = entryValue.updatedAt;
  return Object.freeze({ kind, key, ...(tabId === undefined ? {} : { tabId }), value, updatedAt });
}

function requireUpdatedAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidState("Account-state updatedAt must be a non-negative safe integer");
  }
  return value;
}

function normalizeMaxEntries(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PRUNE_ENTRIES) {
    throw invalidState(`Account-state maxEntries must be between 1 and ${MAX_PRUNE_ENTRIES}`);
  }
  return value;
}

function normalizeJsonValue(value: unknown): JsonValue {
  let nodes = 0;
  const ancestors = new Set<object>();

  const visit = (item: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw invalidState("Account-state value exceeds the structural limit");
    }
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object") throw invalidState("Account-state values must contain only JSON data");
    if (ancestors.has(item)) throw invalidState("Account-state values cannot contain cycles");

    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const length = item.length;
        if (!Number.isSafeInteger(length) || length > MAX_JSON_NODES - nodes) {
          throw invalidState("Account-state array exceeds the structural limit");
        }
        const keys = Reflect.ownKeys(item);
        if (keys.length !== length + 1 || !keys.includes("length")) {
          throw invalidState("Account-state arrays must contain only indexed JSON data");
        }
        const output: JsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Reflect.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor?.enumerable || !("value" in descriptor)) {
            throw invalidState("Account-state arrays must contain only dense data properties");
          }
          output[index] = visit(descriptor.value, depth + 1);
        }
        return Object.freeze(output);
      }

      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalidState("Account-state objects must be plain JSON objects");
      }
      const keys = Reflect.ownKeys(item);
      if (keys.length > MAX_JSON_NODES - nodes) {
        throw invalidState("Account-state object exceeds the structural limit");
      }
      const output = Object.create(null) as Record<string, JsonValue>;
      for (const rawKey of keys) {
        if (typeof rawKey !== "string") {
          throw invalidState("Account-state objects cannot contain symbol keys");
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(item, rawKey);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw invalidState("Account-state objects must contain only enumerable data properties");
        }
        const key = rawKey;
        requireBoundedString(key, "Account-state object key", MAX_KEY_LENGTH);
        Object.defineProperty(output, key, {
          configurable: false,
          enumerable: true,
          writable: false,
          value: visit(descriptor.value, depth + 1),
        });
      }
      return Object.freeze(output);
    } finally {
      ancestors.delete(item);
    }
  };

  const normalized = visit(value, 0);
  const encoded = JSON.stringify(normalized);
  if (new TextEncoder().encode(encoded).byteLength > MAX_VALUE_BYTES) {
    throw invalidState("Account-state value exceeds the byte limit");
  }
  return normalized;
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  const leftArray = Array.isArray(left);
  if (leftArray !== Array.isArray(right)) return false;
  if (leftArray) {
    const rightArray = right as readonly JsonValue[];
    if (left.length !== rightArray.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      const rightValue = rightArray[index];
      if (rightValue === undefined || !jsonValuesEqual(left[index] as JsonValue, rightValue)) return false;
    }
    return true;
  }
  const leftEntries = Object.entries(left);
  const rightRecord = right as Readonly<Record<string, JsonValue>>;
  if (leftEntries.length !== Object.keys(rightRecord).length) return false;
  return leftEntries.every(([key, value]) => {
    const rightValue = rightRecord[key];
    return (
      rightValue !== undefined &&
      Reflect.getOwnPropertyDescriptor(rightRecord, key) !== undefined &&
      jsonValuesEqual(value, rightValue)
    );
  });
}

function primaryKey(row: StoredAccountState): IDBValidKey[] {
  return [row.sessionEpoch, row.partitionKind, row.partitionId, row.kind, row.tabId, row.key];
}

function entryKey(partition: Partition, locator: NormalizedLocator): IDBValidKey[] {
  return [
    partition.sessionEpoch,
    partition.partitionKind,
    partition.partitionId,
    locator.kind,
    locator.tabId,
    locator.key,
  ];
}

function partitionKey(partition: Partition, locator: Pick<NormalizedLocator, "kind" | "tabId">): IDBValidKey[] {
  return [partition.sessionEpoch, partition.partitionKind, partition.partitionId, locator.kind, locator.tabId];
}

function organizationPartition(lease: ViewLease): Partition {
  return Object.freeze({
    sessionEpoch: lease.activation.sessionEpoch,
    partitionKind: "organization",
    partitionId: lease.organizationId,
    ownerTabId: lease.ownerTabId,
  });
}

function accountPartition(lease: AccountLease): Partition {
  return Object.freeze({
    sessionEpoch: lease.activation.sessionEpoch,
    partitionKind: "account",
    partitionId: ACCOUNT_PARTITION_ID,
    ownerTabId: lease.ownerTabId,
  });
}

function toStoredRow<T extends JsonValue>(
  partition: Partition,
  entry: AccountStateEntry<T>,
  locator: NormalizedLocator,
): StoredAccountState {
  const value = entry.value;
  const updatedAt = entry.updatedAt;
  return Object.freeze({
    v: 1,
    sessionEpoch: partition.sessionEpoch,
    partitionKind: partition.partitionKind,
    partitionId: partition.partitionId,
    kind: locator.kind,
    key: locator.key,
    tabId: locator.tabId,
    value: normalizeJsonValue(value),
    updatedAt: requireUpdatedAt(updatedAt),
  });
}

function parseStoredRow(value: unknown, partition: Partition, expected?: NormalizedLocator): StoredAccountState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionError(sessionErrorCodes.recoveryRequired, "Account-state row is malformed");
  }
  const row = value as Partial<StoredAccountState>;
  if (typeof row.tabId !== "string") {
    throw new SessionError(sessionErrorCodes.recoveryRequired, "Account-state row has no tab boundary");
  }
  let locator: NormalizedLocator;
  try {
    locator = normalizeLocator(
      {
        kind: row.kind ?? "",
        key: row.key ?? "",
        ...(row.tabId === SHARED_TAB_ID ? {} : { tabId: row.tabId }),
      },
      partition.ownerTabId,
    );
  } catch (error) {
    throw new SessionError(sessionErrorCodes.recoveryRequired, "Account-state row key is malformed", error);
  }
  if (
    row.v !== 1 ||
    row.sessionEpoch !== partition.sessionEpoch ||
    row.partitionKind !== partition.partitionKind ||
    row.partitionId !== partition.partitionId ||
    (expected !== undefined &&
      (locator.kind !== expected.kind || locator.key !== expected.key || locator.tabId !== expected.tabId))
  ) {
    throw new SessionError(sessionErrorCodes.recoveryRequired, "Account-state row crossed its lease boundary");
  }
  try {
    return Object.freeze({
      v: 1,
      sessionEpoch: row.sessionEpoch,
      partitionKind: row.partitionKind,
      partitionId: row.partitionId,
      kind: locator.kind,
      key: locator.key,
      tabId: locator.tabId,
      value: normalizeJsonValue(row.value),
      updatedAt: requireUpdatedAt(row.updatedAt),
    });
  } catch (error) {
    throw new SessionError(sessionErrorCodes.recoveryRequired, "Account-state row value is malformed", error);
  }
}

function publicEntry<T extends JsonValue>(row: StoredAccountState): AccountStateEntry<T> {
  return Object.freeze({
    kind: row.kind,
    key: row.key,
    ...(row.tabId === SHARED_TAB_ID ? {} : { tabId: row.tabId }),
    value: row.value as T,
    updatedAt: row.updatedAt,
  });
}

function sameStoredEntry(left: StoredAccountState | null, right: StoredAccountState | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.sessionEpoch === right.sessionEpoch &&
    left.partitionKind === right.partitionKind &&
    left.partitionId === right.partitionId &&
    left.kind === right.kind &&
    left.key === right.key &&
    left.tabId === right.tabId &&
    left.updatedAt === right.updatedAt &&
    jsonValuesEqual(left.value, right.value)
  );
}

function schedulePrune(
  store: IDBObjectStore,
  partition: Partition,
  locator: NormalizedLocator,
  maxEntries: number,
  fail: (error: unknown) => void,
): void {
  const request = store.index(INDEX_BY_PARTITION).getAll(partitionKey(partition, locator));
  request.onsuccess = () => {
    try {
      const rows = (request.result as unknown[]).map((value) => parseStoredRow(value, partition));
      rows.sort((left, right) => right.updatedAt - left.updatedAt || right.key.localeCompare(left.key));
      for (const row of rows.slice(maxEntries)) store.delete(primaryKey(row));
    } catch (error) {
      fail(error);
    }
  };
}

async function runDatabaseTransaction(
  operation: DatabaseOperation,
  database: IDBDatabase,
  mode: IDBTransactionMode,
  start: (transaction: IDBTransaction, fail: (error: unknown) => void) => void,
): Promise<void> {
  let handlerError: unknown;
  try {
    await operation.runTransaction(database, STORE, mode, (transaction) => {
      const fail = (error: unknown): void => {
        if (handlerError === undefined) handlerError = error;
        transaction.abort();
      };
      start(transaction, fail);
    });
  } catch (error) {
    if (handlerError !== undefined) throw handlerError;
    throw error;
  }
}

async function openDatabase<T>(
  operation: DatabaseOperation,
  callback: (database: IDBDatabase) => Promise<T>,
): Promise<T> {
  const database = await operation.openDatabase(ACCOUNT_STATE_DATABASE_SPEC);
  try {
    return await callback(database);
  } finally {
    operation.closeDatabase(database);
  }
}

function organizationRunner(runtime: CapturedContentStoreRuntime): DatabaseRunner {
  return <T>(callback: (operation: DatabaseOperation, database: IDBDatabase) => Promise<T>): Promise<T> =>
    runtime.withShared(async (operation: ContentOperation, lease: ViewLease) => {
      operation.assertOrganization(lease.organizationId);
      return openDatabase(operation, (database) => callback(operation, database));
    });
}

function accountRunner(runtime: CapturedAccountStoreRuntime): DatabaseRunner {
  return <T>(callback: (operation: DatabaseOperation, database: IDBDatabase) => Promise<T>): Promise<T> =>
    runtime.withShared((operation: AccountContentOperation) =>
      openDatabase(operation, (database) => callback(operation, database)),
    );
}

function captureAccountStateRuntime(leaseValue: unknown): CapturedContentStoreRuntime {
  const sourceLease = validateViewLease(leaseValue);
  const runtime = captureContentStoreRuntime(sourceLease);
  if (!runtime) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Account-state view is not installed or is stale");
  }
  return runtime;
}

function captureAccountStateAccountRuntime(leaseValue: unknown): CapturedAccountStoreRuntime {
  const sourceLease = validateAccountLease(leaseValue);
  const runtime = captureAccountStoreRuntime(sourceLease);
  if (!runtime) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Account-state lifecycle is not installed or is stale");
  }
  return runtime;
}

/** Explicit lease-taking access to account-owned browser state. */
export class AccountStateStore {
  public async getEntry<T extends JsonValue = JsonValue>(
    leaseValue: ViewLease,
    locatorValue: AccountStateLocator,
  ): Promise<AccountStateEntry<T> | null> {
    const runtime = captureAccountStateRuntime(leaseValue);
    return this.readEntry<T>(organizationRunner(runtime), organizationPartition(runtime.lease), locatorValue);
  }

  public async listEntries<T extends JsonValue = JsonValue>(
    leaseValue: ViewLease,
    partitionValue: Pick<AccountStateLocator, "kind" | "tabId">,
  ): Promise<readonly AccountStateEntry<T>[]> {
    const runtime = captureAccountStateRuntime(leaseValue);
    return this.readPartition<T>(organizationRunner(runtime), organizationPartition(runtime.lease), partitionValue);
  }

  public async putEntry<T extends JsonValue>(
    leaseValue: ViewLease,
    entry: AccountStateEntry<T>,
    options: PutAccountStateOptions = {},
  ): Promise<void> {
    const runtime = captureAccountStateRuntime(leaseValue);
    await this.writeEntry(organizationRunner(runtime), organizationPartition(runtime.lease), entry, options, false);
  }

  public async putEntryIfAbsent<T extends JsonValue>(
    leaseValue: ViewLease,
    entry: AccountStateEntry<T>,
    options: PutAccountStateOptions = {},
  ): Promise<boolean> {
    const runtime = captureAccountStateRuntime(leaseValue);
    return this.writeEntry(organizationRunner(runtime), organizationPartition(runtime.lease), entry, options, true);
  }

  public async deleteEntry(leaseValue: ViewLease, locatorValue: AccountStateLocator): Promise<void> {
    const runtime = captureAccountStateRuntime(leaseValue);
    await this.removeEntry(organizationRunner(runtime), organizationPartition(runtime.lease), locatorValue);
  }

  public async getAccountEntry<T extends JsonValue = JsonValue>(
    leaseValue: AccountLease,
    locatorValue: AccountStateLocator,
  ): Promise<AccountStateEntry<T> | null> {
    const runtime = captureAccountStateAccountRuntime(leaseValue);
    return this.readEntry<T>(accountRunner(runtime), accountPartition(runtime.lease), locatorValue);
  }

  public async listAccountEntries<T extends JsonValue = JsonValue>(
    leaseValue: AccountLease,
    partitionValue: Pick<AccountStateLocator, "kind" | "tabId">,
  ): Promise<readonly AccountStateEntry<T>[]> {
    const runtime = captureAccountStateAccountRuntime(leaseValue);
    return this.readPartition<T>(accountRunner(runtime), accountPartition(runtime.lease), partitionValue);
  }

  public async putAccountEntry<T extends JsonValue>(
    leaseValue: AccountLease,
    entry: AccountStateEntry<T>,
    options: PutAccountStateOptions = {},
  ): Promise<void> {
    const runtime = captureAccountStateAccountRuntime(leaseValue);
    await this.writeEntry(accountRunner(runtime), accountPartition(runtime.lease), entry, options, false);
  }

  public async putAccountEntryIfAbsent<T extends JsonValue>(
    leaseValue: AccountLease,
    entry: AccountStateEntry<T>,
    options: PutAccountStateOptions = {},
  ): Promise<boolean> {
    const runtime = captureAccountStateAccountRuntime(leaseValue);
    return this.writeEntry(accountRunner(runtime), accountPartition(runtime.lease), entry, options, true);
  }

  public async deleteAccountEntry(leaseValue: AccountLease, locatorValue: AccountStateLocator): Promise<void> {
    const runtime = captureAccountStateAccountRuntime(leaseValue);
    await this.removeEntry(accountRunner(runtime), accountPartition(runtime.lease), locatorValue);
  }

  /** Atomic exact-row CAS used by account navigation state. */
  public async compareExchangeAccountEntry<T extends JsonValue>(
    leaseValue: AccountLease,
    locatorValue: AccountStateLocator,
    expectedValue: AccountStateEntry<T> | null,
    replacementValue: AccountStateEntry<T> | null,
  ): Promise<AccountStateCompareExchangeResult<T>> {
    const runtime = captureAccountStateAccountRuntime(leaseValue);
    const partition = accountPartition(runtime.lease);
    const locator = normalizeLocator(locatorValue, partition.ownerTabId);
    const expectedInput = expectedValue === null ? null : captureEntry(expectedValue);
    const replacementInput = replacementValue === null ? null : captureEntry(replacementValue);
    const expected =
      expectedInput === null
        ? null
        : toStoredRow(partition, expectedInput, normalizeLocator(expectedInput, partition.ownerTabId));
    const replacement =
      replacementInput === null
        ? null
        : toStoredRow(partition, replacementInput, normalizeLocator(replacementInput, partition.ownerTabId));
    for (const row of [expected, replacement]) {
      if (row && (row.kind !== locator.kind || row.key !== locator.key || row.tabId !== locator.tabId)) {
        throw invalidState("Account-state compare/exchange row does not match its locator");
      }
    }

    return accountRunner(runtime)(async (operation, database) => {
      let committed = false;
      let previous: AccountStateEntry<T> | null = null;
      await runDatabaseTransaction(operation, database, "readwrite", (transaction, fail) => {
        const store = transaction.objectStore(STORE);
        const request = store.get(entryKey(partition, locator));
        request.onsuccess = () => {
          try {
            const current = request.result === undefined ? null : parseStoredRow(request.result, partition, locator);
            previous = current === null ? null : publicEntry<T>(current);
            if (!sameStoredEntry(current, expected)) return;
            if (replacement === null) store.delete(entryKey(partition, locator));
            else store.put(replacement);
            committed = true;
          } catch (error) {
            fail(error);
          }
        };
      });
      return Object.freeze({ committed, previous });
    });
  }

  /** Exact post-await delivery fence for account-navigation controllers. */
  public async assertAccountLeaseCurrent(leaseValue: AccountLease): Promise<void> {
    const runtime = captureAccountStateAccountRuntime(leaseValue);
    await runtime.withShared(() => undefined);
  }

  private async readEntry<T extends JsonValue>(
    run: DatabaseRunner,
    partition: Partition,
    locatorValue: AccountStateLocator,
  ): Promise<AccountStateEntry<T> | null> {
    const locator = normalizeLocator(locatorValue, partition.ownerTabId);
    return run(async (operation, database) => {
      let result: AccountStateEntry<T> | null = null;
      await runDatabaseTransaction(operation, database, "readonly", (transaction, fail) => {
        const request = transaction.objectStore(STORE).get(entryKey(partition, locator));
        request.onsuccess = () => {
          if (request.result === undefined) return;
          try {
            result = publicEntry<T>(parseStoredRow(request.result, partition, locator));
          } catch (error) {
            fail(error);
          }
        };
      });
      return result;
    });
  }

  private async readPartition<T extends JsonValue>(
    run: DatabaseRunner,
    partition: Partition,
    partitionValue: Pick<AccountStateLocator, "kind" | "tabId">,
  ): Promise<readonly AccountStateEntry<T>[]> {
    const kindValue = partitionValue.kind;
    const tabIdValue = partitionValue.tabId;
    const locator = normalizeLocator({ kind: kindValue, key: "partition", tabId: tabIdValue }, partition.ownerTabId);
    return run(async (operation, database) => {
      let result: readonly AccountStateEntry<T>[] = [];
      await runDatabaseTransaction(operation, database, "readonly", (transaction, fail) => {
        const request = transaction
          .objectStore(STORE)
          .index(INDEX_BY_PARTITION)
          .getAll(partitionKey(partition, locator));
        request.onsuccess = () => {
          try {
            const rows = (request.result as unknown[]).map((value) => parseStoredRow(value, partition));
            rows.sort((left, right) => right.updatedAt - left.updatedAt || right.key.localeCompare(left.key));
            result = Object.freeze(rows.map((row) => publicEntry<T>(row)));
          } catch (error) {
            fail(error);
          }
        };
      });
      return result;
    });
  }

  private async removeEntry(
    run: DatabaseRunner,
    partition: Partition,
    locatorValue: AccountStateLocator,
  ): Promise<void> {
    const locator = normalizeLocator(locatorValue, partition.ownerTabId);
    await run(async (operation, database) => {
      await runDatabaseTransaction(operation, database, "readwrite", (transaction) => {
        transaction.objectStore(STORE).delete(entryKey(partition, locator));
      });
    });
  }

  private async writeEntry<T extends JsonValue>(
    run: DatabaseRunner,
    partition: Partition,
    entryValue: AccountStateEntry<T>,
    optionsValue: PutAccountStateOptions,
    onlyIfAbsent: boolean,
  ): Promise<boolean> {
    const entry = captureEntry(entryValue);
    const maxEntriesValue = optionsValue.maxEntries;
    const locator = normalizeLocator(entry, partition.ownerTabId);
    const row = toStoredRow(partition, entry, locator);
    const maxEntries = normalizeMaxEntries(maxEntriesValue);
    return run(async (operation, database) => {
      let written = false;
      await runDatabaseTransaction(operation, database, "readwrite", (transaction, fail) => {
        const store = transaction.objectStore(STORE);
        const write = (): void => {
          store.put(row);
          written = true;
          if (maxEntries !== undefined) schedulePrune(store, partition, locator, maxEntries, fail);
        };
        if (!onlyIfAbsent) {
          write();
          return;
        }
        const request = store.get(primaryKey(row));
        request.onsuccess = () => {
          if (request.result === undefined) write();
          else {
            try {
              parseStoredRow(request.result, partition, locator);
              if (maxEntries !== undefined) schedulePrune(store, partition, locator, maxEntries, fail);
            } catch (error) {
              fail(error);
            }
          }
        };
      });
      return written;
    });
  }
}
