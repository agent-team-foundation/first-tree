import {
  type AccountStateCompareExchangeResult,
  type AccountStateEntry,
  AccountStateStore,
} from "../api/account-state-store.js";
import { captureAccountStoreRuntime } from "./session/account-store-runtime.js";
import type { SessionLockManager } from "./session/content-barrier.js";
import { ContentScopeBarrier } from "./session/content-barrier.js";
import { installContentStoreRuntime, retireContentStoreRuntime } from "./session/content-store-runtime.js";
import { mintContentViewHead } from "./session/content-view-head-capability.js";
import { claimVerifiedActiveMeProof, type VerifiedActiveMeProof } from "./session/coordinator.js";
import { SessionError, sessionErrorCodes } from "./session/errors.js";
import type { AccountLease, JsonValue, ViewLease } from "./session/types.js";
import { createViewLease, validateAccountLease } from "./session/types.js";

export const ORGANIZATION_NAVIGATION_LOCK_PREFIX = "first-tree:org-navigation:";

const SELECTED_ORGANIZATION_KIND = "selected-organization";
const SELECTED_ORGANIZATION_KEY = "current";
const MAX_ORGANIZATION_ID_LENGTH = 512;
const MAX_REVISION_LENGTH = 512;

type PersistedSelectedOrganization = Readonly<{
  [key: string]: JsonValue;
  state: "selected";
  organizationId: string;
  orgRevision: string;
}>;

type PersistedNeedsSelection = Readonly<{
  [key: string]: JsonValue;
  state: "needs-selection";
  orgRevision: string;
}>;

type PersistedSelection = PersistedSelectedOrganization | PersistedNeedsSelection;

export type SelectedOrganizationState =
  | Readonly<{ kind: "selected"; organizationId: string; orgRevision: string }>
  | Readonly<{ kind: "needs-selection"; orgRevision: string }>;

export type SelectedOrganizationReason = "initialize" | "refresh" | "switch" | "restore";

export type SelectedOrganizationReconciliation =
  | Readonly<{ kind: "committed" | "unchanged" }>
  | Readonly<{
      kind: "superseded";
      /** Compare/exchange cursor only; it is never organization-view publication authority. */
      cursor: SelectedOrganizationState;
    }>;

export type SelectedOrganizationPublication = Readonly<{
  state: SelectedOrganizationState;
  viewLease: ViewLease | null;
}>;

export type ReconcileSelectedOrganizationInput = Readonly<{
  lease: AccountLease;
  identity: VerifiedActiveMeProof;
  requestedOrganizationId?: string | null;
  expectedState?: SelectedOrganizationState | null;
  reason: SelectedOrganizationReason;
}>;

export type RebindSuspendedOrganizationInput = Readonly<{
  lease: AccountLease;
  publication: SelectedOrganizationPublication;
}>;

export type SelectedOrganizationControllerOptions = Readonly<{
  store: AccountStateStore;
  barrier: ContentScopeBarrier;
  locks?: SessionLockManager;
  createRevision?: () => string;
  now?: () => number;
}>;

function invalidState(message: string): SessionError {
  return new SessionError(sessionErrorCodes.invalidState, message);
}

function requireBoundedId(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw invalidState(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function requireTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidState("Selected-organization timestamp must be a non-negative safe integer");
  }
  return value;
}

function defaultRevision(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new SessionError(
      sessionErrorCodes.platformUnavailable,
      "Cryptographic randomness is required for an organization view",
    );
  }
  return globalThis.crypto.randomUUID();
}

class BrowserNavigationLocks implements SessionLockManager {
  public request<T>(
    name: string,
    options: { mode: "shared" | "exclusive"; signal?: AbortSignal },
    callback: () => T | PromiseLike<T>,
  ): Promise<T> {
    if (typeof navigator === "undefined" || !navigator.locks) {
      return Promise.reject(
        new SessionError(sessionErrorCodes.platformUnavailable, "Web Locks are required for organization navigation"),
      );
    }
    const lockOptions: LockOptions = { mode: options.mode };
    if (options.signal) lockOptions.signal = options.signal;
    return navigator.locks.request(name, lockOptions, () => callback()) as Promise<T>;
  }
}

