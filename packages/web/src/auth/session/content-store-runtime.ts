import { type ContentDatabaseSpec, type ContentOperation, ContentScopeBarrier } from "./content-barrier.js";
import { type ContentViewHead, readContentViewHead } from "./content-view-head-capability.js";
import { SessionError, sessionErrorCodes } from "./errors.js";
import { PERSISTENT_CONTENT_DATABASES } from "./persistence-inventory.js";
import { createViewLease, sameActivation, type ViewLease, validateViewLease } from "./types.js";

export const CHAT_CONTENT_DATABASE_SPEC: ContentDatabaseSpec = Object.freeze({
  ...PERSISTENT_CONTENT_DATABASES.chatContent,
  databaseVersion: 1,
  upgrade: (database: IDBDatabase): void => {
    if (!database.objectStoreNames.contains("messages")) {
      const messages = database.createObjectStore("messages", {
        keyPath: ["organizationId", "chatId", "messageId"],
      });
      messages.createIndex("by_org_chat_created", ["organizationId", "chatId", "createdAt"], {
        unique: false,
      });
    }
    if (!database.objectStoreNames.contains("read-state")) {
      database.createObjectStore("read-state", { keyPath: ["organizationId", "chatId"] });
    }
  },
});

export const IMAGE_CONTENT_DATABASE_SPEC: ContentDatabaseSpec = Object.freeze({
  ...PERSISTENT_CONTENT_DATABASES.imageContent,
  databaseVersion: 1,
  upgrade: (database: IDBDatabase): void => {
    if (!database.objectStoreNames.contains("images")) {
      database.createObjectStore("images", { keyPath: ["organizationId", "imageId"] });
    }
  },
});

export type ContentStoreRuntimeInstallation = Readonly<{
  barrier: ContentScopeBarrier;
  lease: ViewLease;
  head: ContentViewHead;
}>;

export type CapturedContentStoreRuntime = Readonly<{
  lease: ViewLease;
  withShared<T>(callback: (operation: ContentOperation, lease: ViewLease) => T | PromiseLike<T>): Promise<T>;
}>;

type InstalledRuntime = {
  barrier: ContentScopeBarrier;
  lease: ViewLease;
  sourceLease: ViewLease;
  controller: AbortController;
  assertHeadCurrent: () => Promise<void>;
  detachAbortSources: () => void;
};

let installedRuntime: InstalledRuntime | null = null;
// A React unmount can precede pagehide/freeze. Keep one detached runtime's
// lifecycle observers alive so that later suspension still retires its view.
let dormantRuntime: InstalledRuntime | null = null;
let lastInstalledSourceView: ViewLease | null = null;
const retiredSourceSignals = new WeakSet<AbortSignal>();
// Signal, organization, and document identity are deliberately excluded:
// suspension retires the revision itself, so changing those fields cannot
// revive a view that has not been reconciled onto a fresh org revision.
const retiredViewRevisionKeys = new Set<string>();

function viewRevisionKey(lease: ViewLease): string {
  const { activation } = lease;
  return JSON.stringify([
    activation.sessionEpoch,
    activation.authGeneration,
    activation.transitionPermitId,
    activation.serverAuthority,
    activation.accountId,
    activation.scopeKey,
    lease.orgRevision,
  ]);
}

function sameViewRevision(left: ViewLease, right: ViewLease): boolean {
  return sameActivation(left.activation, right.activation) && left.orgRevision === right.orgRevision;
}

function sameViewIdentity(left: ViewLease, right: ViewLease): boolean {
  return (
    sameActivation(left.activation, right.activation) &&
    left.organizationId === right.organizationId &&
    left.orgRevision === right.orgRevision &&
    left.ownerTabId === right.ownerTabId &&
    left.documentId === right.documentId
  );
}

function sameView(left: ViewLease, right: ViewLease): boolean {
  return sameViewIdentity(left, right) && left.signal === right.signal;
}

function retireRuntime(runtime: InstalledRuntime): void {
  if (dormantRuntime === runtime) dormantRuntime = null;
  runtime.detachAbortSources();
  runtime.controller.abort(new SessionError(sessionErrorCodes.staleOperation, "Content view was replaced"));
}

function parkRuntime(runtime: InstalledRuntime): void {
  if (runtime.controller.signal.aborted) {
    runtime.detachAbortSources();
    if (dormantRuntime === runtime) dormantRuntime = null;
    return;
  }
  if (dormantRuntime && dormantRuntime !== runtime) dormantRuntime.detachAbortSources();
  dormantRuntime = runtime;
  runtime.controller.abort(new SessionError(sessionErrorCodes.staleOperation, "Content view was unmounted"));
}

function isRetiredSourceView(lease: ViewLease): boolean {
  return retiredViewRevisionKeys.has(viewRevisionKey(lease));
}

function retireSourceView(lease: ViewLease): void {
  retiredViewRevisionKeys.add(viewRevisionKey(lease));
}

/**
 * Installs the one authenticated account/org view allowed to use persistent
 * browser content in this document. Replacing it synchronously invalidates
 * every operation that captured the previous view, even if its owner forgot
 * to abort the source lease first.
 */
