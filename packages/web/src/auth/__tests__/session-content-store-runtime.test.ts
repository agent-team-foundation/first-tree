import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStoreFixture } from "../../api/__tests__/scoped-store-fixture.js";
import {
  AuthSessionCoordinator,
  CHAT_CONTENT_DATABASE_SPEC,
  ContentDatabaseRegistry,
  type ContentOperation,
  ContentScopeBarrier,
  type ContentStoreRuntimeInstallation,
  captureContentStoreRuntime,
  closeCoordinatorConnections,
  createAccountScopeKey,
  createActivationCertificate,
  createViewLease,
  IMAGE_CONTENT_DATABASE_SPEC,
  installContentStoreRuntime,
  installSessionLifecycleHooks,
  PERSISTENT_CONTENT_DATABASES,
  type SessionLockManager,
  sessionErrorCodes,
  type ViewLease,
} from "../session/index.js";

const SERVER_AUTHORITY = "https://hub.example.test/api/v1";

const immediateLocks: SessionLockManager = {
  request: async (_name, _options, callback) => callback(),
};

const runtimeDisposers: Array<() => void> = [];

function view(label: string, controller = new AbortController()): ViewLease {
  const accountId = `account-${label}`;
  const activation = createActivationCertificate({
    sessionEpoch: `epoch-${label}`,
    authGeneration: `generation-${label}`,
    transitionPermitId: `permit-${label}`,
    serverAuthority: SERVER_AUTHORITY,
    accountId,
    scopeKey: createAccountScopeKey(SERVER_AUTHORITY, accountId),
  });
  return createViewLease({
    activation,
    organizationId: `org-${label}`,
    orgRevision: `org-revision-${label}`,
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

function install(input: ContentStoreRuntimeInstallation): () => void {
  const dispose = installContentStoreRuntime(input);
  runtimeDisposers.push(dispose);
  return dispose;
}

afterEach(() => {
  for (const dispose of runtimeDisposers.splice(0).reverse()) dispose();
  closeCoordinatorConnections();
  vi.restoreAllMocks();
});

describe("content store runtime", () => {
  it("derives physical chat and image schemas from the authoritative purge inventory", () => {
    expect({
      logicalName: CHAT_CONTENT_DATABASE_SPEC.logicalName,
      namespaceVersion: CHAT_CONTENT_DATABASE_SPEC.namespaceVersion,
    }).toEqual(PERSISTENT_CONTENT_DATABASES.chatContent);
    expect({
      logicalName: IMAGE_CONTENT_DATABASE_SPEC.logicalName,
      namespaceVersion: IMAGE_CONTENT_DATABASE_SPEC.namespaceVersion,
    }).toEqual(PERSISTENT_CONTENT_DATABASES.imageContent);
  });

  it("exposes only a lease-bound closure and rejects a captured view after replacement", async () => {
    const contentBarrier = barrier();
    const leaseA = view("a");
    const leaseB = view("b");
    install({ barrier: contentBarrier, lease: leaseA });
    const capturedA = captureContentStoreRuntime(leaseA);
    if (!capturedA) throw new Error("Expected view A to be installed");

    expect("barrier" in capturedA).toBe(false);
    expect(Object.isFrozen(capturedA)).toBe(true);
    install({ barrier: contentBarrier, lease: leaseB });

    expect(capturedA.lease.signal.aborted).toBe(true);
    expect(captureContentStoreRuntime(leaseA)).toBeNull();
    expect(captureContentStoreRuntime(leaseB)?.lease.organizationId).toBe("org-b");
    const staleCallback = vi.fn();
    await expect(capturedA.withShared(staleCallback)).rejects.toMatchObject({
      code: sessionErrorCodes.staleOperation,
    });
    expect(staleCallback).not.toHaveBeenCalled();
    expect(() => installContentStoreRuntime({ barrier: contentBarrier, lease: leaseA })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );
    expect(captureContentStoreRuntime(leaseB)?.lease.organizationId).toBe("org-b");
  });

  it("cannot reflect a raw barrier or reuse an operation retained across A to B replacement", async () => {
    const fixture = await createStoreFixture({ label: "retained-a", organizationId: "org-a" });
    runtimeDisposers.push(fixture.dispose);
    const capturedA = captureContentStoreRuntime(fixture.lease);
    if (!capturedA) throw new Error("Expected view A runtime");
    let retainedOperation: ContentOperation | undefined;
    let markEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let releaseCallback = (): void => undefined;
    const callbackHeld = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });

    const activeAOutcome = capturedA
      .withShared(async (operation) => {
        retainedOperation = operation;
        expect(Reflect.ownKeys(operation)).toEqual([]);
        expect(Reflect.get(operation, "barrier")).toBeUndefined();
        expect(Reflect.get(operation, "token")).toBeUndefined();
        markEntered();
        await callbackHeld;
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await entered;
    const leaseB = createViewLease({
      ...fixture.lease,
      organizationId: "org-b",
      orgRevision: "revision-b",
      signal: new AbortController().signal,
    });
    install({ barrier: fixture.barrier, lease: leaseB });
    releaseCallback();

    if (!retainedOperation) throw new Error("Expected a retained operation");
    await expect(activeAOutcome).resolves.toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect(captureContentStoreRuntime(fixture.lease)).toBeNull();
    expect(captureContentStoreRuntime(leaseB)).not.toBeNull();
    await expect(retainedOperation.openDatabase(CHAT_CONTENT_DATABASE_SPEC)).rejects.toMatchObject({
      code: sessionErrorCodes.staleOperation,
    });
  });

  it.each([
    "pagehide",
    "freeze",
  ] as const)("retires the installed source view on %s until a fresh view revision is reconciled", (eventName) => {
    const registry = new ContentDatabaseRegistry();
    const contentBarrier = barrier(registry);
    const sourceLease = view(eventName);
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const disposeHooks = installSessionLifecycleHooks({ registry, windowTarget, documentTarget });
    const disposeRuntime = install({ barrier: contentBarrier, lease: sourceLease });
    const captured = captureContentStoreRuntime(sourceLease);
    if (!captured) throw new Error("Expected lifecycle-bound runtime");

    const target = eventName === "pagehide" ? windowTarget : documentTarget;
    target.dispatchEvent(new Event(eventName));

    expect(captured.lease.signal.aborted).toBe(true);
    expect(captureContentStoreRuntime(sourceLease)).toBeNull();
    disposeRuntime();
    expect(() => installContentStoreRuntime({ barrier: contentBarrier, lease: sourceLease })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );

    const forgedRevisionOnOldSignal = createViewLease({
      ...sourceLease,
      orgRevision: `${sourceLease.orgRevision}-forged`,
      signal: sourceLease.signal,
    });
    expect(() =>
      installContentStoreRuntime({ barrier: contentBarrier, lease: forgedRevisionOnOldSignal }),
    ).toThrowError(expect.objectContaining({ code: sessionErrorCodes.staleOperation }));

    const resumeController = new AbortController();
    const forgedSignalOnOldRevision = createViewLease({
      ...sourceLease,
      signal: resumeController.signal,
    });
    expect(() =>
      installContentStoreRuntime({ barrier: contentBarrier, lease: forgedSignalOnOldRevision }),
    ).toThrowError(expect.objectContaining({ code: sessionErrorCodes.staleOperation }));

    const reconciledLease = createViewLease({
      ...sourceLease,
      orgRevision: `${sourceLease.orgRevision}-reconciled`,
      signal: resumeController.signal,
    });
    install({ barrier: contentBarrier, lease: reconciledLease });
    expect(captureContentStoreRuntime(sourceLease)).toBeNull();
    expect(captureContentStoreRuntime(reconciledLease)?.lease.signal.aborted).toBe(false);

    const retiredRevisionWithForgedContext = createViewLease({
      ...sourceLease,
      organizationId: `${sourceLease.organizationId}-forged`,
      ownerTabId: `${sourceLease.ownerTabId}-forged`,
      documentId: `${sourceLease.documentId}-forged`,
      signal: new AbortController().signal,
    });
    expect(() =>
      installContentStoreRuntime({ barrier: contentBarrier, lease: retiredRevisionWithForgedContext }),
    ).toThrowError(expect.objectContaining({ code: sessionErrorCodes.staleOperation }));
    expect(captureContentStoreRuntime(reconciledLease)?.lease.signal.aborted).toBe(false);
    disposeHooks();
  });

  it.each([
    "pagehide",
    "freeze",
  ] as const)("retires a source on %s even when its runtime was already disposed", (eventName) => {
    const registry = new ContentDatabaseRegistry();
    const contentBarrier = barrier(registry);
    const sourceLease = view(`disposed-${eventName}`);
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const disposeHooks = installSessionLifecycleHooks({ registry, windowTarget, documentTarget });
    const disposeRuntime = install({ barrier: contentBarrier, lease: sourceLease });

    disposeRuntime();
    expect(captureContentStoreRuntime(sourceLease)).toBeNull();
    const target = eventName === "pagehide" ? windowTarget : documentTarget;
    target.dispatchEvent(new Event(eventName));

    expect(() => installContentStoreRuntime({ barrier: contentBarrier, lease: sourceLease })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );

    const forgedRevisionOnOldSignal = createViewLease({
      ...sourceLease,
      orgRevision: `${sourceLease.orgRevision}-forged`,
    });
    expect(() =>
      installContentStoreRuntime({ barrier: contentBarrier, lease: forgedRevisionOnOldSignal }),
    ).toThrowError(expect.objectContaining({ code: sessionErrorCodes.staleOperation }));

    const resumeController = new AbortController();
    const forgedSignalOnOldRevision = createViewLease({
      ...sourceLease,
      signal: resumeController.signal,
    });
    expect(() =>
      installContentStoreRuntime({ barrier: contentBarrier, lease: forgedSignalOnOldRevision }),
    ).toThrowError(expect.objectContaining({ code: sessionErrorCodes.staleOperation }));

    const reconciledLease = createViewLease({
      ...sourceLease,
      orgRevision: `${sourceLease.orgRevision}-reconciled`,
      signal: resumeController.signal,
    });
    install({ barrier: contentBarrier, lease: reconciledLease });
    expect(captureContentStoreRuntime(reconciledLease)).not.toBeNull();

    const retiredRevisionWithForgedContext = createViewLease({
      ...sourceLease,
      organizationId: `${sourceLease.organizationId}-forged`,
      ownerTabId: `${sourceLease.ownerTabId}-forged`,
      documentId: `${sourceLease.documentId}-forged`,
      signal: new AbortController().signal,
    });
    expect(() =>
      installContentStoreRuntime({ barrier: contentBarrier, lease: retiredRevisionWithForgedContext }),
    ).toThrowError(expect.objectContaining({ code: sessionErrorCodes.staleOperation }));
    expect(captureContentStoreRuntime(reconciledLease)?.lease.signal.aborted).toBe(false);
    disposeHooks();
  });

  it("allows an exact source to remount after ordinary hidden without retiring its view", () => {
    const registry = new ContentDatabaseRegistry();
    const contentBarrier = barrier(registry);
    const sourceLease = view("ordinary-hidden-remount");
    const windowTarget = new EventTarget();
    const documentTarget = Object.assign(new EventTarget(), { visibilityState: "hidden" as const });
    const disposeHooks = installSessionLifecycleHooks({ registry, windowTarget, documentTarget });
    const disposeRuntime = install({ barrier: contentBarrier, lease: sourceLease });

    disposeRuntime();
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    expect(() => install({ barrier: contentBarrier, lease: sourceLease })).not.toThrow();
    expect(captureContentStoreRuntime(sourceLease)).not.toBeNull();
    disposeHooks();
  });

  it("invalidates the installed runtime when its source view aborts", () => {
    const controller = new AbortController();
    const sourceLease = view("source", controller);
    install({ barrier: barrier(), lease: sourceLease });
    const captured = captureContentStoreRuntime(sourceLease);
    if (!captured) throw new Error("Expected source-bound runtime");

    controller.abort(new Error("org view retired"));

    expect(captured.lease.signal.aborted).toBe(true);
    expect(captureContentStoreRuntime(sourceLease)).toBeNull();
  });

  it("does not let an older disposer clear an identical-source reinstallation", () => {
    const contentBarrier = barrier();
    const sourceLease = view("same");
    const disposeFirst = install({ barrier: contentBarrier, lease: sourceLease });
    const capturedFirst = captureContentStoreRuntime(sourceLease);
    if (!capturedFirst) throw new Error("Expected first runtime");
    const disposeSecond = install({ barrier: contentBarrier, lease: sourceLease });
    const capturedSecond = captureContentStoreRuntime(sourceLease);
    if (!capturedSecond) throw new Error("Expected second runtime");

    expect(capturedFirst.lease.signal.aborted).toBe(true);
    expect(capturedSecond.lease.signal.aborted).toBe(false);
    disposeFirst();
    expect(captureContentStoreRuntime(sourceLease)?.lease.signal).toBe(capturedSecond.lease.signal);

    disposeSecond();
    expect(captureContentStoreRuntime(sourceLease)).toBeNull();
  });

  it("retires an old org view even when a buggy caller reuses one source signal", () => {
    const contentBarrier = barrier();
    const controller = new AbortController();
    const sourceA = view("shared-signal", controller);
    const sourceB = createViewLease({
      ...sourceA,
      organizationId: "org-shared-signal-b",
      orgRevision: "org-revision-shared-signal-b",
      signal: controller.signal,
    });
    install({ barrier: contentBarrier, lease: sourceA });
    install({ barrier: contentBarrier, lease: sourceB });

    expect(captureContentStoreRuntime(sourceB)?.lease.organizationId).toBe("org-shared-signal-b");
    expect(() => installContentStoreRuntime({ barrier: contentBarrier, lease: sourceA })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );
    const recreatedA = createViewLease({
      ...sourceA,
      signal: new AbortController().signal,
    });
    expect(() => installContentStoreRuntime({ barrier: contentBarrier, lease: recreatedA })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );
    expect(captureContentStoreRuntime(sourceA)).toBeNull();
    expect(captureContentStoreRuntime(sourceB)?.lease.organizationId).toBe("org-shared-signal-b");
  });

  it("rejects changing only the source signal without a reconciled view revision", () => {
    const contentBarrier = barrier();
    const sourceLease = view("signal-swap");
    install({ barrier: contentBarrier, lease: sourceLease });
    const swappedSignalLease = createViewLease({
      ...sourceLease,
      signal: new AbortController().signal,
    });

    expect(() => installContentStoreRuntime({ barrier: contentBarrier, lease: swappedSignalLease })).toThrowError(
      expect.objectContaining({ code: sessionErrorCodes.staleOperation }),
    );
    expect(captureContentStoreRuntime(sourceLease)).not.toBeNull();
    expect(captureContentStoreRuntime(swappedSignalLease)).toBeNull();
  });

  it("snapshots installation getters exactly once", () => {
    const contentBarrier = barrier();
    const sourceLease = view("getter");
    let barrierReads = 0;
    let leaseReads = 0;
    const input: ContentStoreRuntimeInstallation = {
      get barrier() {
        barrierReads += 1;
        return contentBarrier;
      },
      get lease() {
        leaseReads += 1;
        return sourceLease;
      },
    };

    install(input);

    expect(barrierReads).toBe(1);
    expect(leaseReads).toBe(1);
    expect(captureContentStoreRuntime(sourceLease)).not.toBeNull();
  });

  it("snapshots every nested lease field before validation", () => {
    const contentBarrier = barrier();
    const sourceLease = view("nested-getter");
    const reads = new Map<string, number>();
    const read = <T>(name: string, value: T): T => {
      reads.set(name, (reads.get(name) ?? 0) + 1);
      return value;
    };
    const getterLease = {
      get activation() {
        return read("activation", sourceLease.activation);
      },
      get organizationId() {
        return read("organizationId", sourceLease.organizationId);
      },
      get orgRevision() {
        return read("orgRevision", sourceLease.orgRevision);
      },
      get ownerTabId() {
        return read("ownerTabId", sourceLease.ownerTabId);
      },
      get documentId() {
        return read("documentId", sourceLease.documentId);
      },
      get signal() {
        return read("signal", sourceLease.signal);
      },
    } as ViewLease;

    install({ barrier: contentBarrier, lease: getterLease });

    expect(Object.fromEntries(reads)).toEqual({
      activation: 1,
      organizationId: 1,
      orgRevision: 1,
      ownerTabId: 1,
      documentId: 1,
      signal: 1,
    });
    expect(captureContentStoreRuntime(sourceLease)).not.toBeNull();
  });
});
