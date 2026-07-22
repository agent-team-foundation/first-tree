import { SessionError, sessionErrorCodes } from "./errors.js";
import { createAccountScopeKey, parseAccountScopeKey } from "./scope.js";

export const AUTHORITY_SCHEMA_VERSION = 6 as const;

const MAX_OPAQUE_ID_LENGTH = 512;
const MAX_TOKEN_LENGTH = 64 * 1024;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>;

export type ActivationCertificate = Readonly<{
  v: 1;
  sessionEpoch: string;
  authGeneration: string;
  transitionPermitId: string;
  serverAuthority: string;
  accountId: string;
  scopeKey: string;
}>;

export type ActivationCertificateInput = Omit<ActivationCertificate, "v">;

/**
 * Account-level browser state is admitted without inventing an organization.
 * The owner/document fields fence tab-owned preferences while the exact signal
 * ties every admission to the lifecycle that captured the lease.
 */
export type AccountLease = Readonly<{
  activation: ActivationCertificate;
  accountRevision: string;
  ownerTabId: string;
  documentId: string;
  signal: AbortSignal;
}>;

export type AccountLeaseInput = Omit<AccountLease, "activation"> & Readonly<{ activation: unknown }>;

export type ViewLease = Readonly<{
  activation: ActivationCertificate;
  organizationId: string;
  orgRevision: string;
  ownerTabId: string;
  documentId: string;
  signal: AbortSignal;
}>;

export type ViewLeaseInput = Omit<ViewLease, "activation"> & Readonly<{ activation: unknown }>;

export type CredentialRecord = Readonly<{
  v: 1;
  sessionEpoch: string;
  activation: ActivationCertificate;
  credentialRevision: number;
  credentialFingerprint: string;
  accessToken: string;
  refreshToken: string;
}>;

export type CredentialRecordInput = Readonly<{
  activation: unknown;
  credentialRevision: number;
  credentialFingerprint: string;
  accessToken: string;
  refreshToken: string;
}>;

type SessionAttemptBase = Readonly<{
  v: 1;
  attemptId: string;
  serverAuthority: string;
  baselineGeneration: string;
  sourceEpoch: string | null;
  expiresAt: number;
  payload: Readonly<{ [key: string]: JsonValue }>;
}>;

export type AcquisitionSessionAttempt = SessionAttemptBase & Readonly<{ kind: "acquisition" }>;

export type ManagementFlowKind = "identity-link" | "identity-unlink" | "github-install-return";

export type ManagementSessionAttempt = SessionAttemptBase &
  Readonly<{
    kind: "management";
    flowKind: ManagementFlowKind;
  }>;

export type SessionAttempt = AcquisitionSessionAttempt | ManagementSessionAttempt;

export type AcquisitionSessionAttemptInput = Omit<AcquisitionSessionAttempt, "v">;
export type ManagementSessionAttemptInput = Omit<ManagementSessionAttempt, "v">;
export type SessionAttemptInput = AcquisitionSessionAttemptInput | ManagementSessionAttemptInput;

export type AcquisitionTransitionPermit = Readonly<{
  v: 1;
  kind: "acquisition_transition";
  permitId: string;
  attemptId: string;
  target: ActivationCertificate;
  targetCredentialFingerprint: string;
  expiresAt: number;
}>;

export type AcquisitionTransitionPermitInput = Omit<AcquisitionTransitionPermit, "v" | "target"> &
  Readonly<{ target: unknown }>;

/**
 * Settings/provider management uses a separate capability domain. It can
 * never be supplied to the session-activation transition APIs.
 */
export type ManagementDeliveryPermit = Readonly<{
  v: 1;
  kind: "management_delivery";
  permitId: string;
  attemptId: string;
  serverAuthority: string;
  sourceEpoch: string;
  accountId: string;
  organizationId: string;
  ownerTabId: string;
  expiresAt: number;
}>;

export type ManagementDeliveryPermitInput = Omit<ManagementDeliveryPermit, "v">;

export type CredentialCursor = Readonly<{
  sessionEpoch: string;
  credentialRevision: number;
  credentialFingerprint: string;
}>;

export type AuthorityPhase = "revoked" | "purging" | "source_purged";
export type RetirementCause = "logout" | "owned_401" | "server_mismatch" | "transition_cancelled";

export type AnonymousAuthority = Readonly<{
  v: 6;
  mode: "none";
  generation: string;
  revision: number;
}>;

