import {
  type CandidateMeRequest,
  type CandidateMeResult,
  requestCandidateMe as fetchCandidateMe,
} from "../../api/candidate-client.js";
import { expectedAuthorityHeaders, readBoundedResponseText } from "../../api/server-authority.js";
import { type CapturedAccountRuntimeFence, captureAccountRuntimeFence } from "./account-store-runtime.js";
import { createCandidateTokenSnapshot, fingerprintCandidateTokenSnapshot } from "./candidate-tokens.js";
import { claimVerifiedPurgeCompletion, type VerifiedPurgeCompletion } from "./content-barrier.js";
import { type CapturedContentStoreRuntime, captureContentStoreRuntime } from "./content-store-runtime.js";
import { SessionError, sessionErrorCodes, toSessionError } from "./errors.js";
import { type LegacyScrubOptions, scrubLegacyPersistence } from "./legacy-scrub.js";
import { createAccountScopeKey } from "./scope.js";
import {
  type AccountLease,
  type AcquisitionSessionAttempt,
  type AcquisitionTransitionPermit,
  type ActivationCertificate,
  type ActiveAuthority,
  type AuthAuthority,
  type CoordinatorSnapshot,
  type CredentialCursor,
  type CredentialRecord,
  createCredentialRecord,
  credentialCursor,
  type JsonValue,
  sameAccountLease,
  sameActivation,
  sameCredentialCursor,
  type ViewLease,
  validateAccountLease,
  validateAcquisitionTransitionPermit,
  validateActivationCertificate,
  validateAuthAuthority,
  validateCoordinatorSnapshot,
  validateCredentialCursor,
  validateSessionAttempt,
  validateViewLease,
} from "./types.js";

export const AUTH_COORDINATOR_DATABASE_NAME = "first-tree-auth-coordinator:v1";

const COORDINATOR_DATABASE_VERSION = 1;
const AUTHORITY_STORE = "authority";
const CREDENTIALS_STORE = "credentials";
const ATTEMPTS_STORE = "attempts";
const AUTHORITY_KEY = "head";
const ALL_STORES = [AUTHORITY_STORE, CREDENTIALS_STORE, ATTEMPTS_STORE] as const;

type AuthorityRow = Readonly<{
  key: typeof AUTHORITY_KEY;
  authority: AuthAuthority;
}>;

type CoordinatorDecision<T> =
  | Readonly<{ kind: "unchanged"; value: T }>
  | Readonly<{ kind: "commit"; snapshot: CoordinatorSnapshot; value: T }>;

type CoordinatorPlanner<T> = (snapshot: CoordinatorSnapshot) => CoordinatorDecision<T>;

/**
 * Most coordinator results are document-scoped and may not cross a lifecycle
 * change. A transaction-scoped result is different: its synchronous planner
 * is the authority race's ordering point, so a later lifecycle event cannot
 * turn a committed mutation into an ambiguous delivery failure.
 */
type CoordinatorResultFence = "document-lifecycle" | "transaction";

export type AuthorityCursor = Readonly<{
  generation: string;
  revision: number;
}>;

export type RetirementResult = "retired" | "already_retiring" | "superseded";

export type TransitionCancellationResult =
  | Readonly<{ kind: "cleaning"; authority: AuthAuthority }>
  | Readonly<{ kind: "retiring"; authority: AuthAuthority; source: ActivationCertificate }>
  | Readonly<{ kind: "superseded"; authority: AuthAuthority }>;

export type AnonymousCancellationResult =
  | Readonly<{ kind: "cleaning"; authority: AuthAuthority }>
  | Readonly<{ kind: "superseded"; authority: AuthAuthority }>;

export type ActiveSessionProjection = Readonly<{
  authority: ActiveAuthority;
  credential: CredentialCursor;
}>;

export type VerifiedCandidateMeResult = Readonly<{
  accountId: string;
  payload: Readonly<Record<string, unknown>>;
  proof: VerifiedCandidateProof;
}>;

export type VerifiedActiveMeResult = Readonly<{
  payload: Readonly<Record<string, unknown>>;
  proof: VerifiedActiveMeProof;
}>;

export type ActiveHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ActiveHttpResponseType = "json" | "text" | "bytes";
export type ActiveHttpScope = "selected-organization" | "selected-resource";

export type ActiveHttpRequestBody =
  | Readonly<{ kind: "json"; value: JsonValue }>
  | Readonly<{ kind: "text"; value: string; contentType: string }>
  | Readonly<{ kind: "bytes"; value: ArrayBuffer | ArrayBufferView; contentType: string }>
  | Readonly<{ kind: "blob"; value: Blob; contentType: string }>;

export type ActiveHttpRequest = Readonly<{
  view: ViewLease;
  credential: CredentialCursor;
  scope: ActiveHttpScope;
  path: string;
  method?: ActiveHttpMethod;
  headers?: Readonly<Record<string, string>>;
  body?: ActiveHttpRequestBody;
  responseType: ActiveHttpResponseType;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}>;

type ActiveHttpResponseBase = Readonly<{
  status: number;
  ok: boolean;
  headers: Readonly<Record<string, string>>;
}>;

export type ActiveHttpResponse =
  | (ActiveHttpResponseBase & Readonly<{ responseType: "json"; body: JsonValue | null }>)
  | (ActiveHttpResponseBase & Readonly<{ responseType: "text"; body: string }>)
  | (ActiveHttpResponseBase & Readonly<{ responseType: "bytes"; body: Uint8Array }>);

const REFRESH_ENDPOINT = "/api/v1/auth/refresh";
const ACTIVE_HTTP_BASE_URL = "/api/v1";
const MAX_REFRESH_RESPONSE_BYTES = 64 * 1024;
const MAX_ACTIVE_ME_RESPONSE_BYTES = 512 * 1024;
const MAX_ACTIVE_ME_MEMBERSHIPS = 100_000;
const MAX_ACTIVE_HTTP_PATH_BYTES = 4096;
const MAX_ACTIVE_HTTP_BODY_BYTES = 16 * 1024 * 1024;
const MAX_ACTIVE_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_ACTIVE_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVE_HTTP_JSON_DEPTH = 100;
const MAX_ACTIVE_HTTP_JSON_NODES = 100_000;
const MAX_ACTIVE_HTTP_REQUEST_HEADERS = 64;
const MAX_ACTIVE_HTTP_RESPONSE_HEADERS = 128;
const MAX_ACTIVE_HTTP_HEADER_NAME_BYTES = 256;
const MAX_ACTIVE_HTTP_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_ACTIVE_HTTP_HEADERS_BYTES = 64 * 1024;
const ACTIVE_HTTP_METHODS = new Set<ActiveHttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ACTIVE_HTTP_RESOURCE_ROOTS = new Set([
  "activity",
  "agents",
  "attachments",
  "chats",
  "docs",
  "resources",
  "sessions",
]);
const FORBIDDEN_ACTIVE_HTTP_HEADERS = new Set([
  "accept",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "forwarded",
  "host",
  "origin",
  "proxy-authorization",
  "referer",
  "referrer",
  "refresh-token",
  "transfer-encoding",
  "upgrade",
  "x-first-tree-expected-authority",
]);
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const HTTP_HEADER_VALUE = /^[\t\u0020-\u007e\u0080-\u00ff]*$/u;

declare const verifiedCandidateProofType: unique symbol;
declare const refreshResponseProofType: unique symbol;
declare const accountRefreshResponseProofType: unique symbol;
declare const verifiedActiveMeProofType: unique symbol;

export type VerifiedCandidateProof = Readonly<{ [verifiedCandidateProofType]: never }>;
export type VerifiedActiveMeProof = Readonly<{ [verifiedActiveMeProofType]: never }>;

type VerifiedCandidateEvidence = Readonly<{
  candidate: CandidateMeResult["candidate"];
  serverAuthority: string;
  accountId: string;
  attempt: AcquisitionSessionAttempt;
  signal: AbortSignal;
  lifecycleGeneration: number;
}>;

type CandidateProofState = {
  evidence: VerifiedCandidateEvidence;
  state: "available" | "claimed" | "consumed";
};

type RefreshResponseProof = Readonly<{ [refreshResponseProofType]: never }>;

type RefreshResponseState = {
  activation: ActivationCertificate;
  expectedCredential: CredentialCursor;
  capturedCredential: CredentialRecord;
  replacement: CredentialRecord;
  view: ViewLease;
  lifecycleGeneration: number;
  state: "available" | "claimed" | "consumed";
};

type AccountRefreshResponseProof = Readonly<{ [accountRefreshResponseProofType]: never }>;

type AccountRefreshResponseState = {
  activation: ActivationCertificate;
  expectedCredential: CredentialCursor;
  capturedCredential: CredentialRecord;
  replacement: CredentialRecord;
  runtime: CapturedAccountRuntimeFence;
  lifecycleGeneration: number;
  assertOwnerCurrent?: () => void;
  state: "available" | "claimed" | "consumed";
};

type VerifiedActiveMeEvidence = Readonly<{
  runtime: CapturedAccountRuntimeFence;
  membershipIds: readonly string[];
  defaultOrganizationId: string | null;
  lifecycleGeneration: number;
  requestKey: string;
  requestSequence: number;
}>;

type VerifiedActiveMeProofState = {
  evidence: VerifiedActiveMeEvidence;
  state: "available" | "claimed" | "consumed";
};

type ActiveMe401RefreshEvidence = Readonly<{
  purpose: "refresh";
  runtime: CapturedAccountRuntimeFence;
  signal: AbortSignal;
  capturedCredential: CredentialRecord;
  expectedCredential: CredentialCursor;
  lifecycleGeneration: number;
  requestKey: string;
  requestSequence: number;
}>;

type ActiveMe401RetirementEvidence = Readonly<{
  purpose: "retire";
  activation: ActivationCertificate;
  capturedCredential: CredentialRecord;
  expectedCredential: CredentialCursor;
  authorityRevision: number;
  retirementGeneration: string;
}>;

type ActiveMe401Evidence = ActiveMe401RefreshEvidence | ActiveMe401RetirementEvidence;

type ActiveMe401State = {
  evidence: ActiveMe401Evidence;
  state: "available" | "claimed" | "consumed";
};

type ActiveMeRetryEvidence = Readonly<{
  runtime: CapturedAccountRuntimeFence;
  signal: AbortSignal;
  refreshedCredential: CredentialRecord;
  expectedCredential: CredentialCursor;
  authorityRevision: number;
  lifecycleGeneration: number;
  requestKey: string;
  priorRequestSequence: number;
  retirementGeneration: string;
}>;

type ActiveMeRetryState = {
  evidence: ActiveMeRetryEvidence;
  state: "available" | "consumed";
};

type CommittedAccountRefresh = Readonly<{
  cursor: CredentialCursor;
  replacement: CredentialRecord;
  authorityRevision: number;
}>;

type ActiveHttpResponseState = {
  activation: ActivationCertificate;
  credential: CredentialCursor;
  capturedCredential: CredentialRecord;
  authorityRevision: number;
  status: number;
  state: "available" | "claimed" | "consumed";
};

export type ClaimedVerifiedActiveMeProof = Readonly<{
  membershipIds: readonly string[];
  defaultOrganizationId: string | null;
  assertCurrent: () => void;
  settle: () => void;
}>;

const verifiedCandidateProofs = new WeakMap<VerifiedCandidateProof, CandidateProofState>();
const refreshResponseProofs = new WeakMap<RefreshResponseProof, RefreshResponseState>();
const accountRefreshResponseProofs = new WeakMap<AccountRefreshResponseProof, AccountRefreshResponseState>();
const verifiedActiveMeProofs = new WeakMap<VerifiedActiveMeProof, VerifiedActiveMeProofState>();
const activeMe401Rejections = new WeakMap<SessionError, ActiveMe401State>();
const activeMeRetryClaims = new WeakMap<SessionError, ActiveMeRetryState>();
const latestActiveMeRequests = new Map<string, number>();
const activeMe401RefreshOwners = new Map<string, ActiveMe401State>();
/**
 * The original result object, not its public status, is the capability that a
 * later coordinator-owned 401 retirement path may consume. This deliberately
 * has no exported reader and cannot be copied with object spread.
 */
const activeHttpResponses = new WeakMap<ActiveHttpResponse, ActiveHttpResponseState>();

export type CoordinatorOptions = Readonly<{
  indexedDB?: IDBFactory;
  onBlocked?: (databaseName: string) => void;
  legacyPersistence?: LegacyScrubOptions;
}>;

const coordinatorConnections = new Set<IDBDatabase>();
let coordinatorLifecycleGeneration = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireActiveMeOrganizationId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Account identity response is malformed");
  }
  return value;
}

function freezeParsedJson<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  const pending: object[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !("value" in descriptor)) continue;
      const child = descriptor.value;
      if (typeof child === "object" && child !== null) pending.push(child);
    }
    Object.freeze(current);
  }
  return value;
}

function activeHttpInvalid(message: string): SessionError {
  return new SessionError(sessionErrorCodes.invalidState, message);
}

function activeHttpStale(message: string): SessionError {
  return new SessionError(sessionErrorCodes.staleOperation, message);
}

function hasUnsafeActiveHttpPathCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || character === "\\") return true;
  }
  return false;
}

function decodeCanonicalActiveHttpPath(rawPathname: string): readonly string[] {
  const rawSegments = rawPathname.split("/");
  if (rawSegments.shift() !== "" || rawSegments.length === 0) {
    throw activeHttpInvalid("Authenticated request path is malformed");
  }
  const decodedSegments: string[] = [];
  for (let index = 0; index < rawSegments.length; index += 1) {
    const rawSegment = rawSegments[index] ?? "";
    if (rawSegment.length === 0) {
      if (index === rawSegments.length - 1 && rawSegments.length > 1) continue;
      throw activeHttpInvalid("Authenticated request path contains an empty segment");
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      throw activeHttpInvalid("Authenticated request path encoding is malformed");
    }
    if (
      rawSegment !== encodeURIComponent(decoded) ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      hasUnsafeActiveHttpPathCharacter(decoded)
    ) {
      throw activeHttpInvalid("Authenticated request path segment is not canonical");
    }
    decodedSegments.push(decoded);
  }
  if (decodedSegments.length === 0) {
    throw activeHttpInvalid("Authenticated request path is malformed");
  }
  return Object.freeze(decodedSegments);
}

function isOAuthManagementPath(segments: readonly string[]): boolean {
  const isInstallationManagement =
    segments.length === 4 &&
    segments[0] === "orgs" &&
    segments[2] === "github-app-installation" &&
    (segments[3] === "install-url" || segments[3] === "connect" || segments[3] === "finalize");
  const isProviderKickoff =
    segments.length === 5 &&
    segments[0] === "me" &&
    segments[1] === "auth-providers" &&
    (segments[3] === "link" || segments[3] === "unlink") &&
    segments[4] === "start";
  return isInstallationManagement || isProviderKickoff;
}

