import { SessionError, sessionErrorCodes, toSessionError } from "./errors.js";
import { deleteDatabaseBarrier } from "./idb-delete-barrier.js";

export const LEGACY_DATABASE_NAMES = Object.freeze([
  "first-tree-chat-cache",
  "first-tree-images",
  "first-tree-hub-chat-cache",
  "first-tree-hub-images",
] as const);

export const LEGACY_LOCAL_STORAGE_KEYS = Object.freeze([
  "first-tree:tokens",
  "first-tree-hub:tokens",
  "first-tree:chat-drafts:v1",
  "first-tree:selectedOrganizationId",
  "first-tree-hub:selectedOrganizationId",
  "onboarding:bannerDismissed",
] as const);

export const LEGACY_LOCAL_STORAGE_PREFIXES = Object.freeze([
  "first-tree:selectedOrganizationId:",
  "first-tree:new-chat-default-agent:",
  "first-tree:chat-summary-expanded:v1:",
  "first-tree:chat-task-summary-expanded:v1:",
  "first-tree:chat-summary-dismissed-version:v1:",
] as const);

export const LEGACY_SESSION_STORAGE_KEYS = Object.freeze([
  "settings:github:install-attempt",
  "context-build:install-attempt",
  "first-tree:quickstart:intent",
  "first-tree:quickstart:agent",
  "first-tree:auth-attempt",
] as const);

export const LEGACY_SESSION_STORAGE_PREFIXES = Object.freeze(["onboarding:"] as const);

export type StorageArea = Pick<Storage, "length" | "key" | "getItem" | "removeItem">;

export type LegacyStorageAreas = Readonly<{
  localStorage: StorageArea;
  sessionStorage: StorageArea;
}>;

export type LegacyScrubOptions = LegacyStorageAreas &
  Readonly<{
    indexedDB?: IDBFactory;
    onDatabaseBlocked?: (databaseName: string) => void;
  }>;

export type LegacyStorageScrubResult = Readonly<{
  localStorageKeysRemoved: number;
  sessionStorageKeysRemoved: number;
}>;

export type LegacyScrubResult = LegacyStorageScrubResult &
  Readonly<{
    databasesDeleted: number;
  }>;

const legacyScrubCompletionBrand: unique symbol = Symbol("first-tree.legacy-scrub-completion");

export type LegacyScrubCompletion = LegacyScrubResult &
  Readonly<{
    [legacyScrubCompletionBrand]: true;
  }>;

type LegacyScrubCompletionState = {
  receipt: string;
  state: "available" | "claimed" | "consumed";
};

const legacyScrubCompletions = new WeakMap<LegacyScrubCompletion, LegacyScrubCompletionState>();

/** Internal coordinator bridge. A caller-selected string can never stand in for a completed scrub. */
export function claimLegacyScrubCompletion(value: unknown): Readonly<{
  receipt: string;
  settle: (committed: boolean) => void;
}> {
  if (typeof value !== "object" || value === null) {
    throw new SessionError(sessionErrorCodes.invalidState, "Legacy scrub completion is malformed");
  }
  const completion = value as LegacyScrubCompletion;
  const state = legacyScrubCompletions.get(completion);
  if (!state || state.state !== "available") {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Legacy scrub completion is unavailable");
  }
  state.state = "claimed";
  let settled = false;
  return Object.freeze({
    receipt: state.receipt,
    settle: (committed: boolean): void => {
      if (settled) return;
      settled = true;
      state.state = committed ? "consumed" : "available";
    },
  });
}

function createLegacyScrubReceipt(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new SessionError(sessionErrorCodes.platformUnavailable, "Secure randomness is required for legacy cleanup");
  }
  return `legacy-scrub-v1:${globalThis.crypto.randomUUID()}`;
}

function collectMatchingKeys(
  storage: StorageArea,
  exactKeys: readonly string[],
  prefixes: readonly string[],
): string[] {
  const exact = new Set(exactKeys);
  const matches = new Set<string>();
  let length: number;
  try {
    length = storage.length;
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (key !== null && (exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix)))) matches.add(key);
    }
  } catch (error) {
    throw toSessionError(error, sessionErrorCodes.persistenceUnavailable, "Legacy Web Storage could not be enumerated");
  }
  return [...matches];
}

function removeAndVerify(storage: StorageArea, keys: readonly string[]): number {
  for (const key of keys) {
    try {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) {
        throw new SessionError(sessionErrorCodes.persistenceUnavailable, `Legacy Web Storage key remained: ${key}`);
      }
    } catch (error) {
      throw toSessionError(
        error,
        sessionErrorCodes.persistenceUnavailable,
        "Legacy Web Storage removal could not be verified",
      );
    }
  }
  return keys.length;
}

function getIndexedDbFactory(explicitFactory?: IDBFactory): IDBFactory {
  if (explicitFactory) return explicitFactory;
  if (typeof indexedDB === "undefined") {
    throw new SessionError(sessionErrorCodes.persistenceUnavailable, "IndexedDB is required for legacy cleanup");
  }
  return indexedDB;
}

export function scrubLegacyWebStorage(areas: LegacyStorageAreas): LegacyStorageScrubResult {
  const localKeys = collectMatchingKeys(areas.localStorage, LEGACY_LOCAL_STORAGE_KEYS, LEGACY_LOCAL_STORAGE_PREFIXES);
  const sessionKeys = collectMatchingKeys(
    areas.sessionStorage,
    LEGACY_SESSION_STORAGE_KEYS,
    LEGACY_SESSION_STORAGE_PREFIXES,
  );
  return Object.freeze({
    localStorageKeysRemoved: removeAndVerify(areas.localStorage, localKeys),
    sessionStorageKeysRemoved: removeAndVerify(areas.sessionStorage, sessionKeys),
  });
}

export async function scrubLegacyDatabases(
  factory: IDBFactory,
  onBlocked?: (databaseName: string) => void,
): Promise<number> {
  for (const databaseName of LEGACY_DATABASE_NAMES) {
    await deleteDatabaseBarrier(factory, databaseName, onBlocked);
  }
  return LEGACY_DATABASE_NAMES.length;
}

export async function scrubLegacyPersistence(options: LegacyScrubOptions): Promise<LegacyScrubCompletion> {
  const storage = scrubLegacyWebStorage(options);
  const databasesDeleted = await scrubLegacyDatabases(
    getIndexedDbFactory(options.indexedDB),
    options.onDatabaseBlocked,
  );
  const completion = Object.freeze({ ...storage, databasesDeleted }) as LegacyScrubCompletion;
  legacyScrubCompletions.set(completion, { receipt: createLegacyScrubReceipt(), state: "available" });
  return completion;
}