export type ActiveAuthority = Readonly<{
  v: 6;
  mode: "active";
  generation: string;
  revision: number;
  session: ActivationCertificate;
}>;

export type TransitionAuthority = Readonly<{
  v: 6;
  mode: "transition";
  generation: string;
  revision: number;
  permit: AcquisitionTransitionPermit;
  source: ActivationCertificate | null;
  phase: AuthorityPhase;
  cleanupReceipt?: string;
}>;

export type RetiringAuthority = Readonly<{
  v: 6;
  mode: "retiring";
  generation: string;
  revision: number;
  source: ActivationCertificate;
  cause: RetirementCause;
  phase: AuthorityPhase;
  cleanupReceipt?: string;
}>;

export type AuthAuthority = AnonymousAuthority | ActiveAuthority | TransitionAuthority | RetiringAuthority;

export type CoordinatorSnapshot = Readonly<{
  authority: AuthAuthority;
  credentials: readonly CredentialRecord[];
  attempts: readonly SessionAttempt[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireOpaqueId(value: unknown, label: string, maxLength = MAX_OPAQUE_ID_LENGTH): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new SessionError(sessionErrorCodes.invalidState, `${label} must be a non-empty bounded string`);
  }
  return value;
}

function requireRevision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SessionError(sessionErrorCodes.invalidState, `${label} must be a non-negative integer`);
  }
  return value;
}

function requireExpiry(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SessionError(sessionErrorCodes.invalidState, "Attempt expiry must be a non-negative integer");
  }
  return value;
}

function requireToken(value: unknown, label: string): string {
  return requireOpaqueId(value, label, MAX_TOKEN_LENGTH);
}

function validateJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 20) {
    throw new SessionError(sessionErrorCodes.invalidState, "Attempt payload exceeds the nesting limit");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => validateJsonValue(item, depth + 1)));
  if (!isRecord(value)) {
    throw new SessionError(sessionErrorCodes.invalidState, "Attempt payload must contain only JSON values");
  }

  return validateJsonObject(value, depth);
}