function requireActiveHttpPath(value: unknown, scope: unknown, view: ViewLease, method: ActiveHttpMethod): string {
  if (typeof value !== "string" || value.length === 0) {
    throw activeHttpInvalid("Authenticated request path is malformed");
  }
  if (new TextEncoder().encode(value).byteLength > MAX_ACTIVE_HTTP_PATH_BYTES) {
    throw activeHttpInvalid("Authenticated request path is oversized");
  }
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("#") ||
    hasUnsafeActiveHttpPathCharacter(value)
  ) {
    throw activeHttpInvalid("Authenticated request path is unsafe");
  }
  const rawPathname = value.split("?", 1)[0] ?? "";
  const decodedSegments = decodeCanonicalActiveHttpPath(rawPathname);
  if (isOAuthManagementPath(decodedSegments)) {
    throw activeHttpInvalid("Authenticated requests may not use an OAuth management surface");
  }

  let url: URL;
  try {
    url = new URL(`${ACTIVE_HTTP_BASE_URL}${value}`, "https://first-tree.invalid");
  } catch {
    throw activeHttpInvalid("Authenticated request path is malformed");
  }
  if (
    url.origin !== "https://first-tree.invalid" ||
    `${url.pathname}${url.search}` !== `${ACTIVE_HTTP_BASE_URL}${value}` ||
    (url.pathname !== ACTIVE_HTTP_BASE_URL && !url.pathname.startsWith(`${ACTIVE_HTTP_BASE_URL}/`))
  ) {
    throw activeHttpInvalid("Authenticated request path is not canonical");
  }

  if (scope === "selected-organization") {
    if (decodedSegments[0] !== "orgs") {
      throw activeHttpInvalid("Organization-scoped request path is malformed");
    }
    const organizationId = decodedSegments[1];
    if (organizationId === undefined || organizationId !== view.organizationId) {
      throw activeHttpInvalid("Authenticated request targets another organization");
    }
  } else if (scope === "selected-resource") {
    if (!ACTIVE_HTTP_RESOURCE_ROOTS.has(decodedSegments[0] ?? "")) {
      throw activeHttpInvalid("Authenticated request is outside the active resource surface");
    }
    if (
      method === "GET" &&
      decodedSegments.length === 3 &&
      decodedSegments[0] === "agents" &&
      decodedSegments[2] === "avatar"
    ) {
      throw activeHttpInvalid("Public avatar reads may not use authenticated transport");
    }
  } else {
    throw activeHttpInvalid("Authenticated request scope is malformed");
  }
  return value;
}

function requireActiveHttpMethod(value: unknown): ActiveHttpMethod {
  const method = value ?? "GET";
  if (typeof method !== "string" || !ACTIVE_HTTP_METHODS.has(method as ActiveHttpMethod)) {
    throw activeHttpInvalid("Authenticated request method is unsupported");
  }
  return method as ActiveHttpMethod;
}

function requireActiveHttpResponseType(value: unknown): ActiveHttpResponseType {
  if (value !== "json" && value !== "text" && value !== "bytes") {
    throw activeHttpInvalid("Authenticated response type is unsupported");
  }
  return value;
}

function requireActiveHttpResponseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_ACTIVE_HTTP_RESPONSE_BYTES;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_ACTIVE_HTTP_RESPONSE_BYTES
  ) {
    throw activeHttpInvalid("Authenticated response byte limit is invalid");
  }
  return value;
}

function requireActiveHttpContentType(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || !HTTP_HEADER_VALUE.test(value)) {
    throw activeHttpInvalid("Authenticated request content type is malformed");
  }
  return value;
}

function snapshotActiveHttpHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) throw activeHttpInvalid("Authenticated request headers are malformed");
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw activeHttpInvalid("Authenticated request headers are malformed");
  }
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  const normalizedNames = new Set<string>();
  let encodedBytes = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw activeHttpInvalid("Authenticated request headers are malformed");
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw activeHttpInvalid("Authenticated request headers are malformed");
    }
    const normalized = key.toLowerCase();
    const keyBytes = new TextEncoder().encode(key).byteLength;
    const valueBytes = new TextEncoder().encode(descriptor.value).byteLength;
    encodedBytes += keyBytes + valueBytes + 4;
    if (
      !HTTP_HEADER_NAME.test(key) ||
      !HTTP_HEADER_VALUE.test(descriptor.value) ||
      normalizedNames.size >= MAX_ACTIVE_HTTP_REQUEST_HEADERS ||
      keyBytes > MAX_ACTIVE_HTTP_HEADER_NAME_BYTES ||
      valueBytes > MAX_ACTIVE_HTTP_HEADER_VALUE_BYTES ||
      encodedBytes > MAX_ACTIVE_HTTP_HEADERS_BYTES ||
      normalizedNames.has(normalized) ||
      FORBIDDEN_ACTIVE_HTTP_HEADERS.has(normalized) ||
      normalized.startsWith("sec-") ||
      normalized.startsWith("proxy-") ||
      normalized.startsWith("x-forwarded-")
    ) {
      throw activeHttpInvalid("Authenticated request header is unsafe");
    }
    normalizedNames.add(normalized);
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

type JsonSnapshotState = {
  nodes: number;
  seen: Set<object>;
};

function snapshotActiveHttpJson(value: unknown, depth = 0, state?: JsonSnapshotState): JsonValue {
  const currentState = state ?? { nodes: 0, seen: new Set<object>() };
  currentState.nodes += 1;
  if (currentState.nodes > MAX_ACTIVE_HTTP_JSON_NODES || depth > MAX_ACTIVE_HTTP_JSON_DEPTH) {
    throw activeHttpInvalid("Authenticated JSON request body is too complex");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw activeHttpInvalid("Authenticated JSON request body is malformed");
    return value;
  }
  if (typeof value !== "object") throw activeHttpInvalid("Authenticated JSON request body is malformed");
  if (currentState.seen.has(value)) throw activeHttpInvalid("Authenticated JSON request body is cyclic");
  currentState.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          throw activeHttpInvalid("Authenticated JSON request body is sparse or accessor-backed");
        }
        output.push(snapshotActiveHttpJson(descriptor.value, depth + 1, currentState));
      }
      return Object.freeze(output);
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw activeHttpInvalid("Authenticated JSON request body is malformed");
    }
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw activeHttpInvalid("Authenticated JSON request body is malformed");
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw activeHttpInvalid("Authenticated JSON request body is accessor-backed");
      }
      output[key] = snapshotActiveHttpJson(descriptor.value, depth + 1, currentState);
    }
    return Object.freeze(output);
  } finally {
    currentState.seen.delete(value);
  }
}

type CapturedActiveHttpBody = Readonly<{
  body: BodyInit | undefined;
  contentType: string | null;
}>;

function snapshotActiveHttpBody(value: unknown, method: ActiveHttpMethod): CapturedActiveHttpBody {
  if (value === undefined) return Object.freeze({ body: undefined, contentType: null });
  if (method === "GET" || !isRecord(value)) {
    throw activeHttpInvalid("Authenticated request body is not allowed");
  }
  const kind = value.kind;
  const bodyValue = value.value;
  const contentTypeValue = value.contentType;
  let body: BodyInit;
  let contentType: string;
  if (kind === "json") {
    const json = JSON.stringify(snapshotActiveHttpJson(bodyValue));
    if (new TextEncoder().encode(json).byteLength > MAX_ACTIVE_HTTP_BODY_BYTES) {
      throw activeHttpInvalid("Authenticated request body is oversized");
    }
    body = json;
    contentType = "application/json";
  } else if (kind === "text") {
    if (typeof bodyValue !== "string") throw activeHttpInvalid("Authenticated text request body is malformed");
    if (new TextEncoder().encode(bodyValue).byteLength > MAX_ACTIVE_HTTP_BODY_BYTES) {
      throw activeHttpInvalid("Authenticated request body is oversized");
    }
    body = bodyValue;
    contentType = requireActiveHttpContentType(contentTypeValue);
  } else if (kind === "bytes") {
    let bytes: Uint8Array;
    if (bodyValue instanceof ArrayBuffer) {
      bytes = new Uint8Array(bodyValue).slice();
    } else if (ArrayBuffer.isView(bodyValue)) {
      bytes = new Uint8Array(bodyValue.buffer, bodyValue.byteOffset, bodyValue.byteLength).slice();
    } else {
      throw activeHttpInvalid("Authenticated byte request body is malformed");
    }
    if (bytes.byteLength > MAX_ACTIVE_HTTP_BODY_BYTES) {
      throw activeHttpInvalid("Authenticated request body is oversized");
    }
    const copiedBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copiedBuffer).set(bytes);
    body = copiedBuffer;
    contentType = requireActiveHttpContentType(contentTypeValue);
  } else if (kind === "blob") {
    if (typeof Blob === "undefined" || !(bodyValue instanceof Blob)) {
      throw activeHttpInvalid("Authenticated Blob request body is malformed");
    }
    const sizeDescriptor = Reflect.getOwnPropertyDescriptor(Blob.prototype, "size");
    const size =
      sizeDescriptor && typeof sizeDescriptor.get === "function" ? sizeDescriptor.get.call(bodyValue) : Number.NaN;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ACTIVE_HTTP_BODY_BYTES) {
      throw activeHttpInvalid("Authenticated request body is oversized");
    }
    contentType = requireActiveHttpContentType(contentTypeValue);
    try {
      body = Blob.prototype.slice.call(bodyValue, 0, size, contentType);
    } catch {
      throw activeHttpInvalid("Authenticated Blob request body is malformed");
    }
    if (!(body instanceof Blob) || body.size !== size || body.type !== contentType.toLowerCase()) {
      throw activeHttpInvalid("Authenticated Blob request body snapshot is malformed");
    }
  } else {
    throw activeHttpInvalid("Authenticated request body kind is unsupported");
  }
  return Object.freeze({ body, contentType });
}

function snapshotResponseHeaders(headers: Headers, sessionBoundaryResponse: boolean): Readonly<Record<string, string>> {
  // Control responses are consumed only by BrowserSessionRuntime. Retaining
  // untrusted response metadata would defeat body sanitization without adding
  // any authority signal, so expose no headers for 401/421/503.
  if (sessionBoundaryResponse) return Object.freeze({});
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  let count = 0;
  let encodedBytes = 0;
  headers.forEach((value, key) => {
    count += 1;
    const keyBytes = new TextEncoder().encode(key).byteLength;
    const valueBytes = new TextEncoder().encode(value).byteLength;
    encodedBytes += keyBytes + valueBytes + 4;
    if (
      count > MAX_ACTIVE_HTTP_RESPONSE_HEADERS ||
      keyBytes > MAX_ACTIVE_HTTP_HEADER_NAME_BYTES ||
      valueBytes > MAX_ACTIVE_HTTP_HEADER_VALUE_BYTES ||
      encodedBytes > MAX_ACTIVE_HTTP_HEADERS_BYTES
    ) {
      throw new Error("oversized response headers");
    }
    output[key] = value;
  });
  return Object.freeze(output);
}

async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new Error("oversized response");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) throw new Error("oversized response");
      chunks.push(value.slice());
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("malformed response");
  }
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function sameCapturedContentRuntime(
  left: CapturedContentStoreRuntime,
  right: CapturedContentStoreRuntime | null,
): boolean {
  return right !== null && sameView(left.lease, right.lease);
}

function combineActiveHttpSignals(
  lifecycleSignal: AbortSignal,
  requestSignal: AbortSignal | undefined,
): Readonly<{ signal: AbortSignal; dispose: () => void }> {
  if (!requestSignal || requestSignal === lifecycleSignal) {
    return Object.freeze({ signal: lifecycleSignal, dispose: () => undefined });
  }
  if (
    typeof requestSignal !== "object" ||
    typeof requestSignal.aborted !== "boolean" ||
    typeof requestSignal.addEventListener !== "function" ||
    typeof requestSignal.removeEventListener !== "function"
  ) {
    throw activeHttpInvalid("Authenticated request signal is malformed");
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort(activeHttpStale("Authenticated request was cancelled"));
  lifecycleSignal.addEventListener("abort", abort, { once: true });
  requestSignal.addEventListener("abort", abort, { once: true });
  if (lifecycleSignal.aborted || requestSignal.aborted) abort();
  return Object.freeze({
    signal: controller.signal,
    dispose: () => {
      lifecycleSignal.removeEventListener("abort", abort);
      requestSignal.removeEventListener("abort", abort);
    },
  });
}

function parseActiveMeResponse(
  value: unknown,
  expectedAccountId: string,
): Readonly<{
  payload: Readonly<Record<string, unknown>>;
  membershipIds: readonly string[];
  defaultOrganizationId: string | null;
}> {
  if (!isRecord(value) || !isRecord(value.user) || value.user.id !== expectedAccountId) {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Account identity response is malformed");
  }
  const memberships = value.memberships;
  if (!Array.isArray(memberships) || memberships.length > MAX_ACTIVE_ME_MEMBERSHIPS) {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Account identity memberships are malformed");
  }
  const membershipIds: string[] = [];
  for (let index = 0; index < memberships.length; index += 1) {
    if (Reflect.getOwnPropertyDescriptor(memberships, String(index)) === undefined) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Account identity memberships are malformed");
    }
    const membership = memberships[index];
    if (!isRecord(membership)) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Account identity memberships are malformed");
    }
    membershipIds.push(requireActiveMeOrganizationId(membership.organizationId));
  }
  const defaultValue = value.defaultOrganizationId;
  const defaultOrganizationId =
    defaultValue === null || defaultValue === undefined ? null : requireActiveMeOrganizationId(defaultValue);
  return Object.freeze({
    payload: freezeParsedJson(value),
    membershipIds: Object.freeze(membershipIds),
    defaultOrganizationId,
  });
}

function createVerifiedCandidateProof(evidence: VerifiedCandidateEvidence): VerifiedCandidateProof {
  const proof = Object.freeze({}) as VerifiedCandidateProof;
  verifiedCandidateProofs.set(proof, { evidence, state: "available" });
  return proof;
}

function activeMeRequestKey(lease: AccountLease): string {
  const { activation } = lease;
  return JSON.stringify([
    activation.sessionEpoch,
    activation.authGeneration,
    activation.transitionPermitId,
    activation.serverAuthority,
    activation.accountId,
    activation.scopeKey,
    lease.accountRevision,
    lease.ownerTabId,
    lease.documentId,
  ]);
}

function nextActiveMeSequence(key: string): number {
  const next = (latestActiveMeRequests.get(key) ?? 0) + 1;
  latestActiveMeRequests.set(key, next);
  return next;
}

function assertActiveMeSequence(key: string, sequence: number): void {
  if (latestActiveMeRequests.get(key) !== sequence) {
    throw new SessionError(sessionErrorCodes.staleOperation, "A newer account identity response superseded this one");
  }
}

function consumeActiveMeRetryClaim(
  value: unknown,
  sourceLease: AccountLease,
  runtime: CapturedAccountRuntimeFence,
  lifecycleGeneration: number,
  requestKey: string,
): ActiveMeRetryEvidence {
  if (!(value instanceof SessionError)) {
    throw new SessionError(sessionErrorCodes.invalidState, "Account identity retry claim is malformed");
  }
  const state = activeMeRetryClaims.get(value);
  const evidence = state?.evidence;
  if (
    !state ||
    state.state !== "available" ||
    !evidence ||
    evidence.lifecycleGeneration !== lifecycleGeneration ||
    evidence.signal !== runtime.lease.signal ||
    evidence.runtime.lease !== runtime.lease ||
    !sameAccountLease(evidence.runtime.sourceLease, sourceLease) ||
    evidence.requestKey !== requestKey ||
    latestActiveMeRequests.get(requestKey) !== evidence.priorRequestSequence
  ) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Account identity retry claim is stale");
  }
  if (evidence.signal.aborted) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Account identity retry claim crossed a lifecycle fence");
  }
  evidence.runtime.assertCurrent();
  state.state = "consumed";
  return evidence;
}

function requireVerifiedActiveMeEvidence(proofValue: unknown, leaseValue: unknown): VerifiedActiveMeProofState {
  if (typeof proofValue !== "object" || proofValue === null) {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Verified account identity proof is unavailable");
  }
  const state = verifiedActiveMeProofs.get(proofValue as VerifiedActiveMeProof);
  const evidence = state?.evidence;
  const sourceLease = validateAccountLease(leaseValue);
  if (
    !state ||
    state.state !== "available" ||
    !evidence ||
    !sameAccountLease(evidence.runtime.sourceLease, sourceLease) ||
    evidence.lifecycleGeneration !== coordinatorLifecycleGeneration
  ) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Verified account identity proof is stale");
  }
  evidence.runtime.assertCurrent();
  assertActiveMeSequence(evidence.requestKey, evidence.requestSequence);
  return state;
}

