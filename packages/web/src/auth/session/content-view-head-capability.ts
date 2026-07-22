import { SessionError, sessionErrorCodes } from "./errors.js";
import { sameActivation, type ViewLease, validateViewLease } from "./types.js";

declare const contentViewHeadType: unique symbol;

export type ContentViewHead = Readonly<{ [contentViewHeadType]: never }>;

type ContentViewHeadState = Readonly<{
  lease: ViewLease;
  assertCurrent: () => Promise<void>;
}>;

const contentViewHeads = new WeakMap<ContentViewHead, ContentViewHeadState>();

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

/**
 * Internal bridge between the durable selected-organization writer and the
 * installed content runtime. The assertion stays in a WeakMap so neither the
 * durable store nor its account lease can be recovered through reflection.
 */
export function mintContentViewHead(leaseValue: unknown, assertCurrent: () => Promise<void>): ContentViewHead {
  const lease = validateViewLease(leaseValue);
  if (typeof assertCurrent !== "function") {
    throw new SessionError(sessionErrorCodes.invalidState, "Content view head requires an assertion");
  }
  const head = Object.freeze({}) as ContentViewHead;
  contentViewHeads.set(head, Object.freeze({ lease, assertCurrent }));
  return head;
}

export function readContentViewHead(value: unknown, leaseValue: unknown): () => Promise<void> {
  if (typeof value !== "object" || value === null) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Content view head is unavailable");
  }
  const state = contentViewHeads.get(value as ContentViewHead);
  const lease = validateViewLease(leaseValue);
  if (!state || !sameView(state.lease, lease) || lease.signal.aborted) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Content view head is unavailable");
  }
  return state.assertCurrent;
}