function validateJsonObject(value: Record<string, unknown>, depth = 0): Readonly<{ [key: string]: JsonValue }> {
  const output: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    requireOpaqueId(key, "Attempt payload key", 256);
    output[key] = validateJsonValue(item, depth + 1);
  }
  return Object.freeze(output);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (!isRecord(value)) return false;
  return (
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

export function createActivationCertificate(input: ActivationCertificateInput): ActivationCertificate {
  const providedAuthority = requireOpaqueId(input.serverAuthority, "Server authority", 2048);
  const accountId = requireOpaqueId(input.accountId, "Account id");
  const scopeKey = requireOpaqueId(input.scopeKey, "Account scope key", 4096);
  const serverAuthority = parseAccountScopeKey(createAccountScopeKey(providedAuthority, accountId)).serverAuthority;
  if (providedAuthority !== serverAuthority || createAccountScopeKey(serverAuthority, accountId) !== scopeKey) {
    throw new SessionError(
      sessionErrorCodes.invalidState,
      "Activation account scope does not match its authority/account",
    );
  }

  return Object.freeze({
    v: 1,
    sessionEpoch: requireOpaqueId(input.sessionEpoch, "Session epoch"),
    authGeneration: requireOpaqueId(input.authGeneration, "Auth generation"),
    transitionPermitId: requireOpaqueId(input.transitionPermitId, "Transition permit id"),
    serverAuthority,
    accountId,
    scopeKey,
  });
}

export function validateActivationCertificate(value: unknown): ActivationCertificate {
  if (!isRecord(value) || value.v !== 1) {
    throw new SessionError(sessionErrorCodes.invalidState, "Activation certificate is malformed");
  }
  return createActivationCertificate({
    sessionEpoch: requireOpaqueId(value.sessionEpoch, "Session epoch"),
    authGeneration: requireOpaqueId(value.authGeneration, "Auth generation"),
    transitionPermitId: requireOpaqueId(value.transitionPermitId, "Transition permit id"),
    serverAuthority: requireOpaqueId(value.serverAuthority, "Server authority", 2048),
    accountId: requireOpaqueId(value.accountId, "Account id"),
    scopeKey: requireOpaqueId(value.scopeKey, "Account scope key", 4096),
  });
}

export function createViewLease(input: ViewLeaseInput): ViewLease {
  if (!isAbortSignal(input.signal)) {
    throw new SessionError(sessionErrorCodes.invalidState, "View lease requires an AbortSignal");
  }
  return Object.freeze({
    activation: validateActivationCertificate(input.activation),
    organizationId: requireOpaqueId(input.organizationId, "Organization id"),
    orgRevision: requireOpaqueId(input.orgRevision, "Organization revision"),
    ownerTabId: requireOpaqueId(input.ownerTabId, "Owner tab id"),
    documentId: requireOpaqueId(input.documentId, "Document id"),
    signal: input.signal,
  });
}

export function createAccountLease(input: AccountLeaseInput): AccountLease {
  // Read every caller-controlled property exactly once. `Readonly` is only a
  // compile-time promise; a runtime object may still contain mutable getters.
  const activation = input.activation;
  const accountRevision = input.accountRevision;
  const ownerTabId = input.ownerTabId;
  const documentId = input.documentId;
  const signal = input.signal;
  if (!isAbortSignal(signal)) {
    throw new SessionError(sessionErrorCodes.invalidState, "Account lease requires an AbortSignal");
  }
  return Object.freeze({
    activation: validateActivationCertificate(activation),
    accountRevision: requireOpaqueId(accountRevision, "Account revision"),
    ownerTabId: requireOpaqueId(ownerTabId, "Owner tab id"),
    documentId: requireOpaqueId(documentId, "Document id"),
    signal,
  });
}

export function validateAccountLease(value: unknown): AccountLease {
  if (!isRecord(value)) throw new SessionError(sessionErrorCodes.invalidState, "Account lease is malformed");
  // Snapshot the untrusted record before validation so a getter cannot swap
  // the signal or activation between the coordinator's authority fences.
  const activation = value.activation;
  const accountRevision = value.accountRevision;
  const ownerTabId = value.ownerTabId;
  const documentId = value.documentId;
  const signal = value.signal;
  if (!isAbortSignal(signal)) {
    throw new SessionError(sessionErrorCodes.invalidState, "Account lease requires an AbortSignal");
  }
  return createAccountLease({
    activation,
    accountRevision: requireOpaqueId(accountRevision, "Account revision"),
    ownerTabId: requireOpaqueId(ownerTabId, "Owner tab id"),
    documentId: requireOpaqueId(documentId, "Document id"),
    signal,
  });
}

export function sameAccountLease(left: AccountLease, right: AccountLease): boolean {
  return (
    sameActivation(left.activation, right.activation) &&
    left.accountRevision === right.accountRevision &&
    left.ownerTabId === right.ownerTabId &&
    left.documentId === right.documentId &&
    left.signal === right.signal
  );
}

export function validateViewLease(value: unknown): ViewLease {
  if (!isRecord(value)) throw new SessionError(sessionErrorCodes.invalidState, "View lease is malformed");
  const activation = value.activation;
  const organizationId = value.organizationId;
  const orgRevision = value.orgRevision;
  const ownerTabId = value.ownerTabId;
  const documentId = value.documentId;
  const signal = value.signal;
  if (!isAbortSignal(signal)) {
    throw new SessionError(sessionErrorCodes.invalidState, "View lease requires an AbortSignal");
  }
  return createViewLease({
    activation,
    organizationId: requireOpaqueId(organizationId, "Organization id"),
    orgRevision: requireOpaqueId(orgRevision, "Organization revision"),
    ownerTabId: requireOpaqueId(ownerTabId, "Owner tab id"),
    documentId: requireOpaqueId(documentId, "Document id"),
    signal,
  });
}

export function createCredentialRecord(input: CredentialRecordInput): CredentialRecord {
  const activation = validateActivationCertificate(input.activation);
  return Object.freeze({
    v: 1,
    sessionEpoch: activation.sessionEpoch,
    activation,
    credentialRevision: requireRevision(input.credentialRevision, "Credential revision"),
    credentialFingerprint: requireOpaqueId(input.credentialFingerprint, "Credential fingerprint", 1024),
    accessToken: requireToken(input.accessToken, "Access token"),
    refreshToken: requireToken(input.refreshToken, "Refresh token"),
  });
}

export function validateCredentialRecord(value: unknown): CredentialRecord {
  if (!isRecord(value) || value.v !== 1) {
    throw new SessionError(sessionErrorCodes.invalidState, "Credential record is malformed");
  }
  const record = createCredentialRecord({
    activation: value.activation,
    credentialRevision: requireRevision(value.credentialRevision, "Credential revision"),
    credentialFingerprint: requireOpaqueId(value.credentialFingerprint, "Credential fingerprint", 1024),
    accessToken: requireToken(value.accessToken, "Access token"),
    refreshToken: requireToken(value.refreshToken, "Refresh token"),
  });
  if (value.sessionEpoch !== record.sessionEpoch) {
    throw new SessionError(sessionErrorCodes.invalidState, "Credential epoch does not match its activation");
  }
  return record;
}

export function createSessionAttempt(input: SessionAttemptInput): SessionAttempt {
  const payload = validateJsonObject(input.payload);
  const base = {
    v: 1,
    attemptId: requireOpaqueId(input.attemptId, "Attempt id"),
    serverAuthority: requireOpaqueId(input.serverAuthority, "Server authority", 2048),
    baselineGeneration: requireOpaqueId(input.baselineGeneration, "Attempt baseline generation"),
    sourceEpoch: input.sourceEpoch === null ? null : requireOpaqueId(input.sourceEpoch, "Attempt source epoch"),
    expiresAt: requireExpiry(input.expiresAt),
    payload,
  } as const;
  if (input.kind === "acquisition") return Object.freeze({ ...base, kind: "acquisition" });
  if (input.kind === "management") {
    return Object.freeze({ ...base, kind: "management", flowKind: validateManagementFlowKind(input.flowKind) });
  }
  throw new SessionError(sessionErrorCodes.invalidState, "Attempt kind is unsupported");
}

export function validateSessionAttempt(value: unknown): SessionAttempt {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.payload)) {
    throw new SessionError(sessionErrorCodes.invalidState, "Session attempt is malformed");
  }
  const payload = validateJsonObject(value.payload);
  const base = {
    attemptId: requireOpaqueId(value.attemptId, "Attempt id"),
    serverAuthority: requireOpaqueId(value.serverAuthority, "Server authority", 2048),
    baselineGeneration: requireOpaqueId(value.baselineGeneration, "Attempt baseline generation"),
    sourceEpoch: value.sourceEpoch === null ? null : requireOpaqueId(value.sourceEpoch, "Attempt source epoch"),
    expiresAt: requireExpiry(value.expiresAt),
    payload,
  } as const;
  if (value.kind === "acquisition") return createSessionAttempt({ ...base, kind: "acquisition" });
  if (value.kind === "management") {
    return createSessionAttempt({ ...base, kind: "management", flowKind: validateManagementFlowKind(value.flowKind) });
  }
  throw new SessionError(sessionErrorCodes.invalidState, "Attempt kind is unsupported");
}

