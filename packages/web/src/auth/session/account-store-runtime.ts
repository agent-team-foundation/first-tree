import { mintBoundAccountLease, revokeBoundAccountLease } from "./account-lease-capability.js";
import { type AccountContentOperation, ContentScopeBarrier } from "./content-barrier.js";
import { SessionError, sessionErrorCodes } from "./errors.js";
import { type AccountLease, sameAccountLease, sameActivation, validateAccountLease } from "./types.js";

export type AccountStoreRuntimeInstallation = Readonly<{
  barrier: ContentScopeBarrier;
  lease: AccountLease;
}>;

export type CapturedAccountStoreRuntime = Readonly<{
  lease: AccountLease;
  sourceLease: AccountLease;
  withShared<T>(callback: (operation: AccountContentOperation, lease: AccountLease) => T | PromiseLike<T>): Promise<T>;
}>;

export type CapturedAccountRuntimeFence = Readonly<{
  sourceLease: AccountLease;
  lease: AccountLease;
  assertCurrent: () => void;
}>;

type InstalledAccountRuntime = {
  barrier: ContentScopeBarrier;
  sourceLease: AccountLease;
  lease: AccountLease;
  controller: AbortController;
  detachAbortSources: () => void;
};

let installedRuntime: InstalledAccountRuntime | null = null;
let dormantRuntime: InstalledAccountRuntime | null = null;
let lastInstalledSource: AccountLease | null = null;
const retiredSourceSignals = new WeakSet<AbortSignal>();
const retiredRevisionKeys = new Set<string>();

function revisionKey(lease: AccountLease): string {
  const { activation } = lease;
  return JSON.stringify([
    activation.sessionEpoch,
    activation.authGeneration,
    activation.transitionPermitId,
    activation.serverAuthority,
    activation.accountId,
    activation.scopeKey,
    lease.accountRevision,
  ]);
}

function sameRevision(left: AccountLease, right: AccountLease): boolean {
  return sameActivation(left.activation, right.activation) && left.accountRevision === right.accountRevision;
}

function retireRevision(source: AccountLease): void {
  retiredRevisionKeys.add(revisionKey(source));
}

function retireSource(source: AccountLease): void {
  retireRevision(source);
  retiredSourceSignals.add(source.signal);
}

function detachRuntime(runtime: InstalledAccountRuntime): void {
  runtime.detachAbortSources();
  revokeBoundAccountLease(runtime.lease);
  runtime.controller.abort(new SessionError(sessionErrorCodes.staleOperation, "Account runtime was replaced"));
}

function parkRuntime(runtime: InstalledAccountRuntime): void {
  if (runtime.controller.signal.aborted) {
    runtime.detachAbortSources();
    revokeBoundAccountLease(runtime.lease);
    if (dormantRuntime === runtime) dormantRuntime = null;
    return;
  }
  if (dormantRuntime && dormantRuntime !== runtime) dormantRuntime.detachAbortSources();
  dormantRuntime = runtime;
  revokeBoundAccountLease(runtime.lease);
  runtime.controller.abort(new SessionError(sessionErrorCodes.staleOperation, "Account runtime was unmounted"));
}

/**
 * Installs the sole account-level browser-storage authority for this document.
 * An ordinary unmount may remount the exact source, while pagehide/freeze or
 * replacement retires its revision so a fresh signal cannot resurrect it.
 */