export function readVerifiedActiveMeProof(
  proofValue: unknown,
  leaseValue: unknown,
): Readonly<{ membershipIds: readonly string[]; defaultOrganizationId: string | null }> {
  const evidence = requireVerifiedActiveMeEvidence(proofValue, leaseValue).evidence;
  return Object.freeze({
    membershipIds: evidence.membershipIds,
    defaultOrganizationId: evidence.defaultOrganizationId,
  });
}

export function claimVerifiedActiveMeProof(proofValue: unknown, leaseValue: unknown): ClaimedVerifiedActiveMeProof {
  const state = requireVerifiedActiveMeEvidence(proofValue, leaseValue);
  const runtime = state.evidence.runtime;
  state.state = "claimed";
  let settled = false;
  const assertCurrent = (): void => {
    const evidence = state.evidence;
    if (state.state !== "claimed" || evidence.lifecycleGeneration !== coordinatorLifecycleGeneration) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Verified account identity claim is stale");
    }
    // A successful claim is the organization-navigation ordering point. A
    // newer /me may start, but it cannot split a durable selected-head commit
    // from this claim's synchronous publication.
    runtime.assertCurrent();
  };
  return Object.freeze({
    membershipIds: state.evidence.membershipIds,
    defaultOrganizationId: state.evidence.defaultOrganizationId,
    assertCurrent,
    settle: (): void => {
      if (settled) return;
      settled = true;
      state.state = "consumed";
    },
  });
}

function readVerifiedCandidateProof(value: unknown): VerifiedCandidateEvidence {
  if (typeof value !== "object" || value === null) {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Verified candidate proof is unavailable");
  }
  const state = verifiedCandidateProofs.get(value as VerifiedCandidateProof);
  if (!state || state.state !== "available") {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Verified candidate proof is unavailable");
  }
  if (state.evidence.signal.aborted || state.evidence.lifecycleGeneration !== coordinatorLifecycleGeneration) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Verified candidate proof crossed a lifecycle fence");
  }
  return state.evidence;
}

function claimVerifiedCandidateProof(value: unknown): Readonly<{
  evidence: VerifiedCandidateEvidence;
  settle: (committed: boolean) => void;
}> {
  const evidence = readVerifiedCandidateProof(value);
  const proof = value as VerifiedCandidateProof;
  const state = verifiedCandidateProofs.get(proof);
  if (!state) throw invariantFailure("Verified candidate proof state disappeared");
  state.state = "claimed";
  let settled = false;
  return Object.freeze({
    evidence,
    settle: (committed: boolean): void => {
      if (settled) return;
      settled = true;
      state.state = committed ? "consumed" : "available";
    },
  });
}

function createRefreshResponseProof(state: Omit<RefreshResponseState, "state">): RefreshResponseProof {
  const proof = Object.freeze({}) as RefreshResponseProof;
  refreshResponseProofs.set(proof, { ...state, state: "available" });
  return proof;
}

function claimRefreshResponseProof(value: unknown): Readonly<{
  state: RefreshResponseState;
  settle: (committed: boolean) => void;
}> {
  if (typeof value !== "object" || value === null) {
    throw new SessionError(sessionErrorCodes.invalidState, "Refresh response proof is malformed");
  }
  const state = refreshResponseProofs.get(value as RefreshResponseProof);
  if (!state || state.state !== "available") {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Refresh response proof is unavailable");
  }
  if (state.view.signal.aborted || state.lifecycleGeneration !== coordinatorLifecycleGeneration) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Refresh response proof crossed a lifecycle fence");
  }
  state.state = "claimed";
  let settled = false;
  return Object.freeze({
    state,
    settle: (committed: boolean): void => {
      if (settled) return;
      settled = true;
      state.state = committed ? "consumed" : "available";
    },
  });
}

function assertAccountRefreshStateCurrent(state: AccountRefreshResponseState): void {
  if (state.runtime.lease.signal.aborted || state.lifecycleGeneration !== coordinatorLifecycleGeneration) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Account refresh crossed a lifecycle fence");
  }
  state.runtime.assertCurrent();
  state.assertOwnerCurrent?.();
}

function createAccountRefreshResponseProof(
  state: Omit<AccountRefreshResponseState, "state">,
): AccountRefreshResponseProof {
  const proof = Object.freeze({}) as AccountRefreshResponseProof;
  accountRefreshResponseProofs.set(proof, { ...state, state: "available" });
  return proof;
}

function claimAccountRefreshResponseProof(value: unknown): Readonly<{
  state: AccountRefreshResponseState;
  settle: (committed: boolean) => void;
}> {
  if (typeof value !== "object" || value === null) {
    throw new SessionError(sessionErrorCodes.invalidState, "Account refresh response proof is malformed");
  }
  const state = accountRefreshResponseProofs.get(value as AccountRefreshResponseProof);
  if (!state || state.state !== "available") {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Account refresh response proof is unavailable");
  }
  assertAccountRefreshStateCurrent(state);
  state.state = "claimed";
  let settled = false;
  return Object.freeze({
    state,
    settle: (committed: boolean): void => {
      if (settled) return;
      settled = true;
      state.state = committed ? "consumed" : "available";
    },
  });
}

function invariantFailure(message: string): SessionError {
  return new SessionError(sessionErrorCodes.recoveryRequired, message);
}

function requireGeneration(generation: string): string {
  if (generation.length === 0 || generation.length > 512) {
    throw new SessionError(sessionErrorCodes.invalidState, "Auth generation must be a non-empty bounded string");
  }
  return generation;
}

function requireCleanupReceipt(receipt: string): string {
  if (receipt.length === 0 || receipt.length > 2048) {
    throw new SessionError(sessionErrorCodes.invalidState, "Cleanup receipt must be a non-empty bounded string");
  }
  return receipt;
}

function sameCleaningAuthority(
  left: Extract<AuthAuthority, { mode: "cleaning" }>,
  right: Extract<AuthAuthority, { mode: "cleaning" }>,
): boolean {
  return (
    left.generation === right.generation &&
    left.revision === right.revision &&
    left.cause === right.cause &&
    left.forbiddenGenerations.length === right.forbiddenGenerations.length &&
    left.forbiddenGenerations.every((generation, index) => generation === right.forbiddenGenerations[index])
  );
}

function createVerifiedTransitionTarget(
  value: unknown,
  serverAuthority: string,
  accountId: string,
): ActivationCertificate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionError(sessionErrorCodes.invalidState, "Transition target metadata is malformed");
  }
  const metadata = value as Readonly<Record<string, unknown>>;
  return validateActivationCertificate({
    v: 1,
    sessionEpoch: metadata.sessionEpoch,
    authGeneration: metadata.authGeneration,
    transitionPermitId: metadata.transitionPermitId,
    serverAuthority,
    accountId,
    scopeKey: createAccountScopeKey(serverAuthority, accountId),
  });
}

function getIndexedDbFactory(explicitFactory?: IDBFactory): IDBFactory {
  if (explicitFactory) return explicitFactory;
  if (typeof indexedDB === "undefined") {
    throw new SessionError(
      sessionErrorCodes.persistenceUnavailable,
      "IndexedDB is required for authenticated sessions",
    );
  }
  return indexedDB;
}

function openCoordinatorDatabase(
  factory: IDBFactory,
  onBlocked?: (databaseName: string) => void,
  enforceLifecycleFence = true,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const lifecycleGeneration = coordinatorLifecycleGeneration;
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(AUTH_COORDINATOR_DATABASE_NAME, COORDINATOR_DATABASE_VERSION);
    } catch (error) {
      reject(toSessionError(error, sessionErrorCodes.persistenceUnavailable, "Auth coordinator could not be opened"));
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (lifecycleGeneration !== coordinatorLifecycleGeneration) {
        request.transaction?.abort();
        database.close();
        return;
      }
      if (!database.objectStoreNames.contains(AUTHORITY_STORE)) {
        database.createObjectStore(AUTHORITY_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(CREDENTIALS_STORE)) {
        database.createObjectStore(CREDENTIALS_STORE, { keyPath: "sessionEpoch" });
      }
      if (!database.objectStoreNames.contains(ATTEMPTS_STORE)) {
        database.createObjectStore(ATTEMPTS_STORE, { keyPath: "attemptId" });
      }
    };
    request.onblocked = () => onBlocked?.(AUTH_COORDINATOR_DATABASE_NAME);
    request.onerror = () => {
      reject(
        toSessionError(request.error, sessionErrorCodes.persistenceUnavailable, "Auth coordinator open request failed"),
      );
    };
    request.onsuccess = () => {
      const database = request.result;
      if (enforceLifecycleFence && lifecycleGeneration !== coordinatorLifecycleGeneration) {
        database.close();
        reject(new SessionError(sessionErrorCodes.staleOperation, "Auth coordinator open was cancelled by lifecycle"));
        return;
      }
      coordinatorConnections.add(database);
      database.onversionchange = () => {
        database.close();
        coordinatorConnections.delete(database);
      };
      resolve(database);
    };
  });
}

function openTransaction(database: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
  if (mode === "readonly") return database.transaction(ALL_STORES, mode);
  try {
    return database.transaction(ALL_STORES, mode, { durability: "strict" });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return database.transaction(ALL_STORES, mode);
  }
}

function closeCoordinatorDatabase(database: IDBDatabase): void {
  database.close();
  coordinatorConnections.delete(database);
}

function parseSnapshot(
  authorityValue: unknown,
  credentialsValue: unknown,
  attemptsValue: unknown,
  allowMissingAuthority: boolean,
): CoordinatorSnapshot | null {
  if (!Array.isArray(credentialsValue) || !Array.isArray(attemptsValue)) {
    throw invariantFailure("Auth coordinator stores are malformed");
  }

  let authority: AuthAuthority | null;
  if (authorityValue === undefined) {
    authority = null;
  } else if (
    typeof authorityValue === "object" &&
    authorityValue !== null &&
    !Array.isArray(authorityValue) &&
    "key" in authorityValue &&
    authorityValue.key === AUTHORITY_KEY &&
    "authority" in authorityValue
  ) {
    authority = authorityValue.authority as AuthAuthority;
  } else {
    throw invariantFailure("Auth coordinator authority row is malformed");
  }

  if (authority === null) {
    if (credentialsValue.length !== 0 || attemptsValue.length !== 0 || !allowMissingAuthority) {
      throw invariantFailure("Auth coordinator authority is missing");
    }
    return null;
  }
  try {
    return validateCoordinatorSnapshot({ authority, credentials: credentialsValue, attempts: attemptsValue });
  } catch (error) {
    if (error instanceof SessionError && error.code === sessionErrorCodes.recoveryRequired) throw error;
    throw invariantFailure("Persisted auth coordinator snapshot is malformed");
  }
}

function assertNextSnapshot(current: CoordinatorSnapshot | null, next: CoordinatorSnapshot): CoordinatorSnapshot {
  const validated = validateCoordinatorSnapshot(next);
  if (current === null) {
    if (validated.authority.revision !== 0) {
      throw invariantFailure("Initial auth authority revision must be zero");
    }
  } else if (validated.authority.revision !== current.authority.revision + 1) {
    throw invariantFailure("Every coordinator mutation must advance the authority revision exactly once");
  }
  return validated;
}

function applySnapshot(transaction: IDBTransaction, snapshot: CoordinatorSnapshot): void {
  const authorityStore = transaction.objectStore(AUTHORITY_STORE);
  const credentialsStore = transaction.objectStore(CREDENTIALS_STORE);
  const attemptsStore = transaction.objectStore(ATTEMPTS_STORE);

  authorityStore.clear();
  credentialsStore.clear();
  attemptsStore.clear();
  const authorityRow: AuthorityRow = { key: AUTHORITY_KEY, authority: snapshot.authority };
  authorityStore.put(authorityRow);
  for (const credential of snapshot.credentials) credentialsStore.put(credential);
  for (const attempt of snapshot.attempts) attemptsStore.put(attempt);
}

async function executeCoordinatorTransaction<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  allowMissingAuthority: boolean,
  onBlocked: ((databaseName: string) => void) | undefined,
  planner: (snapshot: CoordinatorSnapshot | null) => CoordinatorDecision<T>,
  signal?: AbortSignal,
  resultFence: CoordinatorResultFence = "document-lifecycle",
): Promise<T> {
  if (signal?.aborted) {
    throw new SessionError(sessionErrorCodes.staleOperation, "Auth coordinator transaction was cancelled");
  }
  const lifecycleGeneration = coordinatorLifecycleGeneration;
  const enforceLifecycleFence = resultFence === "document-lifecycle";
  const database = await openCoordinatorDatabase(factory, onBlocked, enforceLifecycleFence);
  if (signal?.aborted || (enforceLifecycleFence && lifecycleGeneration !== coordinatorLifecycleGeneration)) {
    closeCoordinatorDatabase(database);
    throw new SessionError(sessionErrorCodes.staleOperation, "Auth coordinator transaction crossed a lifecycle fence");
  }
  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = openTransaction(database, mode);
    } catch (error) {
      closeCoordinatorDatabase(database);
      reject(
        toSessionError(error, sessionErrorCodes.persistenceUnavailable, "Auth coordinator transaction failed to start"),
      );
      return;
    }

    let failure: unknown;
    let plannedValue: T | undefined;
    let hasPlannedValue = false;
    let completedRequests = 0;

    const abortForSignal = (): void => {
      if (resultFence === "transaction" && hasPlannedValue) return;
      failure = new SessionError(sessionErrorCodes.staleOperation, "Auth coordinator transaction was cancelled");
      try {
        transaction.abort();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "InvalidStateError")) failure = error;
      }
    };
    signal?.addEventListener("abort", abortForSignal, { once: true });

    const authorityRequest = transaction.objectStore(AUTHORITY_STORE).get(AUTHORITY_KEY);
    const credentialsRequest = transaction.objectStore(CREDENTIALS_STORE).getAll();
    const attemptsRequest = transaction.objectStore(ATTEMPTS_STORE).getAll();

    const abortWith = (error: unknown): void => {
      failure = error;
      try {
        transaction.abort();
      } catch (abortError) {
        failure = failure ?? abortError;
      }
    };

    const planWhenReady = (): void => {
      completedRequests += 1;
      if (completedRequests !== 3 || failure !== undefined) return;
      try {
        const authorityValue: unknown = authorityRequest.result;
        const credentialsValue: unknown = credentialsRequest.result;
        const attemptsValue: unknown = attemptsRequest.result;
        const current = parseSnapshot(authorityValue, credentialsValue, attemptsValue, allowMissingAuthority);
        const decision = planner(current);
        if (decision.kind !== "unchanged" && decision.kind !== "commit") {
          throw invariantFailure("Auth coordinator planner returned an unsupported decision");
        }
        plannedValue = decision.value;
        hasPlannedValue = true;
        if (decision.kind === "commit") {
          if (mode !== "readwrite") throw invariantFailure("Readonly coordinator transaction cannot mutate state");
          applySnapshot(transaction, assertNextSnapshot(current, decision.snapshot));
        }
      } catch (error) {
        abortWith(error);
      }
    };

    const recordRequestFailure = (request: IDBRequest): void => {
      failure = request.error ?? invariantFailure("Auth coordinator request failed");
    };
    authorityRequest.onsuccess = planWhenReady;
    credentialsRequest.onsuccess = planWhenReady;
    attemptsRequest.onsuccess = planWhenReady;
    authorityRequest.onerror = () => recordRequestFailure(authorityRequest);
    credentialsRequest.onerror = () => recordRequestFailure(credentialsRequest);
    attemptsRequest.onerror = () => recordRequestFailure(attemptsRequest);

    transaction.oncomplete = () => {
      closeCoordinatorDatabase(database);
      signal?.removeEventListener("abort", abortForSignal);
      if (
        resultFence === "document-lifecycle" &&
        (signal?.aborted || lifecycleGeneration !== coordinatorLifecycleGeneration)
      ) {
        reject(new SessionError(sessionErrorCodes.staleOperation, "Auth coordinator result crossed a lifecycle fence"));
        return;
      }
      if (!hasPlannedValue) {
        reject(invariantFailure("Auth coordinator transaction completed without a decision"));
        return;
      }
      resolve(plannedValue as T);
    };
    transaction.onerror = () => {
      failure = failure ?? transaction.error ?? invariantFailure("Auth coordinator transaction failed");
    };
    transaction.onabort = () => {
      closeCoordinatorDatabase(database);
      signal?.removeEventListener("abort", abortForSignal);
      reject(
        toSessionError(
          failure ?? transaction.error,
          sessionErrorCodes.persistenceUnavailable,
          "Auth coordinator transaction did not commit",
        ),
      );
    };
  });
}