function validateManagementFlowKind(value: unknown): ManagementFlowKind {
  if (value === "identity-link" || value === "identity-unlink" || value === "github-install-return") return value;
  throw new SessionError(sessionErrorCodes.invalidState, "Management flow kind is unsupported");
}

function createAcquisitionTransitionPermit(input: AcquisitionTransitionPermitInput): AcquisitionTransitionPermit {
  if (input.kind !== "acquisition_transition") {
    throw new SessionError(sessionErrorCodes.invalidState, "Acquisition transition permit has another domain");
  }
  return Object.freeze({
    v: 1,
    kind: "acquisition_transition",
    permitId: requireOpaqueId(input.permitId, "Transition permit id"),
    attemptId: requireOpaqueId(input.attemptId, "Transition attempt id"),
    target: validateActivationCertificate(input.target),
    targetCredentialFingerprint: requireOpaqueId(
      input.targetCredentialFingerprint,
      "Target credential fingerprint",
      1024,
    ),
    expiresAt: requireExpiry(input.expiresAt),
  });
}

export function validateAcquisitionTransitionPermit(value: unknown): AcquisitionTransitionPermit {
  if (!isRecord(value) || value.v !== 1 || value.kind !== "acquisition_transition") {
    throw new SessionError(sessionErrorCodes.invalidState, "Acquisition transition permit is malformed");
  }
  return createAcquisitionTransitionPermit({
    kind: "acquisition_transition",
    permitId: requireOpaqueId(value.permitId, "Transition permit id"),
    attemptId: requireOpaqueId(value.attemptId, "Transition attempt id"),
    target: value.target,
    targetCredentialFingerprint: requireOpaqueId(
      value.targetCredentialFingerprint,
      "Target credential fingerprint",
      1024,
    ),
    expiresAt: requireExpiry(value.expiresAt),
  });
}