export function installContentStoreRuntime(input: ContentStoreRuntimeInstallation): () => void {
  const barrier = input.barrier;
  const sourceLeaseValue = input.lease;
  if (!(barrier instanceof ContentScopeBarrier)) {
    throw new SessionError(sessionErrorCodes.invalidState, "Content store runtime requires a scope barrier");
  }
  const sourceLease = validateViewLease(sourceLeaseValue);
  if (sourceLease.signal.aborted || retiredSourceSignals.has(sourceLease.signal) || isRetiredSourceView(sourceLease)) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Cannot install an invalidated content view");
  }
  const assertHeadCurrent = readContentViewHead(input.head, sourceLease);
  const previousSourceView = lastInstalledSourceView;
  if (
    previousSourceView &&
    sameViewRevision(previousSourceView, sourceLease) &&
    !sameView(previousSourceView, sourceLease)
  ) {
    throw new SessionError(sessionErrorCodes.staleOperation, "A content view cannot reuse its source revision");
  }
  const lifecycle = barrier.registry.captureLifecycle();
  if (lifecycle.signal.aborted) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Cannot install during a suspended document lifecycle");
  }

  const controller = new AbortController();
  let runtimeRecord: InstalledRuntime | null = null;
  const clearDormantRuntime = (): void => {
    if (runtimeRecord && dormantRuntime === runtimeRecord) dormantRuntime = null;
  };
  const detachAbortSources = (): void => {
    sourceLease.signal.removeEventListener("abort", forwardSourceAbort);
    lifecycle.signal.removeEventListener("abort", forwardLifecycleAbort);
  };
  const forwardSourceAbort = (): void => {
    retireSourceView(sourceLease);
    retiredSourceSignals.add(sourceLease.signal);
    controller.abort(sourceLease.signal.reason);
    detachAbortSources();
    clearDormantRuntime();
  };
  const forwardLifecycleAbort = (): void => {
    retireSourceView(sourceLease);
    retiredSourceSignals.add(sourceLease.signal);
    controller.abort(lifecycle.signal.reason);
    detachAbortSources();
    clearDormantRuntime();
  };
  sourceLease.signal.addEventListener("abort", forwardSourceAbort, { once: true });
  lifecycle.signal.addEventListener("abort", forwardLifecycleAbort, { once: true });
  if (sourceLease.signal.aborted) forwardSourceAbort();
  if (lifecycle.signal.aborted) forwardLifecycleAbort();
  if (controller.signal.aborted) {
    sourceLease.signal.removeEventListener("abort", forwardSourceAbort);
    lifecycle.signal.removeEventListener("abort", forwardLifecycleAbort);
    throw new SessionError(sessionErrorCodes.staleOperation, "Content view was invalidated during installation");
  }
  const lease = createViewLease({
    activation: sourceLease.activation,
    organizationId: sourceLease.organizationId,
    orgRevision: sourceLease.orgRevision,
    ownerTabId: sourceLease.ownerTabId,
    documentId: sourceLease.documentId,
    signal: controller.signal,
  });
  const runtime: InstalledRuntime = {
    barrier,
    lease,
    sourceLease,
    controller,
    assertHeadCurrent,
    detachAbortSources,
  };
  runtimeRecord = runtime;

  if (previousSourceView && !sameView(previousSourceView, sourceLease)) {
    retireSourceView(previousSourceView);
    if (previousSourceView.signal !== sourceLease.signal) retiredSourceSignals.add(previousSourceView.signal);
  }
  lastInstalledSourceView = sourceLease;
  if (dormantRuntime) {
    dormantRuntime.detachAbortSources();
    dormantRuntime = null;
  }
  const previous = installedRuntime;
  installedRuntime = runtime;
  if (previous) retireRuntime(previous);

  return () => {
    if (installedRuntime !== runtime) return;
    installedRuntime = null;
    parkRuntime(runtime);
  };
}

/**
 * Resolves a closure-only operation capability for the caller's exact,
 * already-captured view. The underlying barrier is never exposed, so a store
 * cannot retain it and later pair it with a different lease.
 * This deliberately has no zero-argument form: a store operation may never
 * authorize itself by consulting a mutable document-global organization.
 */
export function captureContentStoreRuntime(expectedLeaseValue: unknown): CapturedContentStoreRuntime | null {
  const expectedLease = validateViewLease(expectedLeaseValue);
  const current = installedRuntime;
  if (!current) return null;
  if (current.lease.signal.aborted) {
    if (installedRuntime === current) installedRuntime = null;
    retireRuntime(current);
    return null;
  }
  if (!sameView(current.sourceLease, expectedLease)) return null;
  const barrier = current.barrier;
  const lease = current.lease;
  return Object.freeze({
    lease,
    withShared<T>(callback: (operation: ContentOperation, capturedLease: ViewLease) => T | PromiseLike<T>): Promise<T> {
      if (typeof callback !== "function") {
        return Promise.reject(
          new SessionError(sessionErrorCodes.invalidState, "Content store operation requires a callback"),
        );
      }
      return (async () => {
        if (installedRuntime !== current || current.lease.signal.aborted) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Content view was replaced before admission");
        }
        await current.assertHeadCurrent();
        if (installedRuntime !== current || current.lease.signal.aborted) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Content view head changed before admission");
        }
        const value = await barrier.withShared(lease, (operation) => callback(operation, lease));
        await current.assertHeadCurrent();
        if (installedRuntime !== current || current.lease.signal.aborted) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Content view head changed before delivery");
        }
        return value;
      })();
    },
  });
}

/** Explicitly retires the installed organization view (for example when its membership disappears). */
export function retireContentStoreRuntime(): void {
  const current = installedRuntime;
  installedRuntime = null;
  if (current) {
    retireSourceView(current.sourceLease);
    retiredSourceSignals.add(current.sourceLease.signal);
    retireRuntime(current);
  }
  const dormant = dormantRuntime;
  dormantRuntime = null;
  if (dormant && dormant !== current) {
    retireSourceView(dormant.sourceLease);
    retiredSourceSignals.add(dormant.sourceLease.signal);
    retireRuntime(dormant);
  }
}