function keepCoordinatorSnapshot<T>(value: T): CoordinatorDecision<T> {
  return Object.freeze({ kind: "unchanged", value });
}

function replaceCoordinatorSnapshot<T>(snapshot: CoordinatorSnapshot, value: T): CoordinatorDecision<T> {
  return Object.freeze({ kind: "commit", snapshot, value });
}

export function closeCoordinatorConnections(): void {
  coordinatorLifecycleGeneration += 1;
  latestActiveMeRequests.clear();
  activeMe401RefreshOwners.clear();
  for (const database of coordinatorConnections) database.close();
  coordinatorConnections.clear();
}

function nextSnapshot(
  current: CoordinatorSnapshot,
  authority: AuthAuthority,
  credentials = current.credentials,
  attempts = current.attempts,
): CoordinatorSnapshot {
  return { authority, credentials, attempts };
}

function matchingCredential(snapshot: CoordinatorSnapshot, activation: ActivationCertificate): CredentialRecord | null {
  const credential = snapshot.credentials.find((item) => item.sessionEpoch === activation.sessionEpoch);
  if (!credential || !sameActivation(credential.activation, activation)) return null;
  return credential;
}

function sameTransitionPermit(left: AcquisitionTransitionPermit, right: AcquisitionTransitionPermit): boolean {
  return (
    left.kind === right.kind &&
    left.permitId === right.permitId &&
    left.attemptId === right.attemptId &&
    left.targetCredentialFingerprint === right.targetCredentialFingerprint &&
    left.expiresAt === right.expiresAt &&
    sameActivation(left.target, right.target)
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]))
  );
}

function sameAcquisitionAttempt(left: AcquisitionSessionAttempt, right: AcquisitionSessionAttempt): boolean {
  return (
    left.v === right.v &&
    left.kind === right.kind &&
    left.attemptId === right.attemptId &&
    left.serverAuthority === right.serverAuthority &&
    left.baselineGeneration === right.baselineGeneration &&
    left.sourceEpoch === right.sourceEpoch &&
    left.expiresAt === right.expiresAt &&
    sameJsonValue(left.payload, right.payload)
  );
}

type CandidateAdmissionCursor = Readonly<{
  generation: string;
  revision: number;
  mode: "none" | "active" | "transition";
  permit: AcquisitionTransitionPermit | null;
}>;

function admitCandidateAttempt(
  snapshot: CoordinatorSnapshot,
  attempt: AcquisitionSessionAttempt,
  candidateFingerprint: string,
  accountId: string,
  now: number,
): CandidateAdmissionCursor {
  const stored = snapshot.attempts.find((item) => item.attemptId === attempt.attemptId);
  if (!stored || stored.kind !== "acquisition" || !sameAcquisitionAttempt(stored, attempt) || stored.expiresAt <= now) {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Candidate attempt is missing, expired, or stale");
  }
  const authority = snapshot.authority;
  if (authority.mode === "none") {
    if (attempt.baselineGeneration !== authority.generation || attempt.sourceEpoch !== null) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Candidate attempt has another anonymous baseline");
    }
  } else if (authority.mode === "active") {
    if (attempt.baselineGeneration !== authority.generation || attempt.sourceEpoch !== authority.session.sessionEpoch) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Candidate attempt has another active baseline");
    }
  } else if (authority.mode === "transition") {
    if (
      authority.permit.attemptId !== attempt.attemptId ||
      authority.permit.targetCredentialFingerprint !== candidateFingerprint ||
      authority.permit.target.accountId !== accountId ||
      authority.permit.target.serverAuthority !== attempt.serverAuthority ||
      authority.permit.expiresAt <= now ||
      attempt.sourceEpoch !== (authority.source?.sessionEpoch ?? null)
    ) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Candidate does not own the pending transition");
    }
  } else {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Candidate dispatch is blocked by retirement");
  }
  return Object.freeze({
    generation: authority.generation,
    revision: authority.revision,
    mode: authority.mode,
    permit: authority.mode === "transition" ? authority.permit : null,
  });
}

function sameCandidateAdmissionCursor(left: CandidateAdmissionCursor, right: CandidateAdmissionCursor): boolean {
  if (left.generation !== right.generation || left.mode !== right.mode) return false;
  if (left.mode === "transition" && right.mode === "transition") {
    return left.permit !== null && right.permit !== null && sameTransitionPermit(left.permit, right.permit);
  }
  return left.revision === right.revision;
}

function activeProjection(snapshot: CoordinatorSnapshot, activation?: ActivationCertificate): ActiveSessionProjection {
  const authority = snapshot.authority;
  if (authority.mode !== "active" || (activation && !sameActivation(authority.session, activation))) {
    throw new SessionError(sessionErrorCodes.admissionDenied, "Captured activation is no longer authoritative");
  }
  const credential = matchingCredential(snapshot, authority.session);
  if (!credential) throw invariantFailure("Active activation does not own its exact credential");
  return Object.freeze({ authority, credential: credentialCursor(credential) });
}

function sameCredentialRecord(left: CredentialRecord, right: CredentialRecord): boolean {
  return (
    sameActivation(left.activation, right.activation) &&
    left.sessionEpoch === right.sessionEpoch &&
    left.credentialRevision === right.credentialRevision &&
    left.credentialFingerprint === right.credentialFingerprint &&
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken
  );
}

async function verifyCredentialBytes(record: CredentialRecord): Promise<void> {
  let snapshot: ReturnType<typeof createCandidateTokenSnapshot>;
  try {
    snapshot = createCandidateTokenSnapshot({
      accessToken: record.accessToken,
      refreshToken: record.refreshToken,
    });
  } catch {
    throw invariantFailure("Persisted credential pair is structurally invalid");
  }
  if (snapshot.accountIdCandidate !== record.activation.accountId) {
    throw invariantFailure("Persisted credential subject does not match its activation");
  }
  const fingerprinted = await fingerprintCandidateTokenSnapshot(snapshot, record.activation.serverAuthority);
  if (fingerprinted.credentialFingerprint !== record.credentialFingerprint) {
    throw invariantFailure("Persisted credential bytes do not match their fingerprint");
  }
}

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

export class AuthSessionCoordinator {
  private readonly factory: IDBFactory;
  private readonly onBlocked: ((databaseName: string) => void) | undefined;
  private readonly legacyPersistence: LegacyScrubOptions | undefined;

  public constructor(options: CoordinatorOptions = {}) {
    const indexedDBOption = options.indexedDB;
    const onBlocked = options.onBlocked;
    const explicitLegacyPersistence = options.legacyPersistence;
    this.factory = getIndexedDbFactory(indexedDBOption);
    this.onBlocked = onBlocked;
    const legacyPersistence =
      explicitLegacyPersistence ??
      (typeof localStorage === "undefined" || typeof sessionStorage === "undefined"
        ? undefined
        : { localStorage, sessionStorage, indexedDB: this.factory });
    if (legacyPersistence !== undefined) {
      const localStorage = legacyPersistence.localStorage;
      const sessionStorage = legacyPersistence.sessionStorage;
      const legacyIndexedDB = legacyPersistence.indexedDB;
      const onDatabaseBlocked = legacyPersistence.onDatabaseBlocked;
      this.legacyPersistence = Object.freeze({
        localStorage,
        sessionStorage,
        indexedDB: legacyIndexedDB ?? this.factory,
        ...(onDatabaseBlocked === undefined ? {} : { onDatabaseBlocked }),
      });
    }
  }

  private async scrubConfiguredLegacyPersistence() {
    const persistence = this.legacyPersistence;
    if (!persistence) {
      throw new SessionError(
        sessionErrorCodes.persistenceUnavailable,
        "Legacy persistence targets are required for anonymous authority changes",
      );
    }
    return scrubLegacyPersistence(persistence);
  }