function normalizeMembershipIds(values: readonly string[]): ReadonlySet<string> {
  const output = new Set<string>();
  const length = values.length;
  if (!Number.isSafeInteger(length) || length > 100_000) {
    throw invalidState("Selected-organization membership set is unbounded");
  }
  for (let index = 0; index < length; index += 1) {
    if (Reflect.getOwnPropertyDescriptor(values, String(index)) === undefined) {
      throw invalidState("Selected-organization membership set cannot be sparse");
    }
    output.add(requireBoundedId(values[index], "Organization id", MAX_ORGANIZATION_ID_LENGTH));
  }
  return output;
}

function normalizeOptionalOrganizationId(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : requireBoundedId(value, label, MAX_ORGANIZATION_ID_LENGTH);
}

function normalizeState(
  value: SelectedOrganizationState | null | undefined,
): SelectedOrganizationState | null | undefined {
  if (value === null || value === undefined) return value;
  const kind = value.kind;
  const orgRevision = requireBoundedId(value.orgRevision, "Organization revision", MAX_REVISION_LENGTH);
  if (kind === "needs-selection") return Object.freeze({ kind, orgRevision });
  if (kind === "selected") {
    const organizationId = requireBoundedId(value.organizationId, "Organization id", MAX_ORGANIZATION_ID_LENGTH);
    return Object.freeze({ kind, organizationId, orgRevision });
  }
  throw invalidState("Selected-organization state is malformed");
}

function statesEqual(left: SelectedOrganizationState | null, right: SelectedOrganizationState | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    left.orgRevision === right.orgRevision &&
    (left.kind === "needs-selection" || (right.kind === "selected" && left.organizationId === right.organizationId))
  );
}

function parseEntry(entry: AccountStateEntry<PersistedSelection> | null): SelectedOrganizationState | null {
  if (entry === null) return null;
  const value = entry.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionError(sessionErrorCodes.recoveryRequired, "Selected-organization state is malformed");
  }
  const state = value.state;
  const orgRevision = value.orgRevision;
  try {
    if (state === "needs-selection") {
      return Object.freeze({
        kind: "needs-selection",
        orgRevision: requireBoundedId(orgRevision, "Organization revision", MAX_REVISION_LENGTH),
      });
    }
    if (state === "selected") {
      return Object.freeze({
        kind: "selected",
        organizationId: requireBoundedId(value.organizationId, "Organization id", MAX_ORGANIZATION_ID_LENGTH),
        orgRevision: requireBoundedId(orgRevision, "Organization revision", MAX_REVISION_LENGTH),
      });
    }
  } catch (error) {
    throw new SessionError(sessionErrorCodes.recoveryRequired, "Selected-organization state is malformed", error);
  }
  throw new SessionError(sessionErrorCodes.recoveryRequired, "Selected-organization state is malformed");
}

function persistedValue(state: SelectedOrganizationState): PersistedSelection {
  return state.kind === "selected"
    ? Object.freeze({ state: "selected", organizationId: state.organizationId, orgRevision: state.orgRevision })
    : Object.freeze({ state: "needs-selection", orgRevision: state.orgRevision });
}

function entryFor(
  lease: AccountLease,
  state: SelectedOrganizationState,
  updatedAt: number,
): AccountStateEntry<PersistedSelection> {
  return Object.freeze({
    kind: SELECTED_ORGANIZATION_KIND,
    key: SELECTED_ORGANIZATION_KEY,
    tabId: lease.ownerTabId,
    value: persistedValue(state),
    updatedAt,
  });
}

function rotateStateRevision(
  state: SelectedOrganizationState,
  createRevision: () => string,
): SelectedOrganizationState {
  const orgRevision = requireBoundedId(createRevision(), "Organization revision", MAX_REVISION_LENGTH);
  if (orgRevision === state.orgRevision) {
    throw new SessionError(sessionErrorCodes.platformUnavailable, "Organization revision did not advance");
  }
  return state.kind === "selected"
    ? Object.freeze({ kind: "selected", organizationId: state.organizationId, orgRevision })
    : Object.freeze({ kind: "needs-selection", orgRevision });
}