export function installAccountStoreRuntime(input: AccountStoreRuntimeInstallation): () => void {
  const barrier = input.barrier;
  if (!(barrier instanceof ContentScopeBarrier)) {
    throw new SessionError(sessionErrorCodes.invalidState, "Account store runtime requires a scope barrier");
  }
  const sourceLease = validateAccountLease(input.lease);
  if (
    sourceLease.signal.aborted ||
    retiredSourceSignals.has(sourceLease.signal) ||
    retiredRevisionKeys.has(revisionKey(sourceLease))
  ) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Cannot install an invalidated account runtime");
  }
  const previousSource = lastInstalledSource;
  if (previousSource && sameRevision(previousSource, sourceLease) && !sameAccountLease(previousSource, sourceLease)) {
    throw new SessionError(sessionErrorCodes.staleOperation, "An account runtime cannot reuse its source revision");
  }
  const lifecycle = barrier.registry.captureLifecycle();
  if (lifecycle.signal.aborted) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Cannot install during a suspended document lifecycle");
  }

  const controller = new AbortController();
  let runtimeRecord: InstalledAccountRuntime | null = null;
  const clearDormant = (): void => {
    if (runtimeRecord && dormantRuntime === runtimeRecord) dormantRuntime = null;
  };
  const detachAbortSources = (): void => {
    sourceLease.signal.removeEventListener("abort", forwardSourceAbort);
    lifecycle.signal.removeEventListener("abort", forwardLifecycleAbort);
  };
  const retire = (reason: unknown): void => {
    retireSource(sourceLease);
    if (runtimeRecord) revokeBoundAccountLease(runtimeRecord.lease);
    controller.abort(reason);
    detachAbortSources();
    clearDormant();
  };
  const forwardSourceAbort = (): void => retire(sourceLease.signal.reason);
  const forwardLifecycleAbort = (): void => retire(lifecycle.signal.reason);
  sourceLease.signal.addEventListener("abort", forwardSourceAbort, { once: true });
  lifecycle.signal.addEventListener("abort", forwardLifecycleAbort, { once: true });
  if (sourceLease.signal.aborted) forwardSourceAbort();
  if (lifecycle.signal.aborted) forwardLifecycleAbort();
  if (controller.signal.aborted) {
    detachAbortSources();
    throw new SessionError(sessionErrorCodes.staleOperation, "Account runtime was invalidated during installation");
  }

  const lease = mintBoundAccountLease(sourceLease, controller.signal, barrier);
  const runtime: InstalledAccountRuntime = {
    barrier,
    sourceLease,
    lease,
    controller,
    detachAbortSources,
  };
  runtimeRecord = runtime;

  if (previousSource && !sameAccountLease(previousSource, sourceLease)) {
    retireRevision(previousSource);
    if (previousSource.signal !== sourceLease.signal) retiredSourceSignals.add(previousSource.signal);
  }
  lastInstalledSource = sourceLease;
  if (dormantRuntime) {
    dormantRuntime.detachAbortSources();
    dormantRuntime = null;
  }
  const previous = installedRuntime;
  installedRuntime = runtime;
  if (previous) detachRuntime(previous);

  return () => {
    if (installedRuntime !== runtime) return;
    installedRuntime = null;
    parkRuntime(runtime);
  };
}

/** Internal exact-runtime fence used by active identity requests. */
export function captureAccountRuntimeFence(expectedLeaseValue: unknown): CapturedAccountRuntimeFence | null {
  const expectedLease = validateAccountLease(expectedLeaseValue);
  const current = installedRuntime;
  if (!current || current.lease.signal.aborted || !sameAccountLease(current.sourceLease, expectedLease)) return null;
  const assertCurrent = (): void => {
    if (installedRuntime !== current || current.lease.signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Account runtime is stale");
    }
  };
  return Object.freeze({ sourceLease: current.sourceLease, lease: current.lease, assertCurrent });
}

export function captureAccountStoreRuntime(expectedLeaseValue: unknown): CapturedAccountStoreRuntime | null {
  const expectedLease = validateAccountLease(expectedLeaseValue);
  const current = installedRuntime;
  if (!current) return null;
  if (current.lease.signal.aborted) {
    if (installedRuntime === current) installedRuntime = null;
    detachRuntime(current);
    return null;
  }
  if (!sameAccountLease(current.sourceLease, expectedLease)) return null;
  const barrier = current.barrier;
  const lease = current.lease;
  const sourceLease = current.sourceLease;
  return Object.freeze({
    lease,
    sourceLease,
    withShared<T>(callback: (operation: AccountContentOperation, capturedLease: AccountLease) => T | PromiseLike<T>) {
      if (typeof callback !== "function") {
        return Promise.reject(
          new SessionError(sessionErrorCodes.invalidState, "Account store operation requires a callback"),
        );
      }
      if (installedRuntime !== current || current.lease.signal.aborted) {
        return Promise.reject(new SessionError(sessionErrorCodes.staleOperation, "Account runtime is stale"));
      }
      return barrier.withAccountShared(lease, (operation) => {
        if (installedRuntime !== current || current.lease.signal.aborted) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Account runtime was replaced before admission");
        }
        return callback(operation, lease);
      });
    },
  });
}
