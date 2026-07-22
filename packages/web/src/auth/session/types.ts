import { SessionError, sessionErrorCodes } from "./errors.js";
import { createAccountScopeKey } from "./scope.js";

export const AUTHORITY_SCHEMA_VERSION = 6 as const;

const MAX_OPAQUE_ID_LENGTH = 512;
const MAX_TOKEN_LENGTH = 64 * 1024;
const MAX_ATTEMPT_KIND_LENGTH = 128;

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
  credentialRevision: number;
  credentialFingerprint: string;
}>;

export type ActivationCertificateInput = Omit<ActivationCertificate, "v">;

export type ViewLease = Readonly<{
  activation: ActivationCertificate;
  organizationId: string;
  orgRevision: string;
  documentId: string;
  signal: AbortSignal;
}>;

export type ViewLeaseInput = Omit<ViewLease, "activation"> & Readonly<{ activation: unknown }>;

export type CredentialRecord = Readonly<{
  v: 1;
  sessionEpoch: string;
  activation: ActivationCertificate;
  accessToken: string;
  refreshToken: string;
}>;

export type CredentialRecordInput = Readonly<{
  activation: unknown;
  accessToken: string;
  refreshToken: string;
}>;

export type SessionAttempt = Readonly<{
  v: 1;
  attemptId: string;
  kind: string;
  serverAuthority: string;
  baselineGeneration: string;
  sourceEpoch: string | null;
  expiresAt: number;
  payload: Readonly<{ [key: string]: JsonValue }>;
}>;

export type SessionAttemptInput = Omit<SessionAttempt, "v">;

export type TransitionPermit = Readonly<{
  v: 1;
  permitId: string;
  attemptId: string;
  target: ActivationCertificate;
  expiresAt: number;
}>;

export type TransitionPermitInput = Omit<TransitionPermit, "v" | "target"> & Readonly<{ target: unknown }>;

export type AuthorityPhase = "revoked" | "purging" | "source_purged";
export type RetirementCause = "logout" | "owned_401" | "server_mismatch";

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
  permit: TransitionPermit;
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
  const serverAuthority = requireOpaqueId(input.serverAuthority, "Server authority", 2048);
  const accountId = requireOpaqueId(input.accountId, "Account id");
  const scopeKey = requireOpaqueId(input.scopeKey, "Account scope key", 4096);
  if (createAccountScopeKey(serverAuthority, accountId) !== scopeKey) {
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
    credentialRevision: requireRevision(input.credentialRevision, "Credential revision"),
    credentialFingerprint: requireOpaqueId(input.credentialFingerprint, "Credential fingerprint", 1024),
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
    credentialRevision: requireRevision(value.credentialRevision, "Credential revision"),
    credentialFingerprint: requireOpaqueId(value.credentialFingerprint, "Credential fingerprint", 1024),
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
    documentId: requireOpaqueId(input.documentId, "Document id"),
    signal: input.signal,
  });
}

export function validateViewLease(value: unknown): ViewLease {
  if (!isRecord(value)) throw new SessionError(sessionErrorCodes.invalidState, "View lease is malformed");
  if (!isAbortSignal(value.signal)) {
    throw new SessionError(sessionErrorCodes.invalidState, "View lease requires an AbortSignal");
  }
  return createViewLease({
    activation: value.activation,
    organizationId: requireOpaqueId(value.organizationId, "Organization id"),
    orgRevision: requireOpaqueId(value.orgRevision, "Organization revision"),
    documentId: requireOpaqueId(value.documentId, "Document id"),
    signal: value.signal,
  });
}

export function createCredentialRecord(input: CredentialRecordInput): CredentialRecord {
  const activation = validateActivationCertificate(input.activation);
  return Object.freeze({
    v: 1,
    sessionEpoch: activation.sessionEpoch,
    activation,
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
    accessToken: requireToken(value.accessToken, "Access token"),
    refreshToken: requireToken(value.refreshToken, "Refresh token"),
  });
  if (value.sessionEpoch !== record.sessionEpoch) {
    throw new SessionError(sessionErrorCodes.invalidState, "Credential epoch does not match its activation");
  }
  return record;
}

export function createSessionAttempt(input: SessionAttemptInput): SessionAttempt {
  if (input.kind.length > MAX_ATTEMPT_KIND_LENGTH) {
    throw new SessionError(sessionErrorCodes.invalidState, "Attempt kind exceeds the length limit");
  }
  const payload = validateJsonObject(input.payload);
  return Object.freeze({
    v: 1,
    attemptId: requireOpaqueId(input.attemptId, "Attempt id"),
    kind: requireOpaqueId(input.kind, "Attempt kind", MAX_ATTEMPT_KIND_LENGTH),
    serverAuthority: requireOpaqueId(input.serverAuthority, "Server authority", 2048),
    baselineGeneration: requireOpaqueId(input.baselineGeneration, "Attempt baseline generation"),
    sourceEpoch: input.sourceEpoch === null ? null : requireOpaqueId(input.sourceEpoch, "Attempt source epoch"),
    expiresAt: requireExpiry(input.expiresAt),
    payload,
  });
}

export function validateSessionAttempt(value: unknown): SessionAttempt {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.payload)) {
    throw new SessionError(sessionErrorCodes.invalidState, "Session attempt is malformed");
  }
  const payload = validateJsonObject(value.payload);
  return createSessionAttempt({
    attemptId: requireOpaqueId(value.attemptId, "Attempt id"),
    kind: requireOpaqueId(value.kind, "Attempt kind", MAX_ATTEMPT_KIND_LENGTH),
    serverAuthority: requireOpaqueId(value.serverAuthority, "Server authority", 2048),
    baselineGeneration: requireOpaqueId(value.baselineGeneration, "Attempt baseline generation"),
    sourceEpoch: value.sourceEpoch === null ? null : requireOpaqueId(value.sourceEpoch, "Attempt source epoch"),
    expiresAt: requireExpiry(value.expiresAt),
    payload,
  });
}

export function createTransitionPermit(input: TransitionPermitInput): TransitionPermit {
  return Object.freeze({
    v: 1,
    permitId: requireOpaqueId(input.permitId, "Transition permit id"),
    attemptId: requireOpaqueId(input.attemptId, "Transition attempt id"),
    target: validateActivationCertificate(input.target),
    expiresAt: requireExpiry(input.expiresAt),
  });
}

export function validateTransitionPermit(value: unknown): TransitionPermit {
  if (!isRecord(value) || value.v !== 1) {
    throw new SessionError(sessionErrorCodes.invalidState, "Transition permit is malformed");
  }
  return createTransitionPermit({
    permitId: requireOpaqueId(value.permitId, "Transition permit id"),
    attemptId: requireOpaqueId(value.attemptId, "Transition attempt id"),
    target: value.target,
    expiresAt: requireExpiry(value.expiresAt),
  });
}

function validatePhase(value: unknown): AuthorityPhase {
  if (value === "revoked" || value === "purging" || value === "source_purged") return value;
  throw new SessionError(sessionErrorCodes.invalidState, "Authority cleanup phase is malformed");
}

function validateRetirementCause(value: unknown): RetirementCause {
  if (value === "logout" || value === "owned_401" || value === "server_mismatch") return value;
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
    const permit = validateTransitionPermit(value.permit);
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
    left.scopeKey === right.scopeKey &&
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
    if (!attempt || attempt.serverAuthority !== authority.permit.target.serverAuthority) {
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