function chooseState(
  reason: SelectedOrganizationReason,
  current: SelectedOrganizationState | null,
  memberships: ReadonlySet<string>,
  defaultOrganizationId: string | null,
  requestedOrganizationId: string | null,
  createRevision: () => string,
): SelectedOrganizationState {
  if (reason === "switch" || reason === "restore") {
    if (!requestedOrganizationId || !memberships.has(requestedOrganizationId)) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Requested organization is not a current membership");
    }
    return Object.freeze({
      kind: "selected",
      organizationId: requestedOrganizationId,
      orgRevision: requireBoundedId(createRevision(), "Organization revision", MAX_REVISION_LENGTH),
    });
  }

  if (reason === "initialize" && current?.kind === "selected") {
    if (!memberships.has(current.organizationId)) {
      return Object.freeze({
        kind: "needs-selection",
        orgRevision: requireBoundedId(createRevision(), "Organization revision", MAX_REVISION_LENGTH),
      });
    }
    return Object.freeze({
      kind: "selected",
      organizationId: current.organizationId,
      orgRevision: requireBoundedId(createRevision(), "Organization revision", MAX_REVISION_LENGTH),
    });
  }
  if (reason === "initialize" && current?.kind === "needs-selection") {
    return Object.freeze({
      kind: "needs-selection",
      orgRevision: requireBoundedId(createRevision(), "Organization revision", MAX_REVISION_LENGTH),
    });
  }
  if (current?.kind === "selected" && memberships.has(current.organizationId)) return current;
  if (current?.kind === "needs-selection") return current;
  if (current?.kind === "selected") {
    return Object.freeze({
      kind: "needs-selection",
      orgRevision: requireBoundedId(createRevision(), "Organization revision", MAX_REVISION_LENGTH),
    });
  }

  if (reason === "initialize" && defaultOrganizationId && memberships.has(defaultOrganizationId)) {
    return Object.freeze({
      kind: "selected",
      organizationId: defaultOrganizationId,
      orgRevision: requireBoundedId(createRevision(), "Organization revision", MAX_REVISION_LENGTH),
    });
  }
  return Object.freeze({
    kind: "needs-selection",
    orgRevision: requireBoundedId(createRevision(), "Organization revision", MAX_REVISION_LENGTH),
  });
}

/**
 * The only account-level selected-organization writer. It serializes one
 * owner tab, persists before publication, and never infers a first membership.
 */
export class SelectedOrganizationController {
  readonly #store: AccountStateStore;
  readonly #barrier: ContentScopeBarrier;
  readonly #locks: SessionLockManager;
  readonly #createRevision: () => string;
  readonly #now: () => number;
  #publication: SelectedOrganizationPublication | null = null;

  public constructor(options: SelectedOrganizationControllerOptions) {
    const store = options.store;
    const barrier = options.barrier;
    if (!(store instanceof AccountStateStore)) throw invalidState("Selected-organization controller requires a store");
    if (!(barrier instanceof ContentScopeBarrier)) {
      throw invalidState("Selected-organization controller requires a content scope barrier");
    }
    this.#store = store;
    this.#barrier = barrier;
    this.#locks = options.locks ?? new BrowserNavigationLocks();
    this.#createRevision = options.createRevision ?? defaultRevision;
    this.#now = options.now ?? Date.now;
  }

  public readCurrentPublication(): SelectedOrganizationPublication | null {
    return this.#publication;
  }

