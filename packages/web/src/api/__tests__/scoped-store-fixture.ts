import { IDBFactory } from "fake-indexeddb";
import { vi } from "vitest";
import { mintContentViewHead } from "../../auth/session/content-view-head-capability.js";
import {
  type AccountLease,
  type ActivationCertificate,
  AuthSessionCoordinator,
  ContentScopeBarrier,
  createAccountLease,
  createAccountScopeKey,
  createActivationCertificate,
  createSessionAttempt,
  createViewLease,
  installAccountStoreRuntime,
  installContentStoreRuntime,
  type SessionLockManager,
  type SessionLockOptions,
  type StorageArea,
  type VerifiedCandidateMeResult,
  type ViewLease,
} from "../../auth/session/index.js";

export class ImmediateTestLocks implements SessionLockManager {
  public request<T>(_name: string, options: SessionLockOptions, callback: () => T | PromiseLike<T>): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(new DOMException("Lock cancelled", "AbortError"));
    return Promise.resolve().then(callback);
  }
}

export type StoreFixture = {
  factory: IDBFactory;
  coordinator: AuthSessionCoordinator;
  barrier: ContentScopeBarrier;
  activation: ActivationCertificate;
  accountLease: AccountLease;
  accountController: AbortController;
  lease: ViewLease;
  localStorage: StorageArea;
  sessionStorage: StorageArea;
  dispose: () => void;
  disposeAccount: () => void;
};

type ActivateOptions = Readonly<{
  label: string;
  serverAuthority?: string;
  accountId?: string;
  organizationId?: string;
  documentId?: string;
  orgRevision?: string;
}>;