export function createManagementDeliveryPermit(input: ManagementDeliveryPermitInput): ManagementDeliveryPermit {
  if (input.kind !== "management_delivery") {
    throw new SessionError(sessionErrorCodes.invalidState, "Management delivery permit has another domain");
  }
  return Object.freeze({
    v: 1,
    kind: "management_delivery",
    permitId: requireOpaqueId(input.permitId, "Management permit id"),
    attemptId: requireOpaqueId(input.attemptId, "Management attempt id"),
    serverAuthority: requireOpaqueId(input.serverAuthority, "Server authority", 2048),
    sourceEpoch: requireOpaqueId(input.sourceEpoch, "Management source epoch"),
    accountId: requireOpaqueId(input.accountId, "Management account id"),
    organizationId: requireOpaqueId(input.organizationId, "Management organization id"),
    ownerTabId: requireOpaqueId(input.ownerTabId, "Management owner tab id"),
    expiresAt: requireExpiry(input.expiresAt),
  });
}

export function validateManagementDeliveryPermit(value: unknown): ManagementDeliveryPermit {
  if (!isRecord(value) || value.v !== 1 || value.kind !== "management_delivery") {
    throw new SessionError(sessionErrorCodes.invalidState, "Management delivery permit is malformed");
  }
  return createManagementDeliveryPermit({
    kind: "management_delivery",
    permitId: requireOpaqueId(value.permitId, "Management permit id"),
    attemptId: requireOpaqueId(value.attemptId, "Management attempt id"),
    serverAuthority: requireOpaqueId(value.serverAuthority, "Server authority", 2048),
    sourceEpoch: requireOpaqueId(value.sourceEpoch, "Management source epoch"),
    accountId: requireOpaqueId(value.accountId, "Management account id"),
    organizationId: requireOpaqueId(value.organizationId, "Management organization id"),
    ownerTabId: requireOpaqueId(value.ownerTabId, "Management owner tab id"),
    expiresAt: requireExpiry(value.expiresAt),
  });
}

function validatePhase(value: unknown): AuthorityPhase {
  if (value === "revoked" || value === "purging" || value === "source_purged") return value;
  throw new SessionError(sessionErrorCodes.invalidState, "Authority cleanup phase is malformed");
}

function validateRetirementCause(value: unknown): RetirementCause {
  if (value === "logout" || value === "owned_401" || value === "server_mismatch" || value === "transition_cancelled") {
    return value;
  }
  throw new SessionError(sessionErrorCodes.invalidState, "Retirement cause is malformed");
}

export function validateAuthAuthority(value: unknown): AuthAuthority {
  if (!isRecord(value) || value.v !== AUTHORITY_SCHEMA_VERSION) {
    throw new SessionError(sessionErrorCodes.recoveryRequired, "Auth authority is missing or malformed");
  }
  const generation = requireOpaqueId(value.generation, "Auth generation");
  const revision = requireRevision(value.revision, "Authority revision");
  if (value.mode === "none") return Object.freeze({ v: 6, mode: "none", generation, revision });
  if (value.mode === "active") {
    const session = validateActivationCertificate(value.session);
    if (session.authGeneration !== generation) {
      throw new SessionError(sessionErrorCodes.recoveryRequired, "Active session generation does not match authority");
    }
    return Object.freeze({ v: 6, mode: "active", generation, revision, session });
  }
  if (value.mode === "transition") {
    const permit = validateAcquisitionTransitionPermit(value.permit);
    const source = value.source === null ? null : validateActivationCertificate(value.source);
    const phase = validatePhase(value.phase);
    const cleanupReceipt =
      value.cleanupReceipt === undefined ? undefined : requireOpaqueId(value.cleanupReceipt, "Cleanup receipt", 2048);
    return Object.freeze({ v: 6, mode: "transition", generation, revision, permit, source, phase, cleanupReceipt });
  }
  if (value.mode === "retiring") {
    const source = validateActivationCertificate(value.source);
    const cause = validateRetirementCause(value.cause);
    const phase = validatePhase(value.phase);
    const cleanupReceipt =
      value.cleanupReceipt === undefined ? undefined : requireOpaqueId(value.cleanupReceipt, "Cleanup receipt", 2048);
    return Object.freeze({ v: 6, mode: "retiring", generation, revision, source, cause, phase, cleanupReceipt });
  }
  throw new SessionError(sessionErrorCodes.recoveryRequired, "Auth authority mode is unsupported");
}

export function sameActivation(left: ActivationCertificate, right: ActivationCertificate): boolean {
  return (
    left.sessionEpoch === right.sessionEpoch &&
    left.authGeneration === right.authGeneration &&
    left.transitionPermitId === right.transitionPermitId &&
    left.serverAuthority === right.serverAuthority &&
    left.accountId === right.accountId &&
    left.scopeKey === right.scopeKey
  );
}