  public async reconcile(input: ReconcileSelectedOrganizationInput): Promise<SelectedOrganizationReconciliation> {
    const lease = validateAccountLease(input.lease);
    const identityProof = input.identity;
    const identity = claimVerifiedActiveMeProof(identityProof, lease);
    try {
      const membershipValues = identity.membershipIds;
      const defaultOrganizationId = identity.defaultOrganizationId;
      const requestedOrganizationId = normalizeOptionalOrganizationId(
        input.requestedOrganizationId,
        "Requested organization id",
      );
      const expectedStateValue = normalizeState(input.expectedState);
      const reason = input.reason;
      if (reason !== "initialize" && reason !== "refresh" && reason !== "switch" && reason !== "restore") {
        throw invalidState("Selected-organization reconciliation reason is malformed");
      }
      if (reason !== "initialize" && expectedStateValue === undefined) {
        throw invalidState("Selected-organization reconciliation requires its captured source state");
      }
      const memberships = normalizeMembershipIds(membershipValues);
      if (lease.signal.aborted) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Organization navigation was cancelled");
      }

      const lockName = `${ORGANIZATION_NAVIGATION_LOCK_PREFIX}${lease.ownerTabId}`;
      try {
        const result = await this.#locks.request(lockName, { mode: "exclusive", signal: lease.signal }, async () => {
          if (lease.signal.aborted) {
            throw new SessionError(sessionErrorCodes.staleOperation, "Organization navigation was cancelled");
          }
          identity.assertCurrent();
          const locator = Object.freeze({
            kind: SELECTED_ORGANIZATION_KIND,
            key: SELECTED_ORGANIZATION_KEY,
            tabId: lease.ownerTabId,
          });
          const currentEntry = await this.#store.getAccountEntry<PersistedSelection>(lease, locator);
          const current = parseEntry(currentEntry);
          if (expectedStateValue !== undefined && !statesEqual(current, expectedStateValue)) {
            if (!current) {
              throw new SessionError(sessionErrorCodes.recoveryRequired, "Selected-organization state disappeared");
            }
            return Object.freeze({ kind: "superseded" as const, cursor: current });
          }
          if (reason === "initialize" && expectedStateValue === undefined && current !== null) {
            // Cursor-free boot never rebases an existing durable head. Observe
            // this exact cursor, fetch a fresh `/me`, then reconcile explicitly.
            return Object.freeze({ kind: "superseded" as const, cursor: current });
          }

          const desired = chooseState(
            reason,
            current,
            memberships,
            defaultOrganizationId,
            requestedOrganizationId,
            this.#createRevision,
          );
          if (statesEqual(current, desired)) {
            await this.#store.assertAccountLeaseCurrent(lease);
            identity.assertCurrent();
            if (lease.signal.aborted) {
              throw new SessionError(
                sessionErrorCodes.staleOperation,
                "Organization navigation crossed a lifecycle fence",
              );
            }
            this.publishView(lease, desired);
            return Object.freeze({ kind: "unchanged" as const });
          }

          const updatedAt = requireTimestamp(this.#now());
          const replacement = entryFor(lease, desired, updatedAt);
          const exchange: AccountStateCompareExchangeResult<PersistedSelection> =
            await this.#store.compareExchangeAccountEntry(lease, locator, currentEntry, replacement);
          if (!exchange.committed) {
            const winner = parseEntry(exchange.previous);
            if (!winner) {
              throw new SessionError(
                sessionErrorCodes.recoveryRequired,
                "Selected-organization write lost its authority",
              );
            }
            return Object.freeze({ kind: "superseded" as const, cursor: winner });
          }
          await this.#store.assertAccountLeaseCurrent(lease);
          identity.assertCurrent();
          if (lease.signal.aborted) {
            throw new SessionError(
              sessionErrorCodes.staleOperation,
              "Organization navigation crossed a lifecycle fence",
            );
          }
          this.publishView(lease, desired);
          return Object.freeze({ kind: "committed" as const });
        });
        await this.#store.assertAccountLeaseCurrent(lease);
        if (lease.signal.aborted) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Organization navigation crossed a delivery fence");
        }
        return result;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new SessionError(sessionErrorCodes.staleOperation, "Organization navigation lock was cancelled");
        }
        throw error;
      }
    } finally {
      identity.settle();
    }
  }

  /**
   * Rebind a hard-suspended, already verified projection without consulting
   * the network. This is deliberately narrower than reconciliation: it may
   * rotate only the exact durable head this controller previously published.
   */
  public async rebindSuspendedPublication(
    input: RebindSuspendedOrganizationInput,
  ): Promise<SelectedOrganizationPublication> {
    const lease = validateAccountLease(input.lease);
    const publication = input.publication;
    if (publication !== this.#publication) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Suspended organization publication is stale");
    }
    const expected = normalizeState(publication.state);
    if (!expected || lease.signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Suspended organization view was cancelled");
    }
    const lockName = `${ORGANIZATION_NAVIGATION_LOCK_PREFIX}${lease.ownerTabId}`;
    try {
      const rebound = await this.#locks.request(lockName, { mode: "exclusive", signal: lease.signal }, async () => {
        if (lease.signal.aborted || publication !== this.#publication) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Suspended organization publication was replaced");
        }
        const locator = Object.freeze({
          kind: SELECTED_ORGANIZATION_KIND,
          key: SELECTED_ORGANIZATION_KEY,
          tabId: lease.ownerTabId,
        });
        const currentEntry = await this.#store.getAccountEntry<PersistedSelection>(lease, locator);
        if (lease.signal.aborted || publication !== this.#publication) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Suspended organization head read became stale");
        }
        const current = parseEntry(currentEntry);
        if (!statesEqual(current, expected) || currentEntry === null) {
          throw new SessionError(
            sessionErrorCodes.recoveryRequired,
            "Suspended organization head changed while the document was hidden",
          );
        }
        const replacementState = rotateStateRevision(expected, this.#createRevision);
        const replacement = entryFor(lease, replacementState, requireTimestamp(this.#now()));
        const exchange = await this.#store.compareExchangeAccountEntry(lease, locator, currentEntry, replacement);
        if (lease.signal.aborted || publication !== this.#publication) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Suspended organization rebind became stale");
        }
        if (!exchange.committed) {
          throw new SessionError(
            sessionErrorCodes.recoveryRequired,
            "Suspended organization head lost its exact compare/exchange",
          );
        }
        this.publishView(lease, replacementState);
        const currentPublication = this.#publication;
        if (!currentPublication || currentPublication.state !== replacementState) {
          throw new SessionError(sessionErrorCodes.recoveryRequired, "Suspended organization view was not published");
        }
        return currentPublication;
      });
      if (lease.signal.aborted || this.#publication !== rebound) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Suspended organization delivery became stale");
      }
      return rebound;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new SessionError(sessionErrorCodes.staleOperation, "Suspended organization lock was cancelled");
      }
      throw error;
    }
  }

  /**
   * Final delivery fence for a projection that crossed a network or other
   * external await after it was rebound. The publication object identity
   * proves that no same-document navigation replaced it, while the account
   * store read proves that another document did not move the durable head.
   */
  public async assertPublicationCurrent(leaseValue: unknown, publicationValue: unknown): Promise<void> {
    const lease = validateAccountLease(leaseValue);
    const publication = publicationValue;
    if (publication !== this.#publication || lease.signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Selected organization publication is stale");
    }
    const expected = normalizeState((publication as SelectedOrganizationPublication).state);
    if (!expected) {
      throw new SessionError(sessionErrorCodes.invalidState, "Selected organization publication is malformed");
    }
    const current = parseEntry(
      await this.#store.getAccountEntry<PersistedSelection>(lease, {
        kind: SELECTED_ORGANIZATION_KIND,
        key: SELECTED_ORGANIZATION_KEY,
        tabId: lease.ownerTabId,
      }),
    );
    if (lease.signal.aborted || publication !== this.#publication || !statesEqual(current, expected)) {
      throw new SessionError(
        sessionErrorCodes.staleOperation,
        "Selected organization changed before projection delivery",
      );
    }
  }

  private publishView(lease: AccountLease, state: SelectedOrganizationState): void {
    if (state.kind === "needs-selection") {
      retireContentStoreRuntime();
      this.#publication = Object.freeze({ state, viewLease: null });
      return;
    }
    const accountRuntime = captureAccountStoreRuntime(lease);
    if (!accountRuntime) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Account runtime became stale before view publication");
    }
    const viewLease = createViewLease({
      activation: accountRuntime.lease.activation,
      organizationId: state.organizationId,
      orgRevision: state.orgRevision,
      ownerTabId: accountRuntime.lease.ownerTabId,
      documentId: accountRuntime.lease.documentId,
      signal: accountRuntime.lease.signal,
    });
    const head = mintContentViewHead(viewLease, async () => {
      const current = parseEntry(
        await this.#store.getAccountEntry<PersistedSelection>(lease, {
          kind: SELECTED_ORGANIZATION_KIND,
          key: SELECTED_ORGANIZATION_KEY,
          tabId: lease.ownerTabId,
        }),
      );
      if (!statesEqual(current, state)) {
        throw new SessionError(
          sessionErrorCodes.staleOperation,
          "Content view no longer owns the selected organization",
        );
      }
    });
    installContentStoreRuntime({ barrier: this.#barrier, lease: viewLease, head });
    this.#publication = Object.freeze({ state, viewLease });
  }
}
