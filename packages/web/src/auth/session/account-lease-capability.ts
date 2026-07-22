import { SessionError, sessionErrorCodes } from "./errors.js";
import { type AccountLease, createAccountLease, validateAccountLease } from "./types.js";

type BoundAccountLeaseState = {
  source: AccountLease;
  owner: object;
  active: boolean;
};

const boundAccountLeases = new WeakMap<AccountLease, BoundAccountLeaseState>();

/** Internal bridge between the account runtime and the content barrier. */
export function mintBoundAccountLease(sourceValue: unknown, signal: AbortSignal, owner: object): AccountLease {
  const source = validateAccountLease(sourceValue);
  if (signal.aborted) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Cannot bind an invalidated account lifecycle");
  }
  const lease = createAccountLease({
    activation: source.activation,
    accountRevision: source.accountRevision,
    ownerTabId: source.ownerTabId,
    documentId: source.documentId,
    signal,
  });
  boundAccountLeases.set(lease, { source, owner, active: true });
  return lease;
}

export function readBoundAccountLease(
  value: unknown,
  owner: object,
): Readonly<{
  lease: AccountLease;
  source: AccountLease;
}> {
  if (typeof value !== "object" || value === null) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Account runtime capability is unavailable");
  }
  const lease = value as AccountLease;
  const state = boundAccountLeases.get(lease);
  if (!state || !state.active || state.owner !== owner || lease.signal.aborted) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Account runtime capability is unavailable");
  }
  return Object.freeze({ lease, source: state.source });
}

export function revokeBoundAccountLease(value: AccountLease): void {
  const state = boundAccountLeases.get(value);
  if (state) state.active = false;
}