export function credentialCursor(record: CredentialRecord): CredentialCursor {
  return Object.freeze({
    sessionEpoch: record.sessionEpoch,
    credentialRevision: record.credentialRevision,
    credentialFingerprint: record.credentialFingerprint,
  });
}

export function validateCredentialCursor(value: unknown): CredentialCursor {
  if (!isRecord(value)) {
    throw new SessionError(sessionErrorCodes.invalidState, "Credential cursor is malformed");
  }
  return Object.freeze({
    sessionEpoch: requireOpaqueId(value.sessionEpoch, "Credential cursor epoch"),
    credentialRevision: requireRevision(value.credentialRevision, "Credential cursor revision"),
    credentialFingerprint: requireOpaqueId(value.credentialFingerprint, "Credential cursor fingerprint", 1024),
  });
}

export function sameCredentialCursor(left: CredentialCursor, right: CredentialCursor): boolean {
  return (
    left.sessionEpoch === right.sessionEpoch &&
    left.credentialRevision === right.credentialRevision &&
    left.credentialFingerprint === right.credentialFingerprint
  );
}

export function validateCoordinatorSnapshot(value: unknown): CoordinatorSnapshot {
  if (!isRecord(value) || !Array.isArray(value.credentials) || !Array.isArray(value.attempts)) {
    throw new SessionError(sessionErrorCodes.recoveryRequired, "Auth coordinator snapshot is malformed");
  }
  const authority = validateAuthAuthority(value.authority);
  const credentials = Object.freeze(value.credentials.map(validateCredentialRecord));
  const attempts = Object.freeze(value.attempts.map(validateSessionAttempt));

  const credentialEpochs = new Set<string>();
  for (const credential of credentials) {
    if (credentialEpochs.has(credential.sessionEpoch)) {
      throw new SessionError(sessionErrorCodes.recoveryRequired, "Auth coordinator has duplicate credential epochs");
    }
    credentialEpochs.add(credential.sessionEpoch);
  }
  const attemptIds = new Set<string>();
  for (const attempt of attempts) {
    if (attemptIds.has(attempt.attemptId)) {
      throw new SessionError(sessionErrorCodes.recoveryRequired, "Auth coordinator has duplicate attempts");
    }
    attemptIds.add(attempt.attemptId);
  }

  if (authority.mode === "active") {
    if (
      credentials.length !== 1 ||
      !sameActivation(credentials[0]?.activation ?? authority.session, authority.session)
    ) {
      throw new SessionError(
        sessionErrorCodes.recoveryRequired,
        "Active authority does not own exactly one credential",
      );
    }
  } else if (credentials.length !== 0) {
    throw new SessionError(sessionErrorCodes.recoveryRequired, "Non-active authority cannot retain credentials");
  }

  if (authority.mode === "transition") {
    if (
      authority.permit.permitId !== authority.permit.target.transitionPermitId ||
      authority.permit.target.authGeneration !== authority.generation
    ) {
      throw new SessionError(sessionErrorCodes.recoveryRequired, "Transition target does not match its authority");
    }
    const attempt = attempts.find((item) => item.attemptId === authority.permit.attemptId);
    if (
      !attempt ||
      attempt.kind !== "acquisition" ||
      attempt.serverAuthority !== authority.permit.target.serverAuthority
    ) {
      throw new SessionError(sessionErrorCodes.recoveryRequired, "Transition does not own its exact attempt");
    }
    if (authority.source && attempt.baselineGeneration !== authority.source.authGeneration) {
      throw new SessionError(sessionErrorCodes.recoveryRequired, "Transition attempt has another source generation");
    }
    if (authority.source === null && authority.phase !== "source_purged") {
      throw new SessionError(sessionErrorCodes.recoveryRequired, "Anonymous transition must have no source cleanup");
    }
  }

  if (authority.mode === "transition" || authority.mode === "retiring") {
    if (authority.phase === "source_purged") {
      if (!authority.cleanupReceipt) {
        throw new SessionError(sessionErrorCodes.recoveryRequired, "Completed source purge requires a receipt");
      }
    } else if (authority.cleanupReceipt !== undefined) {
      throw new SessionError(sessionErrorCodes.recoveryRequired, "Incomplete source purge cannot carry a receipt");
    }
  }

  return Object.freeze({ authority, credentials, attempts });
}