function certificate(options: ActivateOptions, generation: string): ActivationCertificate {
  const serverAuthority = options.serverAuthority ?? "https://hub.example.test/api/v1";
  const accountId = options.accountId ?? `account-${options.label}`;
  return createActivationCertificate({
    sessionEpoch: `epoch-${options.label}`,
    authGeneration: generation,
    transitionPermitId: `permit-${options.label}`,
    serverAuthority,
    accountId,
    scopeKey: createAccountScopeKey(serverAuthority, accountId),
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

export function memoryStorage(initial: Readonly<Record<string, string>> = {}): StorageArea {
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

async function activateFromAnonymous(
  factory: IDBFactory,
  coordinator: AuthSessionCoordinator,
  barrier: ContentScopeBarrier,
  options: ActivateOptions,
  localStorage: StorageArea,
  sessionStorage: StorageArea,
): Promise<StoreFixture> {
  const anonymous = await coordinator.readAuthority();
  if (anonymous.mode !== "none") throw new Error("Fixture activation requires anonymous authority");
  const targetGeneration = `generation-${options.label}`;
  const activation = certificate(options, targetGeneration);
  const expiresAt = Date.now() + 60_000;
  const attempt = createSessionAttempt({
    attemptId: `attempt-${options.label}`,
    kind: "acquisition",
    serverAuthority: activation.serverAuthority,
    baselineGeneration: anonymous.generation,
    sourceEpoch: null,
    expiresAt,
    payload: { mappedTab: options.documentId ?? `document-${options.label}` },
  });
  if (attempt.kind !== "acquisition") throw new Error("Expected acquisition attempt fixture");
  await coordinator.putAttempt(attempt);
  const cursor = await coordinator.readAuthority();
  const accessToken = jwt(activation.accountId, "access", `access-${options.label}`);
  const refreshToken = jwt(activation.accountId, "refresh", `refresh-${options.label}`);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ user: { id: activation.accountId } }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  let verified: VerifiedCandidateMeResult;
  try {
    verified = await coordinator.requestCandidateMe({
      candidate: { accessToken, refreshToken },
      attempt,
      serverAuthority: activation.serverAuthority,
      signal: new AbortController().signal,
    });
  } finally {
    fetchSpy.mockRestore();
  }
  const permit = await coordinator.reserveAcquisitionTransition(
    { generation: cursor.generation, revision: cursor.revision },
    verified.proof,
    activation,
    null,
  );
  await coordinator.completeAcquisitionTransition(permit, verified.proof);

  const sourceController = new AbortController();
  const accountLease = createAccountLease({
    activation,
    accountRevision: `account-revision-${options.label}`,
    ownerTabId: `owner-tab-${options.label}`,
    documentId: options.documentId ?? `document-${options.label}`,
    signal: sourceController.signal,
  });
  const disposeAccount = installAccountStoreRuntime({ barrier, lease: accountLease });
  const lease = createViewLease({
    activation,
    organizationId: options.organizationId ?? `org-${options.label}`,
    orgRevision: options.orgRevision ?? `org-revision-${options.label}`,
    ownerTabId: `owner-tab-${options.label}`,
    documentId: options.documentId ?? `document-${options.label}`,
    signal: sourceController.signal,
  });
  const disposeView = installContentStoreRuntime({
    barrier,
    lease,
    head: mintContentViewHead(lease, async () => undefined),
  });
  const dispose = (): void => {
    disposeView();
    disposeAccount();
  };
  return {
    factory,
    coordinator,
    barrier,
    activation,
    accountLease,
    accountController: sourceController,
    lease,
    localStorage,
    sessionStorage,
    dispose,
    disposeAccount,
  };
}

export async function createStoreFixture(
  options: ActivateOptions,
  locks: SessionLockManager = new ImmediateTestLocks(),
): Promise<StoreFixture> {
  const factory = new IDBFactory();
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const coordinator = new AuthSessionCoordinator({
    indexedDB: factory,
    legacyPersistence: { indexedDB: factory, localStorage, sessionStorage },
  });
  await coordinator.bootstrapAnonymous(`anonymous-${options.label}`);
  const barrier = new ContentScopeBarrier({ coordinator, indexedDB: factory, locks });
  return activateFromAnonymous(factory, coordinator, barrier, options, localStorage, sessionStorage);
}

export async function replaceStoreFixture(source: StoreFixture, options: ActivateOptions): Promise<StoreFixture> {
  const retiringGeneration = `retiring-${options.label}`;
  const anonymousGeneration = `anonymous-${options.label}`;
  source.dispose();
  await source.coordinator.beginRetirement(source.activation, "logout", retiringGeneration);
  const receipt = await source.barrier.purgeAccountScope(source.activation, {
    localStorage: source.localStorage,
    sessionStorage: source.sessionStorage,
  });
  await source.coordinator.completeRetirement(source.activation, receipt, anonymousGeneration);
  return activateFromAnonymous(
    source.factory,
    source.coordinator,
    source.barrier,
    options,
    source.localStorage,
    source.sessionStorage,
  );
}

export function replaceOrganization(source: StoreFixture, options: ActivateOptions): StoreFixture {
  const lease = createViewLease({
    activation: source.activation,
    organizationId: options.organizationId ?? `org-${options.label}`,
    orgRevision: options.orgRevision ?? `org-revision-${options.label}`,
    ownerTabId: source.lease.ownerTabId,
    documentId: options.documentId ?? source.lease.documentId,
    signal: new AbortController().signal,
  });
  const disposeView = installContentStoreRuntime({
    barrier: source.barrier,
    lease,
    head: mintContentViewHead(lease, async () => undefined),
  });
  const dispose = (): void => {
    disposeView();
    source.disposeAccount();
  };
  return { ...source, lease, dispose };
}

export async function databaseNames(factory: IDBFactory): Promise<string[]> {
  return (await factory.databases()).flatMap((entry) => (entry.name ? [entry.name] : []));
}

/** Seeds a deliberately raw row for corruption and legacy-shape regressions. */
export async function putRawStoreRow(
  factory: IDBFactory,
  databaseName: string,
  storeName: string,
  value: unknown,
): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Could not open ${databaseName}`));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error(`Could not seed ${storeName}`));
      transaction.onabort = () => reject(transaction.error ?? new Error(`Seeding ${storeName} was aborted`));
    });
  } finally {
    database.close();
  }
}
