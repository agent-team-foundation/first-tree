import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AccountLease,
  AuthSessionCoordinator,
  ContentDatabaseRegistry,
  ContentScopeBarrier,
  captureAccountStoreRuntime,
  closeCoordinatorConnections,
  createAccountLease,
  createAccountScopeKey,
  createActivationCertificate,
  installAccountStoreRuntime,
  installSessionLifecycleHooks,
  type SessionLockManager,
  sessionErrorCodes,
} from "../session/index.js";

const SERVER_AUTHORITY = "https://hub.example.test/api/v1";
const immediateLocks: SessionLockManager = {
  request: async (_name, _options, callback) => callback(),
};
const runtimeDisposers: Array<() => void> = [];

function lease(label: string, controller = new AbortController()): AccountLease {
  const accountId = `account-${label}`;
  const activation = createActivationCertificate({
    sessionEpoch: `epoch-${label}`,
    authGeneration: `generation-${label}`,
    transitionPermitId: `permit-${label}`,
    serverAuthority: SERVER_AUTHORITY,
    accountId,
    scopeKey: createAccountScopeKey(SERVER_AUTHORITY, accountId),
  });
  return createAccountLease({
    activation,
    accountRevision: `account-revision-${label}`,
    ownerTabId: `owner-tab-${label}`,
    documentId: `document-${label}`,
    signal: controller.signal,
  });
}

function barrier(registry = new ContentDatabaseRegistry()): ContentScopeBarrier {
  return new ContentScopeBarrier({
    coordinator: new AuthSessionCoordinator({ indexedDB: new IDBFactory() }),
    indexedDB: new IDBFactory(),
    locks: immediateLocks,
    registry,
  });
}

function install(contentBarrier: ContentScopeBarrier, accountLease: AccountLease): () => void {
  const dispose = installAccountStoreRuntime({ barrier: contentBarrier, lease: accountLease });
  runtimeDisposers.push(dispose);
  return dispose;
}

afterEach(() => {
  for (const dispose of runtimeDisposers.splice(0).reverse()) dispose();
  closeCoordinatorConnections();
});

describe("account store runtime", () => {
  it("exposes only a bound closure and retires a replaced account revision", async () => {
    const contentBarrier = barrier();
    const first = lease("runtime-a");
    const second = lease("runtime-b");
    install(contentBarrier, first);
    const captured = captureAccountStoreRuntime(first);
    if (!captured) throw new Error("Expected account runtime A");
    expect(Object.isFrozen(captured)).toBe(true);
    expect("barrier" in captured).toBe(false);
    await expect(contentBarrier.withAccountShared(first, () => undefined)).rejects.toMatchObject({
      code: sessionErrorCodes.staleOperation,
    });

    install(contentBarrier, second);
    expect(captured.lease.signal.aborted).toBe(true);
    expect(captureAccountStoreRuntime(first)).toBeNull();
    expect(captureAccountStoreRuntime(second)).not.toBeNull();
    expect(() => installAccountStoreRuntime({ barrier: contentBarrier, lease: first })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );
  });

  it.each([
    "pagehide",
    "freeze",
  ] as const)("retires the account revision on %s until a fresh reconciliation", (eventName) => {
    const registry = new ContentDatabaseRegistry();
    const contentBarrier = barrier(registry);
    const source = lease(`runtime-${eventName}`);
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const disposeHooks = installSessionLifecycleHooks({ registry, windowTarget, documentTarget });
    install(contentBarrier, source);
    const captured = captureAccountStoreRuntime(source);
    if (!captured) throw new Error("Expected lifecycle-bound account runtime");

    (eventName === "pagehide" ? windowTarget : documentTarget).dispatchEvent(new Event(eventName));
    expect(captured.lease.signal.aborted).toBe(true);
    expect(captureAccountStoreRuntime(source)).toBeNull();
    expect(() => installAccountStoreRuntime({ barrier: contentBarrier, lease: source })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );

    const newSignalOldRevision = createAccountLease({
      ...source,
      signal: new AbortController().signal,
    });
    expect(() => installAccountStoreRuntime({ barrier: contentBarrier, lease: newSignalOldRevision })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );
    const forgedOwnerOldRevision = createAccountLease({
      ...source,
      ownerTabId: `${source.ownerTabId}-forged`,
      documentId: `${source.documentId}-forged`,
      signal: new AbortController().signal,
    });
    expect(() => installAccountStoreRuntime({ barrier: contentBarrier, lease: forgedOwnerOldRevision })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );

    const reconciled = createAccountLease({
      ...source,
      accountRevision: `${source.accountRevision}-reconciled`,
      signal: new AbortController().signal,
    });
    install(contentBarrier, reconciled);
    expect(captureAccountStoreRuntime(reconciled)?.lease.signal.aborted).toBe(false);
    disposeHooks();
  });

  it.each(["pagehide", "freeze"] as const)("retires a disposed source when %s happens later", (eventName) => {
    const registry = new ContentDatabaseRegistry();
    const contentBarrier = barrier(registry);
    const source = lease(`runtime-disposed-${eventName}`);
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const disposeHooks = installSessionLifecycleHooks({ registry, windowTarget, documentTarget });
    const disposeRuntime = install(contentBarrier, source);
    disposeRuntime();

    (eventName === "pagehide" ? windowTarget : documentTarget).dispatchEvent(new Event(eventName));
    expect(() => installAccountStoreRuntime({ barrier: contentBarrier, lease: source })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );
    const newSignalOldRevision = createAccountLease({ ...source, signal: new AbortController().signal });
    expect(() => installAccountStoreRuntime({ barrier: contentBarrier, lease: newSignalOldRevision })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );
    disposeHooks();
  });

  it("allows an exact ordinary-unmount remount before suspension", () => {
    const contentBarrier = barrier();
    const source = lease("runtime-remount");
    const dispose = install(contentBarrier, source);
    dispose();
    install(contentBarrier, source);
    expect(captureAccountStoreRuntime(source)).not.toBeNull();
  });
});