  private async captureVerifiedCredential(
    activation?: ActivationCertificate,
    signal?: AbortSignal,
  ): Promise<CredentialRecord> {
    const captured = await executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<CredentialRecord> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        const projection = activeProjection(snapshot, activation);
        const record = matchingCredential(snapshot, projection.authority.session);
        if (!record) throw invariantFailure("Active activation does not own its exact credential");
        return keepCoordinatorSnapshot(record);
      },
      signal,
    );
    await verifyCredentialBytes(captured);
    if (signal?.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Credential verification crossed a lifecycle fence");
    }
    return captured;
  }

  private async finishCredentialAdmission(
    captured: CredentialRecord,
    activation?: ActivationCertificate,
    signal?: AbortSignal,
  ): Promise<ActiveSessionProjection> {
    return executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<ActiveSessionProjection> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        const projection = activeProjection(snapshot, activation ?? captured.activation);
        const current = matchingCredential(snapshot, projection.authority.session);
        if (!current || !sameCredentialRecord(current, captured)) {
          throw new SessionError(sessionErrorCodes.admissionDenied, "Credential changed during admission");
        }
        return keepCoordinatorSnapshot(projection);
      },
      signal,
    );
  }

  private async assertActiveHttpCurrent(
    sourceView: ViewLease,
    runtime: CapturedContentStoreRuntime,
    expectedCredential: CredentialCursor,
    capturedCredential: CredentialRecord,
    signal: AbortSignal,
    lifecycleGeneration: number,
  ): Promise<ActiveSessionProjection> {
    if (
      signal.aborted ||
      lifecycleGeneration !== coordinatorLifecycleGeneration ||
      !sameCapturedContentRuntime(runtime, captureContentStoreRuntime(sourceView))
    ) {
      throw activeHttpStale("Authenticated request view is no longer current");
    }
    const projection = await runtime.withShared(async () => {
      if (signal.aborted || lifecycleGeneration !== coordinatorLifecycleGeneration) {
        throw activeHttpStale("Authenticated request crossed a lifecycle fence");
      }
      const current = await this.captureVerifiedCredential(sourceView.activation, signal);
      if (
        !sameCredentialRecord(current, capturedCredential) ||
        !sameCredentialCursor(credentialCursor(current), expectedCredential)
      ) {
        throw new SessionError(
          sessionErrorCodes.admissionDenied,
          "Authenticated request credential is no longer current",
        );
      }
      return this.finishCredentialAdmission(current, sourceView.activation, signal);
    });
    if (
      signal.aborted ||
      lifecycleGeneration !== coordinatorLifecycleGeneration ||
      !sameCapturedContentRuntime(runtime, captureContentStoreRuntime(sourceView)) ||
      !sameCredentialCursor(projection.credential, expectedCredential)
    ) {
      throw activeHttpStale("Authenticated request became stale before delivery");
    }
    return projection;
  }

  /**
   * Coordinator-owned authenticated HTTP transport. Credential bytes and the
   * raw Response never cross this boundary; every delivered byte is fenced by
   * the exact installed organization view and credential cursor.
   */
  public async requestActiveHttp(inputValue: ActiveHttpRequest): Promise<ActiveHttpResponse> {
    if (!isRecord(inputValue)) throw activeHttpInvalid("Authenticated request is malformed");

    // Snapshot every caller-controlled field before the first await. Runtime
    // `Readonly` types do not prevent mutable/accessor-backed request objects.
    const viewValue = inputValue.view;
    const credentialValue = inputValue.credential;
    const scopeValue = inputValue.scope;
    const pathValue = inputValue.path;
    const methodValue = inputValue.method;
    const headersValue = inputValue.headers;
    const bodyValue = inputValue.body;
    const responseTypeValue = inputValue.responseType;
    const maxResponseBytesValue = inputValue.maxResponseBytes;
    const requestSignalValue = inputValue.signal;

    const sourceView = validateViewLease(viewValue);
    const expectedCredential = validateCredentialCursor(credentialValue);
    const method = requireActiveHttpMethod(methodValue);
    const path = requireActiveHttpPath(pathValue, scopeValue, sourceView, method);
    const customHeaders = snapshotActiveHttpHeaders(headersValue);
    const capturedBody = snapshotActiveHttpBody(bodyValue, method);
    const responseType = requireActiveHttpResponseType(responseTypeValue);
    const maxResponseBytes = requireActiveHttpResponseLimit(maxResponseBytesValue);
    const runtime = captureContentStoreRuntime(sourceView);
    if (!runtime) throw activeHttpStale("Authenticated request view is not installed");
    const combinedSignals = combineActiveHttpSignals(
      runtime.lease.signal,
      requestSignalValue as AbortSignal | undefined,
    );
    const signal = combinedSignals.signal;
    const lifecycleGeneration = coordinatorLifecycleGeneration;

    try {
      if (signal.aborted) throw activeHttpStale("Authenticated request was cancelled");
      const capturedCredential = await this.captureVerifiedCredential(sourceView.activation, signal);
      if (!sameCredentialCursor(credentialCursor(capturedCredential), expectedCredential)) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Authenticated request credential is stale");
      }
      await this.assertActiveHttpCurrent(
        sourceView,
        runtime,
        expectedCredential,
        capturedCredential,
        signal,
        lifecycleGeneration,
      );

      const dispatch = await executeCoordinatorTransaction(
        this.factory,
        "readonly",
        false,
        this.onBlocked,
        (snapshot): CoordinatorDecision<Readonly<{ request: Promise<Response> }>> => {
          if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
          if (
            signal.aborted ||
            lifecycleGeneration !== coordinatorLifecycleGeneration ||
            !sameCapturedContentRuntime(runtime, captureContentStoreRuntime(sourceView))
          ) {
            throw activeHttpStale("Authenticated request became stale before dispatch");
          }
          const projection = activeProjection(snapshot, sourceView.activation);
          const current = matchingCredential(snapshot, projection.authority.session);
          if (
            !current ||
            !sameCredentialRecord(current, capturedCredential) ||
            !sameCredentialCursor(projection.credential, expectedCredential)
          ) {
            throw new SessionError(
              sessionErrorCodes.admissionDenied,
              "Authenticated request credential changed before dispatch",
            );
          }
          const headers: Record<string, string> = {
            ...customHeaders,
            Accept: responseType === "json" ? "application/json" : "*/*",
            Authorization: `Bearer ${current.accessToken}`,
            ...expectedAuthorityHeaders(sourceView.activation.serverAuthority),
          };
          if (capturedBody.contentType !== null) headers["Content-Type"] = capturedBody.contentType;
          let request: Promise<Response>;
          try {
            request = fetch(`${ACTIVE_HTTP_BASE_URL}${path}`, {
              method,
              cache: "no-store",
              credentials: "omit",
              referrerPolicy: "no-referrer",
              redirect: "error",
              headers,
              body: capturedBody.body,
              signal,
            });
          } catch {
            request = Promise.reject(new Error("authenticated request dispatch failed"));
          }
          return keepCoordinatorSnapshot(Object.freeze({ request }));
        },
        signal,
      );

      let response: Response;
      try {
        response = await dispatch.request;
      } catch {
        await this.assertActiveHttpCurrent(
          sourceView,
          runtime,
          expectedCredential,
          capturedCredential,
          signal,
          lifecycleGeneration,
        );
        throw new SessionError(sessionErrorCodes.admissionDenied, "Authenticated request is unavailable");
      }

      const status = response.status;
      const ok = response.ok;
      const isSessionBoundaryResponse = status === 401 || status === 421 || status === 503;
      let responseHeaders: Readonly<Record<string, string>>;
      try {
        responseHeaders = snapshotResponseHeaders(response.headers, isSessionBoundaryResponse);
      } catch {
        await this.assertActiveHttpCurrent(
          sourceView,
          runtime,
          expectedCredential,
          capturedCredential,
          signal,
          lifecycleGeneration,
        );
        throw new SessionError(sessionErrorCodes.admissionDenied, "Authenticated response headers are malformed");
      }
      let body: JsonValue | null | string | Uint8Array;
      let consumeFailed = false;
      try {
        if (responseType === "bytes") {
          body = await readBoundedResponseBytes(response, maxResponseBytes);
        } else {
          const text = await readBoundedResponseText(response, maxResponseBytes);
          if (responseType === "text") {
            body = text;
          } else if (text.length === 0) {
            body = null;
          } else {
            body = freezeParsedJson(JSON.parse(text) as JsonValue);
          }
        }
      } catch {
        consumeFailed = true;
        body = responseType === "bytes" ? new Uint8Array() : responseType === "text" ? "" : null;
      }

      // A 401/421/503 is account+server authority evidence, not organization
      // content. Once the owned request has received it, an organization
      // replacement may suppress business delivery but must not erase the
      // evidence before BrowserSessionRuntime can refresh, retire, or
      // reconcile the live server. A newer credential or session still wins
      // in the durable coordinator.
      const projection = isSessionBoundaryResponse
        ? await this.finishCredentialAdmission(capturedCredential, sourceView.activation)
        : await this.assertActiveHttpCurrent(
            sourceView,
            runtime,
            expectedCredential,
            capturedCredential,
            signal,
            lifecycleGeneration,
          );
      if (
        !isSessionBoundaryResponse &&
        (signal.aborted ||
          lifecycleGeneration !== coordinatorLifecycleGeneration ||
          !sameCapturedContentRuntime(runtime, captureContentStoreRuntime(sourceView)) ||
          !sameCredentialCursor(projection.credential, expectedCredential))
      ) {
        throw activeHttpStale("Authenticated response crossed its final delivery fence");
      }
      if (consumeFailed && status !== 401 && status !== 421 && status !== 503) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Authenticated response is malformed");
      }

      let result: ActiveHttpResponse;
      if (responseType === "json") {
        result = Object.freeze({ status, ok, headers: responseHeaders, responseType, body: body as JsonValue | null });
      } else if (responseType === "text") {
        result = Object.freeze({ status, ok, headers: responseHeaders, responseType, body: body as string });
      } else {
        result = Object.freeze({ status, ok, headers: responseHeaders, responseType, body: body as Uint8Array });
      }
      activeHttpResponses.set(result, {
        activation: sourceView.activation,
        credential: expectedCredential,
        capturedCredential,
        authorityRevision: projection.authority.revision,
        status,
        state: "available",
      });
      if (isSessionBoundaryResponse) {
        try {
          const finalProjection = await this.finishCredentialAdmission(capturedCredential, sourceView.activation);
          if (!sameCredentialCursor(finalProjection.credential, expectedCredential)) {
            throw activeHttpStale("Authenticated transport evidence belongs to a stale credential");
          }
        } catch (error) {
          activeHttpResponses.delete(result);
          throw error;
        }
      } else if (
        signal.aborted ||
        lifecycleGeneration !== coordinatorLifecycleGeneration ||
        !sameCapturedContentRuntime(runtime, captureContentStoreRuntime(sourceView)) ||
        !sameCredentialCursor(projection.credential, expectedCredential)
      ) {
        activeHttpResponses.delete(result);
        throw activeHttpStale("Authenticated response became stale before return");
      }
      return result;
    } finally {
      combinedSignals.dispose();
    }
  }

  /**
   * Consumes only the original, coordinator-minted terminal 401 result. Once
   * that exact request crossed its durable activation/credential response
   * gates, organization or lifecycle teardown may suppress local delivery but
   * cannot outrank the durable retirement transaction below.
   */
  public async retireActiveHttpAfterTerminal401(
    responseValue: unknown,
    owned401GenerationValue: string,
  ): Promise<RetirementResult> {
    if (typeof responseValue !== "object" || responseValue === null) {
      throw activeHttpInvalid("Authenticated response retirement capability is malformed");
    }
    const evidence = activeHttpResponses.get(responseValue as ActiveHttpResponse);
    if (!evidence || evidence.status !== 401 || evidence.state !== "available") {
      throw new SessionError(sessionErrorCodes.staleOperation, "Authenticated response retirement capability is stale");
    }
    const owned401Generation = requireGeneration(owned401GenerationValue);
    evidence.state = "claimed";
    try {
      const result = await this.commit(
        (snapshot): CoordinatorDecision<RetirementResult> => {
          const authority = snapshot.authority;
          if (
            authority.mode === "retiring" &&
            authority.cause === "owned_401" &&
            sameActivation(authority.source, evidence.activation)
          ) {
            return keepCoordinatorSnapshot("already_retiring");
          }
          if (
            authority.mode !== "active" ||
            authority.revision !== evidence.authorityRevision ||
            !sameActivation(authority.session, evidence.activation)
          ) {
            return keepCoordinatorSnapshot("superseded");
          }
          const current = matchingCredential(snapshot, evidence.activation);
          if (
            !current ||
            !sameCredentialCursor(credentialCursor(current), evidence.credential) ||
            !sameCredentialRecord(current, evidence.capturedCredential)
          ) {
            return keepCoordinatorSnapshot("superseded");
          }
          if (
            owned401Generation === authority.generation ||
            owned401Generation === evidence.activation.authGeneration
          ) {
            throw activeHttpInvalid("Owned 401 retirement must rotate the auth generation");
          }
          const retiring: AuthAuthority = {
            v: 6,
            mode: "retiring",
            generation: owned401Generation,
            revision: authority.revision + 1,
            source: evidence.activation,
            cause: "owned_401",
            forbiddenGenerations: Object.freeze([]),
            phase: "revoked",
          };
          return replaceCoordinatorSnapshot(nextSnapshot(snapshot, retiring, [], []), "retired");
        },
        undefined,
        "transaction",
      );
      evidence.state = "consumed";
      return result;
    } catch (error) {
      if (evidence.state === "claimed") evidence.state = "available";
      throw error;
    }
  }

  public async bootstrapAnonymous(generation: string): Promise<AuthAuthority> {
    const initialGeneration = requireGeneration(generation);
    return executeCoordinatorTransaction(
      this.factory,
      "readwrite",
      true,
      this.onBlocked,
      (snapshot): CoordinatorDecision<AuthAuthority> => {
        if (snapshot !== null) return keepCoordinatorSnapshot(snapshot.authority);
        const authority: AuthAuthority = { v: 6, mode: "none", generation: initialGeneration, revision: 0 };
        return replaceCoordinatorSnapshot({ authority, credentials: [], attempts: [] }, authority);
      },
    );
  }

  public async readAuthority(): Promise<AuthAuthority> {
    return executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<AuthAuthority> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        return keepCoordinatorSnapshot(snapshot.authority);
      },
    );
  }

  public async readActiveSession(): Promise<ActiveSessionProjection> {
    const captured = await this.captureVerifiedCredential();
    return this.finishCredentialAdmission(captured);
  }

  /**
   * Runs a synchronous planner over one fresh, overlapping authority/credentials/attempts transaction.
   * The returned promise resolves only after the transaction's `complete` event.
   */
  private async commit<T>(
    planner: CoordinatorPlanner<T>,
    signal?: AbortSignal,
    resultFence: CoordinatorResultFence = "document-lifecycle",
  ): Promise<T> {
    return executeCoordinatorTransaction(
      this.factory,
      "readwrite",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<T> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        return planner(snapshot);
      },
      signal,
      resultFence,
    );
  }

  public async admitActivation(activationValue: unknown): Promise<ActiveSessionProjection> {
    const activation = validateActivationCertificate(activationValue);
    const captured = await this.captureVerifiedCredential(activation);
    return this.finishCredentialAdmission(captured, activation);
  }

  public async admitAccountLease(leaseValue: unknown): Promise<ActiveSessionProjection> {
    const lease = validateAccountLease(leaseValue);
    const activation = lease.activation;
    const signal = lease.signal;
    if (signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Captured account lease has been invalidated");
    }
    const captured = await this.captureVerifiedCredential(activation, signal);
    const projection = await this.finishCredentialAdmission(captured, activation, signal);
    if (signal.aborted) {
      throw new SessionError(
        sessionErrorCodes.staleOperation,
        "Captured account lease was invalidated during admission",
      );
    }
    return projection;
  }

  /**
   * Coordinator-owned active `/me` request. The returned proof is bound to
   * one account runtime lifecycle and only the newest request for that
   * runtime may drive organization reconciliation.
   */
  public async requestActiveMe(leaseValue: unknown, retryClaimValue?: unknown): Promise<VerifiedActiveMeResult> {
    const sourceLease = validateAccountLease(leaseValue);
    const runtime = captureAccountRuntimeFence(sourceLease);
    if (!runtime) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Account identity request runtime is stale");
    }
    const lease = runtime.lease;
    const signal = lease.signal;
    const lifecycleGeneration = coordinatorLifecycleGeneration;
    const requestKey = activeMeRequestKey(sourceLease);
    if (activeMe401RefreshOwners.has(requestKey)) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Account identity refresh already owns this runtime");
    }
    const retryClaim =
      retryClaimValue === undefined
        ? null
        : consumeActiveMeRetryClaim(retryClaimValue, sourceLease, runtime, lifecycleGeneration, requestKey);
    const requestSequence = nextActiveMeSequence(requestKey);
    if (signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Account identity request lifecycle is stale");
    }
    const captured = await this.captureVerifiedCredential(lease.activation, signal);
    runtime.assertCurrent();
    assertActiveMeSequence(requestKey, requestSequence);
    if (retryClaim && !sameCredentialRecord(captured, retryClaim.refreshedCredential)) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Account identity retry credential is stale");
    }

    const dispatch = await executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<Readonly<{ request: Promise<Response> }>> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        if (signal.aborted || lifecycleGeneration !== coordinatorLifecycleGeneration) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Account identity dispatch lifecycle is stale");
        }
        runtime.assertCurrent();
        assertActiveMeSequence(requestKey, requestSequence);
        const projection = activeProjection(snapshot, lease.activation);
        const current = matchingCredential(snapshot, projection.authority.session);
        if (
          !current ||
          !sameCredentialRecord(current, captured) ||
          (retryClaim !== null &&
            (projection.authority.revision !== retryClaim.authorityRevision ||
              !sameCredentialCursor(projection.credential, retryClaim.expectedCredential)))
        ) {
          throw new SessionError(
            sessionErrorCodes.admissionDenied,
            "Credential changed before account identity dispatch",
          );
        }
        let request: Promise<Response>;
        try {
          request = fetch("/api/v1/me", {
            method: "GET",
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            redirect: "error",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${current.accessToken}`,
              ...expectedAuthorityHeaders(lease.activation.serverAuthority),
            },
            signal,
          });
        } catch (error) {
          request = Promise.reject(error);
        }
        return keepCoordinatorSnapshot(Object.freeze({ request }));
      },
      signal,
    );

    const assertResponseCurrent = async (): Promise<void> => {
      if (signal.aborted || lifecycleGeneration !== coordinatorLifecycleGeneration) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Account identity response crossed a lifecycle fence");
      }
      runtime.assertCurrent();
      assertActiveMeSequence(requestKey, requestSequence);
      const projection = await this.admitAccountLease(lease);
      if (
        retryClaim !== null &&
        (projection.authority.revision !== retryClaim.authorityRevision ||
          !sameCredentialCursor(projection.credential, retryClaim.expectedCredential))
      ) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Account identity retry authority is stale");
      }
      if (signal.aborted || lifecycleGeneration !== coordinatorLifecycleGeneration) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Account identity response crossed a lifecycle fence");
      }
      runtime.assertCurrent();
      assertActiveMeSequence(requestKey, requestSequence);
    };

    const assertRejectedCredentialCurrent = async (): Promise<void> => {
      if (signal.aborted || lifecycleGeneration !== coordinatorLifecycleGeneration) {
        throw new SessionError(
          sessionErrorCodes.staleOperation,
          "Account identity rejection crossed a lifecycle fence",
        );
      }
      runtime.assertCurrent();
      assertActiveMeSequence(requestKey, requestSequence);
      const current = await this.captureVerifiedCredential(lease.activation, signal);
      if (signal.aborted || lifecycleGeneration !== coordinatorLifecycleGeneration) {
        throw new SessionError(
          sessionErrorCodes.staleOperation,
          "Account identity rejection crossed a lifecycle fence",
        );
      }
      runtime.assertCurrent();
      assertActiveMeSequence(requestKey, requestSequence);
      if (!sameCredentialRecord(current, captured)) {
        throw new SessionError(
          sessionErrorCodes.admissionDenied,
          "Credential changed before account identity rejection delivery",
        );
      }
      const projection = await this.finishCredentialAdmission(current, lease.activation, signal);
      if (
        retryClaim !== null &&
        (projection.authority.revision !== retryClaim.authorityRevision ||
          !sameCredentialCursor(projection.credential, retryClaim.expectedCredential))
      ) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Account identity retry authority is stale");
      }
      if (signal.aborted || lifecycleGeneration !== coordinatorLifecycleGeneration) {
        throw new SessionError(
          sessionErrorCodes.staleOperation,
          "Account identity rejection crossed a lifecycle fence",
        );
      }
      runtime.assertCurrent();
      assertActiveMeSequence(requestKey, requestSequence);
    };

    let response: Response;
    try {
      response = await dispatch.request;
    } catch {
      await assertResponseCurrent();
      throw new SessionError(sessionErrorCodes.admissionDenied, "Account identity request is unavailable");
    }
    await assertResponseCurrent();
    if (!response.ok) {
      if (response.status === 401) await assertRejectedCredentialCurrent();
      const error = new SessionError(
        sessionErrorCodes.admissionDenied,
        `Account identity request failed (${response.status})`,
        Object.freeze({ kind: "active_me_http_status", status: response.status }),
      );
      if (response.status === 401) {
        const evidence: ActiveMe401Evidence =
          retryClaim === null
            ? Object.freeze({
                purpose: "refresh",
                runtime,
                signal,
                capturedCredential: captured,
                expectedCredential: credentialCursor(captured),
                lifecycleGeneration,
                requestKey,
                requestSequence,
              })
            : Object.freeze({
                purpose: "retire",
                activation: lease.activation,
                capturedCredential: captured,
                expectedCredential: credentialCursor(captured),
                authorityRevision: retryClaim.authorityRevision,
                retirementGeneration: retryClaim.retirementGeneration,
              });
        activeMe401Rejections.set(error, {
          evidence,
          state: "available",
        });
      }
      throw error;
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Account identity response is malformed");
    }

    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(await readBoundedResponseText(response, MAX_ACTIVE_ME_RESPONSE_BYTES));
    } catch {
      await assertResponseCurrent();
      throw new SessionError(sessionErrorCodes.admissionDenied, "Account identity response is malformed");
    }
    await assertResponseCurrent();
    const parsed = parseActiveMeResponse(parsedValue, lease.activation.accountId);
    const proof = Object.freeze({}) as VerifiedActiveMeProof;
    verifiedActiveMeProofs.set(proof, {
      evidence: Object.freeze({
        runtime,
        membershipIds: parsed.membershipIds,
        defaultOrganizationId: parsed.defaultOrganizationId,
        lifecycleGeneration,
        requestKey,
        requestSequence,
      }),
      state: "available",
    });
    return Object.freeze({ payload: parsed.payload, proof });
  }

  public async admitView(viewValue: unknown): Promise<ActiveSessionProjection> {
    const view = validateViewLease(viewValue);
    if (view.signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Captured view has been invalidated");
    }
    const captured = await this.captureVerifiedCredential(view.activation, view.signal);
    const projection = await this.finishCredentialAdmission(captured, view.activation, view.signal);
    if (view.signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Captured view was invalidated during admission");
    }
    return projection;
  }

  /**
   * Performs candidate `/me` behind two fresh coordinator admissions. The API
   * client owns the physical fetch; callers can neither substitute a response
   * nor bypass the post-response authority transaction.
   */
  public async requestCandidateMe(input: CandidateMeRequest): Promise<VerifiedCandidateMeResult> {
    const lifecycleGeneration = coordinatorLifecycleGeneration;
    const signal = input.signal;
    const attemptValue = input.attempt;
    const serverAuthority = input.serverAuthority;
    const accessToken = input.candidate.accessToken;
    const refreshToken = input.candidate.refreshToken;
    const suppliedFingerprint = input.candidate.credentialFingerprint;
    if (signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Candidate request was cancelled");
    }
    const validatedAttempt = validateSessionAttempt(attemptValue);
    if (validatedAttempt.kind !== "acquisition" || validatedAttempt.serverAuthority !== serverAuthority) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Candidate attempt has another capability domain");
    }
    const candidate = createCandidateTokenSnapshot({
      accessToken,
      refreshToken,
    });
    const fingerprinted = await fingerprintCandidateTokenSnapshot(candidate, validatedAttempt.serverAuthority);
    if (suppliedFingerprint !== undefined && suppliedFingerprint !== fingerprinted.credentialFingerprint) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Candidate fingerprint does not match its bytes");
    }
    const dispatchTime = Date.now();
    if (
      fingerprinted.accessExpiresAt <= dispatchTime ||
      fingerprinted.refreshExpiresAt <= dispatchTime ||
      signal.aborted ||
      lifecycleGeneration !== coordinatorLifecycleGeneration
    ) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Candidate request is expired or cancelled");
    }

    const before = await executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<CandidateAdmissionCursor> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        if (lifecycleGeneration !== coordinatorLifecycleGeneration) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Candidate dispatch crossed a lifecycle fence");
        }
        return keepCoordinatorSnapshot(
          admitCandidateAttempt(
            snapshot,
            validatedAttempt,
            fingerprinted.credentialFingerprint,
            fingerprinted.accountIdCandidate,
            dispatchTime,
          ),
        );
      },
      signal,
    );

    let result: CandidateMeResult | undefined;
    let requestFailure: unknown;
    try {
      result = await fetchCandidateMe({
        candidate: fingerprinted,
        attempt: validatedAttempt,
        serverAuthority: validatedAttempt.serverAuthority,
        signal,
      });
    } catch (error) {
      requestFailure = error;
    }
    if (signal.aborted || lifecycleGeneration !== coordinatorLifecycleGeneration) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Candidate response crossed a lifecycle fence");
    }

    const completionTime = Date.now();
    if (fingerprinted.accessExpiresAt <= completionTime || fingerprinted.refreshExpiresAt <= completionTime) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Candidate expired before verification completed");
    }
    const after = await executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<CandidateAdmissionCursor> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        if (lifecycleGeneration !== coordinatorLifecycleGeneration) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Candidate response crossed a lifecycle fence");
        }
        return keepCoordinatorSnapshot(
          admitCandidateAttempt(
            snapshot,
            validatedAttempt,
            fingerprinted.credentialFingerprint,
            fingerprinted.accountIdCandidate,
            completionTime,
          ),
        );
      },
      signal,
    );
    if (
      !sameCandidateAdmissionCursor(before, after) ||
      signal.aborted ||
      lifecycleGeneration !== coordinatorLifecycleGeneration
    ) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Candidate authority changed during verification");
    }
    if (requestFailure !== undefined) throw requestFailure;
    if (!result) throw invariantFailure("Candidate request settled without a result");

    const proof = createVerifiedCandidateProof(
      Object.freeze({
        candidate: result.candidate,
        serverAuthority: result.serverAuthority,
        accountId: result.accountId,
        attempt: result.attempt,
        signal,
        lifecycleGeneration,
      }),
    );
    return Object.freeze({ accountId: result.accountId, payload: result.payload, proof });
  }

  private async commitAccountRefreshResponse(
    proofValue: unknown,
  ): Promise<Readonly<{ cursor: CredentialCursor; authorityRevision: number }>> {
    const claim = claimAccountRefreshResponseProof(proofValue);
    const { activation, expectedCredential, capturedCredential, replacement, runtime } = claim.state;
    const signal = runtime.lease.signal;
    let committed = false;
    try {
      const result = await this.commit(
        (snapshot): CoordinatorDecision<Readonly<{ cursor: CredentialCursor; authorityRevision: number }>> => {
          assertAccountRefreshStateCurrent(claim.state);
          const projection = activeProjection(snapshot, activation);
          if (!sameCredentialCursor(projection.credential, expectedCredential)) {
            throw new SessionError(
              sessionErrorCodes.admissionDenied,
              "Credential changed before account refresh commit",
            );
          }
          const current = matchingCredential(snapshot, activation);
          if (!current || !sameCredentialRecord(current, capturedCredential)) {
            throw new SessionError(
              sessionErrorCodes.admissionDenied,
              "Credential changed before account refresh commit",
            );
          }
          const nextAuthority: ActiveAuthority = {
            ...projection.authority,
            revision: projection.authority.revision + 1,
          };
          const nextCredential = credentialCursor(replacement);
          return replaceCoordinatorSnapshot(
            nextSnapshot(snapshot, nextAuthority, [replacement]),
            Object.freeze({ cursor: nextCredential, authorityRevision: nextAuthority.revision }),
          );
        },
        signal,
      );
      // A claimed active-/me rejection serializes newer identity requests for
      // this request key until transaction completion, so its owner fence is
      // still meaningful at the delivery boundary.
      assertAccountRefreshStateCurrent(claim.state);
      committed = true;
      return result;
    } finally {
      claim.settle(committed);
    }
  }

  private async retireAccountCredentialAfter401(
    runtime: CapturedAccountRuntimeFence,
    capturedCredential: CredentialRecord,
    expectedCredential: CredentialCursor,
    nextGeneration: string,
    assertOwnerCurrent?: () => void,
  ): Promise<RetirementResult> {
    const { activation } = runtime.lease;
    assertOwnerCurrent?.();
    return this.commit((snapshot): CoordinatorDecision<RetirementResult> => {
      assertOwnerCurrent?.();
      if (runtime.lease.signal.aborted) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Owned 401 retirement crossed a lifecycle fence");
      }
      runtime.assertCurrent();
      const authority = snapshot.authority;
      if (authority.mode !== "active" || !sameActivation(authority.session, activation)) {
        return keepCoordinatorSnapshot("superseded");
      }
      const current = matchingCredential(snapshot, activation);
      if (
        !current ||
        !sameCredentialCursor(credentialCursor(current), expectedCredential) ||
        !sameCredentialRecord(current, capturedCredential)
      ) {
        return keepCoordinatorSnapshot("superseded");
      }
      if (nextGeneration === authority.generation || nextGeneration === activation.authGeneration) {
        throw new SessionError(sessionErrorCodes.invalidState, "Owned 401 retirement must rotate the auth generation");
      }
      const retiring: AuthAuthority = {
        v: 6,
        mode: "retiring",
        generation: nextGeneration,
        revision: authority.revision + 1,
        source: activation,
        cause: "owned_401",
        forbiddenGenerations: Object.freeze([]),
        phase: "revoked",
      };
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, retiring, [], []), "retired");
    }, runtime.lease.signal);
  }

  /**
   * Cold-boot refresh owns the complete token-free request/response/CAS path.
   * It is admitted only for the exact installed account runtime; callers can
   * provide neither a response nor replacement credential bytes.
   */
  public async refreshAccountCredentialAfterActiveMe401(
    leaseValue: unknown,
    rejectionValue: unknown,
    owned401GenerationValue: string,
  ): Promise<CredentialCursor> {
    const sourceLease = validateAccountLease(leaseValue);
    const owned401Generation = requireGeneration(owned401GenerationValue);
    if (!(rejectionValue instanceof SessionError)) {
      throw new SessionError(sessionErrorCodes.invalidState, "Account identity rejection proof is unavailable");
    }
    const rejection = activeMe401Rejections.get(rejectionValue);
    const evidence = rejection?.evidence;
    if (
      !rejection ||
      rejection.state !== "available" ||
      !evidence ||
      evidence.purpose !== "refresh" ||
      evidence.lifecycleGeneration !== coordinatorLifecycleGeneration ||
      !sameAccountLease(evidence.runtime.sourceLease, sourceLease) ||
      evidence.signal !== evidence.runtime.lease.signal
    ) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Account identity rejection proof is stale");
    }
    if (owned401Generation === sourceLease.activation.authGeneration) {
      throw new SessionError(sessionErrorCodes.invalidState, "Owned 401 retirement must rotate the auth generation");
    }
    if (sourceLease.signal.aborted || evidence.signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Account identity rejection crossed a lifecycle fence");
    }
    evidence.runtime.assertCurrent();
    assertActiveMeSequence(evidence.requestKey, evidence.requestSequence);
    if (activeMe401RefreshOwners.has(evidence.requestKey)) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Account identity rejection proof is already claimed");
    }
    rejection.state = "claimed";
    activeMe401RefreshOwners.set(evidence.requestKey, rejection);
    const assertOwnerCurrent = (): void => {
      if (
        rejection.state !== "claimed" ||
        activeMe401RefreshOwners.get(evidence.requestKey) !== rejection ||
        evidence.signal.aborted ||
        evidence.lifecycleGeneration !== coordinatorLifecycleGeneration
      ) {
        throw new SessionError(
          sessionErrorCodes.staleOperation,
          "Account identity rejection crossed a lifecycle fence",
        );
      }
      evidence.runtime.assertCurrent();
      assertActiveMeSequence(evidence.requestKey, evidence.requestSequence);
    };
    try {
      const committed = await this.refreshAccountCredentialOwned(
        evidence.runtime,
        evidence.expectedCredential,
        owned401Generation,
        evidence.capturedCredential,
        assertOwnerCurrent,
      );
      assertOwnerCurrent();
      activeMeRetryClaims.set(rejectionValue, {
        evidence: Object.freeze({
          runtime: evidence.runtime,
          signal: evidence.signal,
          refreshedCredential: committed.replacement,
          expectedCredential: committed.cursor,
          authorityRevision: committed.authorityRevision,
          lifecycleGeneration: evidence.lifecycleGeneration,
          requestKey: evidence.requestKey,
          priorRequestSequence: evidence.requestSequence,
          retirementGeneration: owned401Generation,
        }),
        state: "available",
      });
      return committed.cursor;
    } finally {
      if (activeMe401RefreshOwners.get(evidence.requestKey) === rejection) {
        activeMe401RefreshOwners.delete(evidence.requestKey);
      }
      rejection.state = "consumed";
    }
  }

  public async refreshAccountCredential(
    leaseValue: unknown,
    expectedCredentialValue: unknown,
    owned401GenerationValue: string,
  ): Promise<CredentialCursor> {
    const sourceLease = validateAccountLease(leaseValue);
    const expectedCredential = validateCredentialCursor(expectedCredentialValue);
    const owned401Generation = requireGeneration(owned401GenerationValue);
    const runtime = captureAccountRuntimeFence(sourceLease);
    if (!runtime) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Account refresh runtime is stale");
    }
    return (await this.refreshAccountCredentialOwned(runtime, expectedCredential, owned401Generation)).cursor;
  }

  /**
   * Consumes only the exact terminal `/me` 401 emitted by the refresh-bound
   * retry. Runtime and request-sequence fences govern capability minting; once
   * minted, only a newer durable session, authority revision, or exact
   * credential wins the retirement race.
   */
  public async retireAccountAfterTerminalActiveMe401(
    leaseValue: unknown,
    rejectionValue: unknown,
  ): Promise<RetirementResult> {
    const sourceLease = validateAccountLease(leaseValue);
    if (!(rejectionValue instanceof SessionError)) {
      throw new SessionError(sessionErrorCodes.invalidState, "Terminal account identity rejection is unavailable");
    }
    const rejection = activeMe401Rejections.get(rejectionValue);
    const evidence = rejection?.evidence;
    if (
      !rejection ||
      rejection.state !== "available" ||
      !evidence ||
      evidence.purpose !== "retire" ||
      !sameActivation(evidence.activation, sourceLease.activation)
    ) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Terminal account identity rejection is stale");
    }
    rejection.state = "claimed";

    try {
      const result = await this.commit(
        (snapshot): CoordinatorDecision<RetirementResult> => {
          const authority = snapshot.authority;
          if (
            authority.mode === "retiring" &&
            authority.cause === "owned_401" &&
            sameActivation(authority.source, evidence.activation)
          ) {
            return keepCoordinatorSnapshot("already_retiring");
          }
          if (
            authority.mode !== "active" ||
            !sameActivation(authority.session, evidence.activation) ||
            authority.revision !== evidence.authorityRevision
          ) {
            return keepCoordinatorSnapshot("superseded");
          }
          const current = matchingCredential(snapshot, evidence.activation);
          if (
            !current ||
            !sameCredentialCursor(credentialCursor(current), evidence.expectedCredential) ||
            !sameCredentialRecord(current, evidence.capturedCredential)
          ) {
            return keepCoordinatorSnapshot("superseded");
          }
          if (
            evidence.retirementGeneration === authority.generation ||
            evidence.retirementGeneration === evidence.activation.authGeneration
          ) {
            throw new SessionError(
              sessionErrorCodes.invalidState,
              "Owned 401 retirement must rotate the auth generation",
            );
          }
          const retiring: AuthAuthority = {
            v: 6,
            mode: "retiring",
            generation: evidence.retirementGeneration,
            revision: authority.revision + 1,
            source: evidence.activation,
            cause: "owned_401",
            forbiddenGenerations: Object.freeze([]),
            phase: "revoked",
          };
          return replaceCoordinatorSnapshot(nextSnapshot(snapshot, retiring, [], []), "retired");
        },
        undefined,
        // The exact planner check and the coordinator write are one
        // transaction. Once that planner chooses retirement, runtime
        // replacement, a newer request, or suspension may veil local UI but
        // cannot retroactively win over the durable auth mutation.
        "transaction",
      );
      rejection.state = "consumed";
      return result;
    } catch (error) {
      // `transaction` result fencing resolves only after `complete`, so a
      // rejection means no retirement commit became durable. Preserve the
      // exact WeakMap capability for a retry; a successful or superseded
      // decision above consumes it and cannot be replayed.
      if (rejection.state === "claimed") rejection.state = "available";
      throw error;
    }
  }

  private async refreshAccountCredentialOwned(
    runtime: CapturedAccountRuntimeFence,
    expectedCredential: CredentialCursor,
    owned401Generation: string,
    exactCapturedCredential?: CredentialRecord,
    assertOwnerCurrent?: () => void,
  ): Promise<CommittedAccountRefresh> {
    const lifecycleGeneration = coordinatorLifecycleGeneration;
    const lease = runtime.lease;
    const signal = lease.signal;
    if (signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Account refresh lifecycle is stale");
    }

    const assertRuntimeCurrent = (): void => {
      if (signal.aborted || lifecycleGeneration !== coordinatorLifecycleGeneration) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Account refresh crossed a lifecycle fence");
      }
      runtime.assertCurrent();
      assertOwnerCurrent?.();
    };
    assertRuntimeCurrent();
    const captured = exactCapturedCredential ?? (await this.captureVerifiedCredential(lease.activation, signal));
    if (exactCapturedCredential) await verifyCredentialBytes(exactCapturedCredential);
    assertRuntimeCurrent();
    if (!sameCredentialCursor(credentialCursor(captured), expectedCredential)) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Captured account refresh credential is stale");
    }

    const dispatch = await executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<Readonly<{ request: Promise<Response> }>> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        assertRuntimeCurrent();
        const projection = activeProjection(snapshot, lease.activation);
        const current = matchingCredential(snapshot, lease.activation);
        if (
          !sameCredentialCursor(projection.credential, expectedCredential) ||
          !current ||
          !sameCredentialRecord(current, captured)
        ) {
          throw new SessionError(sessionErrorCodes.admissionDenied, "Account refresh dispatch credential is stale");
        }
        let request: Promise<Response>;
        try {
          request = fetch(REFRESH_ENDPOINT, {
            method: "POST",
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            redirect: "error",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              ...expectedAuthorityHeaders(lease.activation.serverAuthority),
            },
            body: JSON.stringify({ refreshToken: current.refreshToken }),
            signal,
          });
        } catch (error) {
          request = Promise.reject(error);
        }
        assertRuntimeCurrent();
        return keepCoordinatorSnapshot(Object.freeze({ request }));
      },
      signal,
    );
    assertRuntimeCurrent();

    const assertResponseCurrent = async (): Promise<void> => {
      assertRuntimeCurrent();
      const current = await this.captureVerifiedCredential(lease.activation, signal);
      assertRuntimeCurrent();
      if (!sameCredentialRecord(current, captured)) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Credential changed before account refresh delivery");
      }
      await this.finishCredentialAdmission(current, lease.activation, signal);
      assertRuntimeCurrent();
    };

    let response: Response;
    try {
      response = await dispatch.request;
    } catch {
      await assertResponseCurrent();
      throw new SessionError(sessionErrorCodes.admissionDenied, "Refresh request is unavailable");
    }
    await assertResponseCurrent();
    if (!response.ok) {
      const retirement =
        response.status === 401
          ? await this.retireAccountCredentialAfter401(
              runtime,
              captured,
              expectedCredential,
              owned401Generation,
              assertOwnerCurrent,
            )
          : undefined;
      throw new SessionError(
        sessionErrorCodes.admissionDenied,
        `Refresh request failed (${response.status})`,
        Object.freeze({
          kind: "refresh_http_status",
          status: response.status,
          ...(retirement === undefined ? {} : { retirement }),
        }),
      );
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Refresh response is malformed");
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBoundedResponseText(response, MAX_REFRESH_RESPONSE_BYTES));
    } catch {
      await assertResponseCurrent();
      throw new SessionError(sessionErrorCodes.admissionDenied, "Refresh response is malformed");
    }
    await assertResponseCurrent();
    if (!isRecord(body) || typeof body.accessToken !== "string" || typeof body.refreshToken !== "string") {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Refresh response is malformed");
    }

    let fingerprinted: Awaited<ReturnType<typeof fingerprintCandidateTokenSnapshot>>;
    try {
      const tokenSnapshot = createCandidateTokenSnapshot({
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
      });
      fingerprinted = await fingerprintCandidateTokenSnapshot(tokenSnapshot, lease.activation.serverAuthority);
    } catch {
      await assertResponseCurrent();
      throw new SessionError(sessionErrorCodes.admissionDenied, "Refresh response is malformed");
    }
    await assertResponseCurrent();
    const now = Date.now();
    if (
      fingerprinted.accountIdCandidate !== lease.activation.accountId ||
      fingerprinted.accessExpiresAt <= now ||
      fingerprinted.refreshExpiresAt <= now
    ) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Refresh credential is invalid or expired");
    }

    const replacement = createCredentialRecord({
      activation: lease.activation,
      credentialRevision: expectedCredential.credentialRevision + 1,
      credentialFingerprint: fingerprinted.credentialFingerprint,
      accessToken: fingerprinted.accessToken,
      refreshToken: fingerprinted.refreshToken,
    });
    await verifyCredentialBytes(replacement);
    await assertResponseCurrent();
    const proof = createAccountRefreshResponseProof({
      activation: lease.activation,
      expectedCredential,
      capturedCredential: captured,
      replacement,
      runtime,
      lifecycleGeneration,
      ...(assertOwnerCurrent === undefined ? {} : { assertOwnerCurrent }),
    });
    const committed = await this.commitAccountRefreshResponse(proof);
    return Object.freeze({ ...committed, replacement });
  }

  private async commitRefreshResponse(proofValue: unknown): Promise<CredentialCursor> {
    const claim = claimRefreshResponseProof(proofValue);
    const { activation, expectedCredential, capturedCredential, replacement, view } = claim.state;
    let committed = false;
    try {
      const result = await this.commit((snapshot): CoordinatorDecision<CredentialCursor> => {
        if (view.signal.aborted || claim.state.lifecycleGeneration !== coordinatorLifecycleGeneration) {
          throw new SessionError(
            sessionErrorCodes.staleOperation,
            "Refresh delivery view was invalidated before commit",
          );
        }
        const projection = activeProjection(snapshot, activation);
        if (!sameCredentialCursor(projection.credential, expectedCredential)) {
          throw new SessionError(sessionErrorCodes.admissionDenied, "Credential changed before refresh commit");
        }
        const current = matchingCredential(snapshot, activation);
        if (!current || !sameCredentialRecord(current, capturedCredential)) {
          throw new SessionError(sessionErrorCodes.admissionDenied, "Credential changed before refresh commit");
        }
        const nextAuthority: ActiveAuthority = {
          ...projection.authority,
          revision: projection.authority.revision + 1,
        };
        const nextCredential = credentialCursor(replacement);
        return replaceCoordinatorSnapshot(nextSnapshot(snapshot, nextAuthority, [replacement]), nextCredential);
      }, view.signal);
      committed = true;
      return result;
    } finally {
      claim.settle(committed);
    }
  }

  /**
   * Refresh is one coordinator-owned request/parse/commit operation. No
   * pre-response admission or caller-provided token pair can authorize a
   * credential replacement.
   */
  public async refreshActiveCredential(
    viewValue: unknown,
    expectedCredentialValue: unknown,
  ): Promise<CredentialCursor> {
    const lifecycleGeneration = coordinatorLifecycleGeneration;
    const view = validateViewLease(viewValue);
    const expectedCredential = validateCredentialCursor(expectedCredentialValue);
    if (view.signal.aborted) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Refresh view has been invalidated");
    }
    const captured = await this.captureVerifiedCredential(view.activation, view.signal);
    if (
      lifecycleGeneration !== coordinatorLifecycleGeneration ||
      !sameCredentialCursor(credentialCursor(captured), expectedCredential)
    ) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Captured refresh credential is stale");
    }

    const dispatch = await executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<Readonly<{ request: Promise<Response> }>> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        const projection = activeProjection(snapshot, view.activation);
        const current = matchingCredential(snapshot, view.activation);
        if (
          view.signal.aborted ||
          lifecycleGeneration !== coordinatorLifecycleGeneration ||
          !sameCredentialCursor(projection.credential, expectedCredential) ||
          !current ||
          !sameCredentialRecord(current, captured)
        ) {
          throw new SessionError(sessionErrorCodes.admissionDenied, "Refresh dispatch credential is stale");
        }
        let response: Promise<Response>;
        try {
          response = fetch(REFRESH_ENDPOINT, {
            method: "POST",
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            redirect: "error",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              ...expectedAuthorityHeaders(view.activation.serverAuthority),
            },
            body: JSON.stringify({ refreshToken: current.refreshToken }),
            signal: view.signal,
          });
        } catch (error) {
          response = Promise.reject(error);
        }
        return keepCoordinatorSnapshot(Object.freeze({ request: response }));
      },
      view.signal,
    );

    const assertResponseCurrent = async (): Promise<void> => {
      if (view.signal.aborted || lifecycleGeneration !== coordinatorLifecycleGeneration) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Refresh response crossed a lifecycle fence");
      }
      const current = await this.captureVerifiedCredential(view.activation, view.signal);
      if (!sameCredentialRecord(current, captured) || view.signal.aborted) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Credential changed before refresh delivery");
      }
      await this.finishCredentialAdmission(current, view.activation, view.signal);
      if (view.signal.aborted || lifecycleGeneration !== coordinatorLifecycleGeneration) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Refresh response crossed a lifecycle fence");
      }
    };

    let response: Response;
    try {
      response = await dispatch.request;
    } catch {
      await assertResponseCurrent();
      throw new SessionError(sessionErrorCodes.admissionDenied, "Refresh request is unavailable");
    }
    if (!response.ok) {
      await assertResponseCurrent();
      throw new SessionError(sessionErrorCodes.admissionDenied, `Refresh request failed (${response.status})`);
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      await assertResponseCurrent();
      throw new SessionError(sessionErrorCodes.admissionDenied, "Refresh response is malformed");
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBoundedResponseText(response, MAX_REFRESH_RESPONSE_BYTES));
    } catch {
      await assertResponseCurrent();
      throw new SessionError(sessionErrorCodes.admissionDenied, "Refresh response is malformed");
    }
    if (!isRecord(body) || typeof body.accessToken !== "string" || typeof body.refreshToken !== "string") {
      await assertResponseCurrent();
      throw new SessionError(sessionErrorCodes.admissionDenied, "Refresh response is malformed");
    }
    let fingerprinted: Awaited<ReturnType<typeof fingerprintCandidateTokenSnapshot>>;
    try {
      const tokenSnapshot = createCandidateTokenSnapshot({
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
      });
      fingerprinted = await fingerprintCandidateTokenSnapshot(tokenSnapshot, view.activation.serverAuthority);
    } catch {
      await assertResponseCurrent();
      throw new SessionError(sessionErrorCodes.admissionDenied, "Refresh response is malformed");
    }
    if (
      fingerprinted.accountIdCandidate !== view.activation.accountId ||
      fingerprinted.accessExpiresAt <= Date.now() ||
      fingerprinted.refreshExpiresAt <= Date.now() ||
      view.signal.aborted
    ) {
      await assertResponseCurrent();
      throw new SessionError(sessionErrorCodes.admissionDenied, "Refresh credential is invalid or expired");
    }
    const replacement = createCredentialRecord({
      activation: view.activation,
      credentialRevision: expectedCredential.credentialRevision + 1,
      credentialFingerprint: fingerprinted.credentialFingerprint,
      accessToken: fingerprinted.accessToken,
      refreshToken: fingerprinted.refreshToken,
    });
    await verifyCredentialBytes(replacement);
    await assertResponseCurrent();
    const proof = createRefreshResponseProof({
      activation: view.activation,
      expectedCredential,
      capturedCredential: captured,
      replacement,
      view,
      lifecycleGeneration,
    });
    return this.commitRefreshResponse(proof);
  }

  public async reserveAcquisitionTransition(
    expected: AuthorityCursor,
    proofValue: VerifiedCandidateProof,
    targetValue: unknown,
    sourceValue: unknown | null,
    now = Date.now(),
  ): Promise<AcquisitionTransitionPermit> {
    const evidence = readVerifiedCandidateProof(proofValue);
    const target = createVerifiedTransitionTarget(targetValue, evidence.serverAuthority, evidence.accountId);
    const source = sourceValue === null ? null : validateActivationCertificate(sourceValue);
    if (
      target.serverAuthority !== evidence.serverAuthority ||
      target.accountId !== evidence.accountId ||
      target.accountId !== evidence.candidate.accountIdCandidate ||
      evidence.attempt.sourceEpoch !== (source?.sessionEpoch ?? null)
    ) {
      throw new SessionError(
        sessionErrorCodes.admissionDenied,
        "Verified candidate does not match the transition target",
      );
    }
    const permit = validateAcquisitionTransitionPermit({
      v: 1,
      kind: "acquisition_transition",
      permitId: target.transitionPermitId,
      attemptId: evidence.attempt.attemptId,
      target,
      targetCredentialFingerprint: evidence.candidate.credentialFingerprint,
      expiresAt: Math.min(
        evidence.attempt.expiresAt,
        evidence.candidate.accessExpiresAt,
        evidence.candidate.refreshExpiresAt,
      ),
    });
    if (permit.expiresAt <= now) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "Verified candidate is expired");
    }

    const cleanupReceipt = source === null ? (await this.scrubConfiguredLegacyPersistence()).receipt : undefined;
    return this.commit((snapshot): CoordinatorDecision<AcquisitionTransitionPermit> => {
      const commitTime = Math.max(now, Date.now());
      if (evidence.signal.aborted || evidence.lifecycleGeneration !== coordinatorLifecycleGeneration) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Verified candidate crossed a lifecycle fence");
      }
      const authority = snapshot.authority;
      if (authority.generation !== expected.generation || authority.revision !== expected.revision) {
        throw new SessionError(
          sessionErrorCodes.admissionDenied,
          "Auth authority changed before transition reservation",
        );
      }
      const sourceMatches =
        source === null
          ? authority.mode === "none"
          : authority.mode === "active" && sameActivation(authority.session, source);
      if (!sourceMatches) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Transition source is no longer authoritative");
      }
      if (permit.target.authGeneration === authority.generation) {
        throw new SessionError(sessionErrorCodes.invalidState, "Transition must rotate the auth generation");
      }
      const attempt = snapshot.attempts.find((item) => item.attemptId === permit.attemptId);
      if (
        !attempt ||
        attempt.kind !== "acquisition" ||
        !sameAcquisitionAttempt(attempt, evidence.attempt) ||
        attempt.expiresAt <= commitTime ||
        permit.expiresAt <= commitTime ||
        attempt.baselineGeneration !== authority.generation ||
        attempt.serverAuthority !== permit.target.serverAuthority ||
        attempt.sourceEpoch !== (source?.sessionEpoch ?? null)
      ) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Transition attempt is missing, expired, or stale");
      }
      const transition: AuthAuthority = {
        v: 6,
        mode: "transition",
        generation: permit.target.authGeneration,
        revision: authority.revision + 1,
        permit,
        source,
        phase: source === null ? "source_purged" : "revoked",
        ...(cleanupReceipt === undefined ? {} : { cleanupReceipt }),
      };
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, transition, [], [attempt]), permit);
    }, evidence.signal);
  }

  public async completeAcquisitionTransition(
    permitValue: unknown,
    proofValue: VerifiedCandidateProof,
    cleanupReceiptValue?: string,
    now = Date.now(),
  ): Promise<void> {
    const permit = validateAcquisitionTransitionPermit(permitValue);
    const cleanupReceipt = cleanupReceiptValue === undefined ? undefined : requireCleanupReceipt(cleanupReceiptValue);
    const proofClaim = claimVerifiedCandidateProof(proofValue);
    const evidence = proofClaim.evidence;
    const credential = createCredentialRecord({
      activation: permit.target,
      credentialRevision: 0,
      credentialFingerprint: evidence.candidate.credentialFingerprint,
      accessToken: evidence.candidate.accessToken,
      refreshToken: evidence.candidate.refreshToken,
    });
    let committed = false;
    try {
      if (
        permit.targetCredentialFingerprint !== credential.credentialFingerprint ||
        evidence.serverAuthority !== permit.target.serverAuthority ||
        evidence.accountId !== permit.target.accountId ||
        evidence.candidate.accountIdCandidate !== permit.target.accountId ||
        evidence.attempt.attemptId !== permit.attemptId ||
        evidence.candidate.credentialFingerprint !== permit.targetCredentialFingerprint ||
        permit.expiresAt !==
          Math.min(evidence.attempt.expiresAt, evidence.candidate.accessExpiresAt, evidence.candidate.refreshExpiresAt)
      ) {
        throw new SessionError(sessionErrorCodes.invalidState, "Transition credential does not match its target");
      }
      await verifyCredentialBytes(credential);
      if (evidence.signal.aborted || evidence.lifecycleGeneration !== coordinatorLifecycleGeneration) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Verified candidate crossed a lifecycle fence");
      }

      await this.commit((snapshot): CoordinatorDecision<void> => {
        const commitTime = Math.max(now, Date.now());
        if (evidence.signal.aborted || evidence.lifecycleGeneration !== coordinatorLifecycleGeneration) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Verified candidate crossed a lifecycle fence");
        }
        const authority = snapshot.authority;
        if (
          authority.mode !== "transition" ||
          !sameTransitionPermit(authority.permit, permit) ||
          authority.phase !== "source_purged" ||
          (authority.source === null
            ? cleanupReceipt !== undefined
            : cleanupReceipt === undefined || authority.cleanupReceipt !== cleanupReceipt) ||
          authority.generation !== permit.target.authGeneration ||
          permit.expiresAt <= commitTime
        ) {
          throw new SessionError(sessionErrorCodes.admissionDenied, "Transition is not ready for activation");
        }
        const attempt = snapshot.attempts.find((item) => item.attemptId === permit.attemptId);
        if (
          !attempt ||
          attempt.kind !== "acquisition" ||
          !sameAcquisitionAttempt(attempt, evidence.attempt) ||
          attempt.expiresAt <= commitTime ||
          attempt.serverAuthority !== permit.target.serverAuthority
        ) {
          throw new SessionError(sessionErrorCodes.admissionDenied, "Transition attempt is missing, expired, or stale");
        }
        const active: AuthAuthority = {
          v: 6,
          mode: "active",
          generation: permit.target.authGeneration,
          revision: authority.revision + 1,
          session: permit.target,
        };
        return replaceCoordinatorSnapshot(nextSnapshot(snapshot, active, [credential], []), undefined);
      }, evidence.signal);
      committed = true;
    } finally {
      proofClaim.settle(committed);
    }
  }

  /**
   * Explicit logout from an anonymous/recovery surface still retires every
   * token-producing attempt. The exact none authority becomes a durable
   * `cleaning` tombstone in one coordinator transaction before legacy cleanup
   * can block; only a verified scrub may rotate it back to `none`.
   */
  public async cancelAnonymousAuthority(
    expectedValue: unknown,
    nextGenerationValue: string,
  ): Promise<AnonymousCancellationResult> {
    const expected = validateAuthAuthority(expectedValue);
    const nextGeneration = requireGeneration(nextGenerationValue);
    if (expected.mode !== "none") {
      throw new SessionError(sessionErrorCodes.invalidState, "Anonymous cancellation requires a none authority");
    }
    return this.commit((snapshot): CoordinatorDecision<AnonymousCancellationResult> => {
      const authority = snapshot.authority;
      if (authority.mode !== "none" || authority.generation !== expected.generation) {
        return keepCoordinatorSnapshot(Object.freeze({ kind: "superseded", authority }));
      }
      if (nextGeneration === authority.generation) {
        throw new SessionError(sessionErrorCodes.invalidState, "Anonymous cancellation must rotate generation");
      }
      const cleaning: AuthAuthority = {
        v: 6,
        mode: "cleaning",
        generation: nextGeneration,
        revision: authority.revision + 1,
        cause: "anonymous_logout",
        forbiddenGenerations: Object.freeze([authority.generation]),
      };
      return replaceCoordinatorSnapshot(
        nextSnapshot(snapshot, cleaning, [], []),
        Object.freeze({ kind: "cleaning", authority: cleaning }),
      );
    });
  }

  /**
   * Deterministically abandons one exact persisted transition. Anonymous
   * transitions converge through a durable `cleaning` tombstone; a transition
   * that retired a source session becomes an ordinary retirement so its
   * physical scope must still pass the verified purge barrier.
   */
  public async cancelAcquisitionTransition(
    permitValue: unknown,
    nextGeneration: string,
  ): Promise<TransitionCancellationResult> {
    const permit = validateAcquisitionTransitionPermit(permitValue);
    const generation = requireGeneration(nextGeneration);
    return this.commit((snapshot): CoordinatorDecision<TransitionCancellationResult> => {
      const authority = snapshot.authority;
      if (authority.mode !== "transition" || !sameTransitionPermit(authority.permit, permit)) {
        return keepCoordinatorSnapshot(Object.freeze({ kind: "superseded", authority }));
      }
      const attempt = snapshot.attempts.find((item) => item.attemptId === permit.attemptId);
      if (!attempt || attempt.kind !== "acquisition") {
        throw invariantFailure("Transition cancellation lost its exact acquisition attempt");
      }
      if (
        generation === authority.generation ||
        generation === permit.target.authGeneration ||
        generation === attempt.baselineGeneration ||
        (authority.source !== null && generation === authority.source.authGeneration)
      ) {
        throw new SessionError(sessionErrorCodes.invalidState, "Transition cancellation must rotate generation");
      }
      if (authority.source === null) {
        const cleaning: AuthAuthority = {
          v: 6,
          mode: "cleaning",
          generation,
          revision: authority.revision + 1,
          cause: "transition_cancelled",
          forbiddenGenerations: Object.freeze([attempt.baselineGeneration, authority.generation]),
        };
        return replaceCoordinatorSnapshot(
          nextSnapshot(snapshot, cleaning, [], []),
          Object.freeze({ kind: "cleaning", authority: cleaning }),
        );
      }
      const retiring: AuthAuthority = {
        v: 6,
        mode: "retiring",
        generation,
        revision: authority.revision + 1,
        source: authority.source,
        cause: "transition_cancelled",
        forbiddenGenerations: Object.freeze([authority.generation]),
        phase: authority.phase,
        ...(authority.cleanupReceipt === undefined ? {} : { cleanupReceipt: authority.cleanupReceipt }),
      };
      return replaceCoordinatorSnapshot(
        nextSnapshot(snapshot, retiring, [], []),
        Object.freeze({ kind: "retiring", authority: retiring, source: authority.source }),
      );
    });
  }

  /**
   * Finish an exact source-free cleanup only after this document has deleted
   * and verified every ambiguous legacy persistence target. A lost realm can
   * never strand a false terminal `none`: another document reruns cleanup and
   * completes the same durable `cleaning` authority.
   */
  public async completeAnonymousCleanup(cleaningValue: unknown, anonymousGenerationValue: string): Promise<void> {
    const anonymousGeneration = requireGeneration(anonymousGenerationValue);
    const requested = validateAuthAuthority(cleaningValue);
    if (requested.mode !== "cleaning") {
      throw new SessionError(sessionErrorCodes.invalidState, "Anonymous cleanup authority is malformed");
    }
    if (anonymousGeneration === requested.generation || requested.forbiddenGenerations.includes(anonymousGeneration)) {
      throw new SessionError(sessionErrorCodes.invalidState, "Anonymous cleanup must rotate generation");
    }
    const cleaning = await executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<Extract<AuthAuthority, { mode: "cleaning" }>> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        const authority = snapshot.authority;
        if (authority.mode !== "cleaning" || !sameCleaningAuthority(authority, requested)) {
          throw new SessionError(sessionErrorCodes.admissionDenied, "Anonymous cleanup authority changed");
        }
        return keepCoordinatorSnapshot(authority);
      },
    );
    await this.scrubConfiguredLegacyPersistence();
    await this.commit((snapshot): CoordinatorDecision<void> => {
      const authority = snapshot.authority;
      if (authority.mode !== "cleaning" || !sameCleaningAuthority(authority, cleaning)) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Anonymous cleanup authority changed");
      }
      const anonymous: AuthAuthority = {
        v: 6,
        mode: "none",
        generation: anonymousGeneration,
        revision: authority.revision + 1,
      };
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, anonymous, [], []), undefined);
    });
  }

  public async beginRetirement(
    capturedValue: unknown,
    cause: "logout" | "server_mismatch",
    nextGeneration: string,
  ): Promise<RetirementResult> {
    const captured = validateActivationCertificate(capturedValue);
    const generation = requireGeneration(nextGeneration);
    return this.commit((snapshot): CoordinatorDecision<RetirementResult> => {
      const authority = snapshot.authority;
      if (authority.mode === "retiring" && sameActivation(authority.source, captured)) {
        return keepCoordinatorSnapshot("already_retiring");
      }

      const ownsActive = authority.mode === "active" && sameActivation(authority.session, captured);
      const ownsTransition =
        cause === "logout" &&
        authority.mode === "transition" &&
        authority.source !== null &&
        sameActivation(authority.source, captured);
      if (!ownsActive && !ownsTransition) return keepCoordinatorSnapshot("superseded");
      if (generation === authority.generation || generation === captured.authGeneration) {
        throw new SessionError(sessionErrorCodes.invalidState, "Retirement must rotate the auth generation");
      }

      const retiring: AuthAuthority = {
        v: 6,
        mode: "retiring",
        generation,
        revision: authority.revision + 1,
        source: captured,
        cause: ownsTransition ? "transition_cancelled" : cause,
        forbiddenGenerations: ownsTransition ? Object.freeze([authority.generation]) : Object.freeze([]),
        phase: "revoked",
      };
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, retiring, [], []), "retired");
    });
  }

  public async assertPurgeSource(capturedValue: unknown, signal?: AbortSignal): Promise<AuthAuthority> {
    const captured = validateActivationCertificate(capturedValue);
    return executeCoordinatorTransaction(
      this.factory,
      "readonly",
      false,
      this.onBlocked,
      (snapshot): CoordinatorDecision<AuthAuthority> => {
        if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
        const authority = snapshot.authority;
        if (authority.mode === "retiring" && sameActivation(authority.source, captured)) {
          return keepCoordinatorSnapshot(authority);
        }
        if (authority.mode === "transition" && authority.source && sameActivation(authority.source, captured)) {
          return keepCoordinatorSnapshot(authority);
        }
        throw new SessionError(sessionErrorCodes.admissionDenied, "Captured activation does not own a pending purge");
      },
      signal,
    );
  }

  public async commitVerifiedPurge(completionValue: VerifiedPurgeCompletion): Promise<string> {
    const claim = claimVerifiedPurgeCompletion(completionValue);
    const captured = validateActivationCertificate(claim.source);
    const receipt = requireCleanupReceipt(claim.receipt);
    try {
      await executeCoordinatorTransaction(
        this.factory,
        "readwrite",
        false,
        this.onBlocked,
        (snapshot): CoordinatorDecision<void> => {
          if (snapshot === null) throw invariantFailure("Auth coordinator authority is missing");
          if (claim.signal.aborted) {
            throw new SessionError(sessionErrorCodes.staleOperation, "Verified purge crossed a lifecycle fence");
          }
          const authority = snapshot.authority;
          if (authority.mode === "retiring" && sameActivation(authority.source, captured)) {
            if (authority.phase === "source_purged") {
              if (authority.cleanupReceipt === receipt) return keepCoordinatorSnapshot(undefined);
              throw new SessionError(sessionErrorCodes.admissionDenied, "Source purge receipt is already immutable");
            }
            const next: AuthAuthority = {
              ...authority,
              revision: authority.revision + 1,
              phase: "source_purged",
              cleanupReceipt: receipt,
            };
            return replaceCoordinatorSnapshot(nextSnapshot(snapshot, next), undefined);
          }
          if (authority.mode === "transition" && authority.source && sameActivation(authority.source, captured)) {
            if (authority.phase === "source_purged") {
              if (authority.cleanupReceipt === receipt) return keepCoordinatorSnapshot(undefined);
              throw new SessionError(sessionErrorCodes.admissionDenied, "Source purge receipt is already immutable");
            }
            const next: AuthAuthority = {
              ...authority,
              revision: authority.revision + 1,
              phase: "source_purged",
              cleanupReceipt: receipt,
            };
            return replaceCoordinatorSnapshot(nextSnapshot(snapshot, next), undefined);
          }
          throw new SessionError(sessionErrorCodes.admissionDenied, "Captured activation no longer owns the purge");
        },
        claim.signal,
      );
      claim.settle(true);
      return receipt;
    } catch (error) {
      claim.settle(false);
      throw error;
    }
  }

  public async completeRetirement(
    capturedValue: unknown,
    cleanupReceiptValue: string,
    anonymousGeneration: string,
  ): Promise<void> {
    const captured = validateActivationCertificate(capturedValue);
    const cleanupReceipt = requireCleanupReceipt(cleanupReceiptValue);
    const generation = requireGeneration(anonymousGeneration);
    await this.commit((snapshot): CoordinatorDecision<void> => {
      const authority = snapshot.authority;
      if (
        authority.mode !== "retiring" ||
        !sameActivation(authority.source, captured) ||
        authority.phase !== "source_purged" ||
        authority.cleanupReceipt !== cleanupReceipt
      ) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Retirement cleanup receipt is not authoritative");
      }
      if (
        generation === authority.generation ||
        generation === captured.authGeneration ||
        authority.forbiddenGenerations.some((forbidden) => forbidden === generation)
      ) {
        throw new SessionError(
          sessionErrorCodes.invalidState,
          "Anonymous finalization must rotate the auth generation",
        );
      }
      const next: AuthAuthority = {
        v: 6,
        mode: "none",
        generation,
        revision: authority.revision + 1,
      };
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, next, [], []), undefined);
    });
  }

  public async putAttempt(attemptValue: unknown): Promise<void> {
    const attempt = validateSessionAttempt(attemptValue);
    await this.commit((snapshot): CoordinatorDecision<void> => {
      if (
        snapshot.authority.mode === "cleaning" ||
        snapshot.authority.mode === "transition" ||
        snapshot.authority.mode === "retiring"
      ) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Attempt writes are blocked during retirement");
      }
      if (attempt.baselineGeneration !== snapshot.authority.generation) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Attempt baseline generation is stale");
      }
      const attempts = [...snapshot.attempts.filter((item) => item.attemptId !== attempt.attemptId), attempt];
      const authority = { ...snapshot.authority, revision: snapshot.authority.revision + 1 } as AuthAuthority;
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, authority, snapshot.credentials, attempts), undefined);
    });
  }

  public async deleteAttempt(attemptId: string): Promise<boolean> {
    if (attemptId.length === 0) {
      throw new SessionError(sessionErrorCodes.invalidState, "Attempt id must not be empty");
    }
    return this.commit((snapshot): CoordinatorDecision<boolean> => {
      if (
        snapshot.authority.mode === "cleaning" ||
        snapshot.authority.mode === "transition" ||
        snapshot.authority.mode === "retiring"
      ) {
        throw new SessionError(sessionErrorCodes.admissionDenied, "Attempt deletion is blocked during retirement");
      }
      if (!snapshot.attempts.some((attempt) => attempt.attemptId === attemptId)) {
        return keepCoordinatorSnapshot(false);
      }
      const authority = { ...snapshot.authority, revision: snapshot.authority.revision + 1 } as AuthAuthority;
      const attempts = snapshot.attempts.filter((attempt) => attempt.attemptId !== attemptId);
      return replaceCoordinatorSnapshot(nextSnapshot(snapshot, authority, snapshot.credentials, attempts), true);
    });
  }
}
