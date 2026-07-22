import { type ContentDatabaseSpec, type ContentOperation, ContentScopeBarrier } from "./content-barrier.js";
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
  detachAbortSources: () => void;
};

let installedRuntime: InstalledRuntime | null = null;
let lastInstalledSourceView: ViewLease | null = null;
const retiredSourceSignals = new WeakSet<AbortSignal>();
const retiredSourceViews = new WeakMap<AbortSignal, ViewLease[]>();

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

function retireRuntime(runtime: InstalledRuntime): void {
  runtime.detachAbortSources();
  runtime.controller.abort(new SessionError(sessionErrorCodes.staleOperation, "Content view was replaced"));
}

function isRetiredSourceView(lease: ViewLease): boolean {
  return retiredSourceViews.get(lease.signal)?.some((retired) => sameView(retired, lease)) ?? false;
}

function retireSourceView(lease: ViewLease): void {
  const retired = retiredSourceViews.get(lease.signal);
  if (retired) {
    if (!retired.some((candidate) => sameView(candidate, lease))) retired.push(lease);
    return;
  }
  retiredSourceViews.set(lease.signal, [lease]);
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
  const lifecycle = barrier.registry.captureLifecycle();
  if (lifecycle.signal.aborted) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Cannot install during a suspended document lifecycle");
  }

  const controller = new AbortController();
  const forwardSourceAbort = (): void => {
    retiredSourceSignals.add(sourceLease.signal);
    controller.abort(sourceLease.signal.reason);
  };
  const forwardLifecycleAbort = (): void => controller.abort(lifecycle.signal.reason);
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
    detachAbortSources: () => {
      sourceLease.signal.removeEventListener("abort", forwardSourceAbort);
      lifecycle.signal.removeEventListener("abort", forwardLifecycleAbort);
    },
  };

  const previousSourceView = lastInstalledSourceView;
  if (previousSourceView && !sameView(previousSourceView, sourceLease)) {
    if (previousSourceView.signal === sourceLease.signal) {
      retireSourceView(previousSourceView);
    } else {
      retiredSourceSignals.add(previousSourceView.signal);
    }
  }
  lastInstalledSourceView = sourceLease;
  const previous = installedRuntime;
  installedRuntime = runtime;
  if (previous) retireRuntime(previous);

  return () => {
    if (installedRuntime !== runtime) return;
    installedRuntime = null;
    retireRuntime(runtime);
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
      return barrier.withShared(lease, (operation) => callback(operation, lease));
    },
  });
}
