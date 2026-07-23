import { AccountStateStore } from "../api/account-state-store.js";
import {
  getPinnedServerAuthority,
  reconcilePinnedServerAuthority,
  type ServerAuthorityReconciliation,
} from "../api/server-authority.js";
import {
  SelectedOrganizationController,
  type SelectedOrganizationPublication,
  type SelectedOrganizationReason,
  type SelectedOrganizationState,
} from "./selected-organization.js";
import { captureAccountStoreRuntime, installAccountStoreRuntime } from "./session/account-store-runtime.js";
import { ContentDatabaseRegistry, ContentScopeBarrier, type SessionLockManager } from "./session/content-barrier.js";
import { captureContentStoreRuntime } from "./session/content-store-runtime.js";
import {
  type ActiveHttpMethod,
  type ActiveHttpRequestBody,
  type ActiveHttpResponse,
  type ActiveHttpResponseType,
  type ActiveSessionProjection,
  AuthSessionCoordinator,
  type CoordinatorOptions,
  type RetirementResult,
} from "./session/coordinator.js";
import {
  type CrossDocumentAuthNotice,
  type CrossDocumentNoticeTransport,
  installCrossDocumentAuthNotices,
} from "./session/cross-document-notices.js";
import { SessionError, sessionErrorCodes } from "./session/errors.js";
import {
  type LegacyScrubOptions,
  type StorageArea,
  scrubLegacyPersistence,
  scrubLegacyWebStorage,
} from "./session/legacy-scrub.js";
import { installSessionLifecycleHooks } from "./session/lifecycle.js";
import {
  type AccountLease,
  type ActivationCertificate,
  type AuthAuthority,
  type CredentialCursor,
  createAccountLease,
  type JsonValue,
  sameActivation,
  sameCredentialCursor,
} from "./session/types.js";
import { SessionVeilController, type SessionVeilToken } from "./session-veil.js";

const OWNER_TAB_STORAGE_KEY = "first-tree:session-owner-tab:v1";
const MAX_OWNER_TAB_ID_LENGTH = 256;
const MAX_RECONCILIATION_ATTEMPTS = 4;
const MAX_PENDING_SOURCE_NOTICES = 256;

type LifecycleEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;
type RuntimeDocumentTarget = LifecycleEventTarget & Readonly<{ visibilityState?: DocumentVisibilityState }>;

export type BrowserSessionStorage = StorageArea & Pick<Storage, "setItem">;

export type BrowserSessionAuthorityProbe = Readonly<{
  pin: () => Promise<string>;
  reconcile: (expected: string) => Promise<ServerAuthorityReconciliation>;
}>;

export type BrowserSessionNoticeTransportFactory = (
  onNotice: (notice: CrossDocumentAuthNotice) => void,
) => CrossDocumentNoticeTransport;

export type BrowserSessionRuntimeOptions = Readonly<{
  indexedDB?: IDBFactory;
  locks?: SessionLockManager;
  localStorage?: BrowserSessionStorage;
  sessionStorage?: BrowserSessionStorage;
  authority?: BrowserSessionAuthorityProbe;
  createId?: () => string;
  now?: () => number;
  onDatabaseBlocked?: (databaseName: string) => void;
  windowTarget?: LifecycleEventTarget;
  documentTarget?: RuntimeDocumentTarget;
  noticeTransportFactory?: BrowserSessionNoticeTransportFactory;
}>;

export type BrowserSessionActiveProjection = Readonly<{
  kind: "active";
  activation: ActivationCertificate;
  accountLease: AccountLease;
  credential: ActiveSessionProjection["credential"];
  me: Readonly<Record<string, unknown>>;
  publication: SelectedOrganizationPublication;
}>;

export type BrowserSessionProjection =
  | Readonly<{ kind: "veiled"; reason: string | null; revision: number }>
  | Readonly<{ kind: "anonymous" }>
  | BrowserSessionActiveProjection
  | Readonly<{ kind: "recovery"; reason: string }>;

export type BrowserSessionSubscriber = (projection: BrowserSessionProjection) => void;
export type BrowserSessionLogoutResult = "completed" | "superseded";

export type BrowserSessionHttpTarget =
  | Readonly<{ kind: "selected-organization"; path: string }>
  | Readonly<{ kind: "selected-resource"; path: string }>;

export type BrowserSessionHttpRequest = Readonly<{
  target: BrowserSessionHttpTarget;
  method?: ActiveHttpMethod;
  headers?: Readonly<Record<string, string>>;
  body?: ActiveHttpRequestBody;
  responseType: ActiveHttpResponseType;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}>;

export type BrowserSessionHttpFacade = Readonly<{
  request(input: BrowserSessionHttpRequest): Promise<ActiveHttpResponse>;
}>;

type RuntimeOperation = Readonly<{
  revision: number;
  veil: SessionVeilToken;
  noticeRevision: number | null;
}>;

type InternalState =
  | Readonly<{ kind: "anonymous" }>
  | BrowserSessionActiveProjection
  | Readonly<{ kind: "recovery"; reason: string }>;

type AccountRuntimeHandle = Readonly<{
  activation: ActivationCertificate;
  accountLease: AccountLease;
  sourceController: AbortController;
  disposeAccountRuntime: () => void;
}>;

type ActiveRuntime = AccountRuntimeHandle & Readonly<{ projection: BrowserSessionActiveProjection }>;

type RecoveryRemount = Readonly<{
  activation: ActivationCertificate;
  expectedState: SelectedOrganizationState;
}>;

type ReconciledSelection = Readonly<{
  me: Readonly<Record<string, unknown>>;
  publication: SelectedOrganizationPublication;
}>;

type RetirementCompletion =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "superseded"; authority: AuthAuthority }>;

type PendingResume = Readonly<{
  cycle: number;
  promise: Promise<BrowserSessionProjection>;
}>;

type PendingTerminalActiveMe401 = Readonly<{
  lease: AccountLease;
  rejection: SessionError;
}>;

type PendingTerminalActiveMe401Result = Readonly<{
  source: ActivationCertificate;
  retirement: RetirementResult;
}>;

type ActiveHttpOwner = Readonly<{
  active: ActiveRuntime;
  accountLease: AccountLease;
  publication: SelectedOrganizationPublication;
  view: NonNullable<SelectedOrganizationPublication["viewLease"]>;
  credential: CredentialCursor;
}>;

type PendingActiveHttpRefresh = Readonly<{
  activation: ActivationCertificate;
  credential: CredentialCursor;
  promise: Promise<ActiveRuntime>;
}>;

type PendingTerminalActiveHttp401 = Readonly<{
  source: ActivationCertificate;
  response: ActiveHttpResponse;
  generation: string;
}>;

type PendingTerminalActiveHttp401Result = Readonly<{
  source: ActivationCertificate;
  retirement: RetirementResult;
}>;

type SuspendedRemount = Readonly<{
  handle: AccountRuntimeHandle;
  session: ActiveSessionProjection;
  me: Readonly<Record<string, unknown>>;
}>;

function captureNoticeTransport(value: CrossDocumentNoticeTransport): CrossDocumentNoticeTransport {
  const available = value.available;
  const publishSourceRetired = value.publishSourceRetired;
  const publishAuthorityAdvanced = value.publishAuthorityAdvanced;
  const dispose = value.dispose;
  if (
    typeof available !== "boolean" ||
    typeof publishSourceRetired !== "function" ||
    typeof publishAuthorityAdvanced !== "function" ||
    typeof dispose !== "function"
  ) {
    throw new SessionError(sessionErrorCodes.invalidState, "Cross-document notice transport is malformed");
  }
  return Object.freeze({
    available,
    publishSourceRetired: (sessionEpoch: string) => publishSourceRetired.call(value, sessionEpoch),
    publishAuthorityAdvanced: () => publishAuthorityAdvanced.call(value),
    dispose: () => dispose.call(value),
  });
}

function defaultCreateId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new SessionError(sessionErrorCodes.platformUnavailable, "Secure randomness is required for browser sessions");
  }
  return globalThis.crypto.randomUUID();
}

function defaultStorage(name: "localStorage" | "sessionStorage"): BrowserSessionStorage {
  const value = globalThis[name];
  if (!value) {
    throw new SessionError(sessionErrorCodes.persistenceUnavailable, `${name} is required for browser sessions`);
  }
  return value;
}

function defaultAuthorityProbe(): BrowserSessionAuthorityProbe {
  return Object.freeze({ pin: getPinnedServerAuthority, reconcile: reconcilePinnedServerAuthority });
}

function recoveryReason(error: unknown): string {
  if (error instanceof SessionError) return error.code;
  return "session_recovery_required";
}

function sessionHttpStatus(error: unknown, kind: "active_me_http_status" | "refresh_http_status"): number | null {
  if (!(error instanceof SessionError) || typeof error.detail !== "object" || error.detail === null) return null;
  const kindDescriptor = Reflect.getOwnPropertyDescriptor(error.detail, "kind");
  const statusDescriptor = Reflect.getOwnPropertyDescriptor(error.detail, "status");
  return kindDescriptor?.value === kind &&
    typeof statusDescriptor?.value === "number" &&
    Number.isSafeInteger(statusDescriptor.value)
    ? statusDescriptor.value
    : null;
}

function isAuthenticationFailure(error: unknown): boolean {
  return (
    sessionHttpStatus(error, "active_me_http_status") === 401 || sessionHttpStatus(error, "refresh_http_status") === 401
  );
}

function isServerMismatchFailure(error: unknown): boolean {
  return (
    sessionHttpStatus(error, "active_me_http_status") === 421 || sessionHttpStatus(error, "refresh_http_status") === 421
  );
}

function owned401Retirement(error: unknown): RetirementResult | null {
  if (sessionHttpStatus(error, "refresh_http_status") !== 401 || !(error instanceof SessionError)) return null;
  if (typeof error.detail !== "object" || error.detail === null) return null;
  const descriptor = Reflect.getOwnPropertyDescriptor(error.detail, "retirement");
  return descriptor?.value === "retired" ||
    descriptor?.value === "already_retiring" ||
    descriptor?.value === "superseded"
    ? descriptor.value
    : null;
}

function authoritySource(authority: AuthAuthority): ActivationCertificate | null {
  if (authority.mode === "active") return authority.session;
  if (authority.mode === "retiring") return authority.source;
  if (authority.mode === "transition") return authority.source;
  return null;
}

function opaqueId(createId: () => string, label: string): string {
  const value = createId();
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_OWNER_TAB_ID_LENGTH) {
    throw new SessionError(sessionErrorCodes.platformUnavailable, `${label} generation failed`);
  }
  return value;
}

function ownerTabId(storage: BrowserSessionStorage, createId: () => string): string {
  let existing: string | null;
  try {
    existing = storage.getItem(OWNER_TAB_STORAGE_KEY);
  } catch (error) {
    throw new SessionError(sessionErrorCodes.persistenceUnavailable, "Session owner tab could not be read", error);
  }
  if (existing !== null && existing.length > 0 && existing.length <= MAX_OWNER_TAB_ID_LENGTH) return existing;
  const created = opaqueId(createId, "Session owner tab");
  try {
    storage.setItem(OWNER_TAB_STORAGE_KEY, created);
    if (storage.getItem(OWNER_TAB_STORAGE_KEY) !== created) {
      throw new SessionError(sessionErrorCodes.persistenceUnavailable, "Session owner tab could not be verified");
    }
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw new SessionError(sessionErrorCodes.persistenceUnavailable, "Session owner tab could not be persisted", error);
  }
  return created;
}

type CapturedBrowserSessionHttpRequest = Readonly<{
  target: BrowserSessionHttpTarget;
  method: ActiveHttpMethod | undefined;
  headers: Readonly<Record<string, string>> | undefined;
  body: ActiveHttpRequestBody | undefined;
  responseType: ActiveHttpResponseType;
  maxResponseBytes: number | undefined;
  signal: AbortSignal | undefined;
}>;

const MAX_BROWSER_HTTP_REQUEST_HEADERS = 64;
const MAX_BROWSER_HTTP_HEADER_NAME_BYTES = 256;
const MAX_BROWSER_HTTP_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_BROWSER_HTTP_HEADERS_BYTES = 64 * 1024;

function browserHttpInvalid(message: string): SessionError {
  return new SessionError(sessionErrorCodes.invalidState, message);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotBrowserHttpHeaders(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw browserHttpInvalid("Authenticated browser headers are malformed");
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  let count = 0;
  let encodedBytes = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw browserHttpInvalid("Authenticated browser headers are malformed");
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw browserHttpInvalid("Authenticated browser headers are accessor-backed");
    }
    count += 1;
    const keyBytes = new TextEncoder().encode(key).byteLength;
    const valueBytes = new TextEncoder().encode(descriptor.value).byteLength;
    encodedBytes += keyBytes + valueBytes + 4;
    if (
      count > MAX_BROWSER_HTTP_REQUEST_HEADERS ||
      keyBytes > MAX_BROWSER_HTTP_HEADER_NAME_BYTES ||
      valueBytes > MAX_BROWSER_HTTP_HEADER_VALUE_BYTES ||
      encodedBytes > MAX_BROWSER_HTTP_HEADERS_BYTES
    ) {
      throw browserHttpInvalid("Authenticated browser headers are oversized");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function snapshotBrowserHttpBody(value: unknown): ActiveHttpRequestBody | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw browserHttpInvalid("Authenticated browser request body is malformed");
  const kind = value.kind;
  const bodyValue = value.value;
  if (kind === "json") {
    let cloned: unknown;
    try {
      cloned = structuredClone(bodyValue);
    } catch {
      throw browserHttpInvalid("Authenticated browser JSON body cannot be cloned");
    }
    return Object.freeze({ kind, value: cloned as JsonValue });
  }
  const contentType = value.contentType;
  if (typeof contentType !== "string") {
    throw browserHttpInvalid("Authenticated browser request content type is malformed");
  }
  if (kind === "text") {
    if (typeof bodyValue !== "string") {
      throw browserHttpInvalid("Authenticated browser text body is malformed");
    }
    return Object.freeze({ kind, value: bodyValue, contentType });
  }
  if (kind === "bytes") {
    let bytes: Uint8Array;
    if (bodyValue instanceof ArrayBuffer) {
      bytes = new Uint8Array(bodyValue).slice();
    } else if (ArrayBuffer.isView(bodyValue)) {
      bytes = new Uint8Array(bodyValue.buffer, bodyValue.byteOffset, bodyValue.byteLength).slice();
    } else {
      throw browserHttpInvalid("Authenticated browser byte body is malformed");
    }
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return Object.freeze({ kind, value: buffer, contentType });
  }
  if (kind === "blob") {
    if (!(bodyValue instanceof Blob)) {
      throw browserHttpInvalid("Authenticated browser blob body is malformed");
    }
    return Object.freeze({
      kind,
      value: bodyValue.slice(0, bodyValue.size, bodyValue.type),
      contentType,
    } as ActiveHttpRequestBody);
  }
  throw browserHttpInvalid("Authenticated browser request body kind is unsupported");
}

function snapshotBrowserSessionHttpRequest(value: unknown): CapturedBrowserSessionHttpRequest {
  if (!isPlainRecord(value)) throw browserHttpInvalid("Authenticated browser request is malformed");
  const targetValue = value.target;
  const methodValue = value.method;
  const headersValue = value.headers;
  const bodyValue = value.body;
  const responseTypeValue = value.responseType;
  const maxResponseBytesValue = value.maxResponseBytes;
  const signalValue = value.signal;
  if (!isPlainRecord(targetValue)) throw browserHttpInvalid("Authenticated browser target is malformed");
  const targetKind = targetValue.kind;
  const targetPath = targetValue.path;
  if (
    (targetKind !== "selected-organization" && targetKind !== "selected-resource") ||
    typeof targetPath !== "string"
  ) {
    throw browserHttpInvalid("Authenticated browser target is malformed");
  }
  if (
    methodValue !== undefined &&
    methodValue !== "GET" &&
    methodValue !== "POST" &&
    methodValue !== "PUT" &&
    methodValue !== "PATCH" &&
    methodValue !== "DELETE"
  ) {
    throw browserHttpInvalid("Authenticated browser method is unsupported");
  }
  if (responseTypeValue !== "json" && responseTypeValue !== "text" && responseTypeValue !== "bytes") {
    throw browserHttpInvalid("Authenticated browser response type is unsupported");
  }
  if (
    maxResponseBytesValue !== undefined &&
    (typeof maxResponseBytesValue !== "number" || !Number.isSafeInteger(maxResponseBytesValue))
  ) {
    throw browserHttpInvalid("Authenticated browser response limit is malformed");
  }
  if (
    signalValue !== undefined &&
    (typeof signalValue !== "object" ||
      typeof (signalValue as AbortSignal).aborted !== "boolean" ||
      typeof (signalValue as AbortSignal).addEventListener !== "function" ||
      typeof (signalValue as AbortSignal).removeEventListener !== "function")
  ) {
    throw browserHttpInvalid("Authenticated browser signal is malformed");
  }
  return Object.freeze({
    target: Object.freeze({ kind: targetKind, path: targetPath }) as BrowserSessionHttpTarget,
    method: methodValue as ActiveHttpMethod | undefined,
    headers: snapshotBrowserHttpHeaders(headersValue),
    body: snapshotBrowserHttpBody(bodyValue),
    responseType: responseTypeValue,
    maxResponseBytes: maxResponseBytesValue as number | undefined,
    signal: signalValue as AbortSignal | undefined,
  });
}

function selectedHttpPath(target: BrowserSessionHttpTarget, organizationId: string): string {
  if (!target.path.startsWith("/") || target.path.startsWith("//")) {
    throw browserHttpInvalid("Authenticated browser path is malformed");
  }
  if (target.kind === "selected-organization") {
    return `/orgs/${encodeURIComponent(organizationId)}${target.path}`;
  }
  return target.path;
}

/**
 * Non-React owner for browser authentication, selected-organization state,
 * lifecycle fencing, and verified account purge. UI integrations subscribe to
 * its projection; they never sequence coordinator capabilities themselves.
 */
export class BrowserSessionRuntime {
  readonly #coordinator: AuthSessionCoordinator;
  readonly #registry: ContentDatabaseRegistry;
  readonly #barrier: ContentScopeBarrier;
  readonly #selectedOrganization: SelectedOrganizationController;
  readonly #indexedDB: IDBFactory | undefined;
  readonly #localStorage: BrowserSessionStorage;
  readonly #sessionStorage: BrowserSessionStorage;
  readonly #authority: BrowserSessionAuthorityProbe;
  readonly #createId: () => string;
  readonly #now: () => number;
  readonly #onDatabaseBlocked: ((databaseName: string) => void) | undefined;
  readonly #windowTarget: LifecycleEventTarget | undefined;
  readonly #documentTarget: RuntimeDocumentTarget | undefined;
  readonly #veil = new SessionVeilController("boot");
  readonly #subscribers = new Set<BrowserSessionSubscriber>();
  readonly #ownerTabId: string;
  readonly #documentId: string;
  readonly #notices: CrossDocumentNoticeTransport;

  #state: InternalState = Object.freeze({ kind: "anonymous" });
  #active: ActiveRuntime | null = null;
  #operationRevision = 0;
  #started = false;
  #disposed = false;
  #legacyScrubComplete = false;
  #legacyScrubTask: Promise<void> | null = null;
  #legacyScrubRevision = 0;
  #detachLifecycle: (() => void) | null = null;
  #detachResumeListeners: (() => void) | null = null;
  #detachVeilSubscription: () => void;
  #pendingUiRetirementEpoch: string | null = null;
  #recoveryLogoutOwner: ActivationCertificate | null = null;
  #recoveryRemount: RecoveryRemount | null = null;
  #backgroundSourceAssists = new Map<string, Promise<void>>();
  #authorityNoticeDirty = false;
  #authorityNoticeTask: Promise<void> | null = null;
  #noticeRevision = 0;
  #noticeProcessingReady = false;
  #suspended = false;
  #pendingSourceNotices = new Set<string>();
  #pendingAuthorityNotice = false;
  #hardSuspendedActive: ActiveRuntime | null = null;
  #suspendedRemount: SuspendedRemount | null = null;
  #resumeCycle = 0;
  #pendingResume: PendingResume | null = null;
  #pendingTerminalActiveMe401: PendingTerminalActiveMe401 | null = null;
  #pendingActiveHttpRefresh: PendingActiveHttpRefresh | null = null;
  #pendingTerminalActiveHttp401: PendingTerminalActiveHttp401 | null = null;
  #pendingTerminalActiveHttp401Task: Promise<PendingTerminalActiveHttp401Result> | null = null;

  public constructor(options: BrowserSessionRuntimeOptions = {}) {
    const indexedDBOption = options.indexedDB;
    const locks = options.locks;
    const localStorageOption = options.localStorage;
    const sessionStorageOption = options.sessionStorage;
    const authority = options.authority;
    const createId = options.createId;
    const now = options.now;
    const onDatabaseBlocked = options.onDatabaseBlocked;
    const windowTarget = options.windowTarget;
    const documentTarget = options.documentTarget;
    const noticeTransportFactory = options.noticeTransportFactory;
    this.#createId = createId ?? defaultCreateId;
    this.#now = now ?? Date.now;
    this.#indexedDB = indexedDBOption;
    this.#localStorage = localStorageOption ?? defaultStorage("localStorage");
    this.#sessionStorage = sessionStorageOption ?? defaultStorage("sessionStorage");
    this.#authority = authority ?? defaultAuthorityProbe();
    this.#onDatabaseBlocked = onDatabaseBlocked;
    this.#windowTarget = windowTarget ?? (typeof window === "undefined" ? undefined : window);
    this.#documentTarget = documentTarget ?? (typeof document === "undefined" ? undefined : document);
    const coordinatorOptions: CoordinatorOptions = {
      ...(indexedDBOption === undefined ? {} : { indexedDB: indexedDBOption }),
      ...(onDatabaseBlocked === undefined ? {} : { onBlocked: onDatabaseBlocked }),
      legacyPersistence: {
        localStorage: this.#localStorage,
        sessionStorage: this.#sessionStorage,
        ...(indexedDBOption === undefined ? {} : { indexedDB: indexedDBOption }),
        ...(onDatabaseBlocked === undefined ? {} : { onDatabaseBlocked }),
      },
    };
    this.#coordinator = new AuthSessionCoordinator(coordinatorOptions);
    this.#registry = new ContentDatabaseRegistry();
    this.#barrier = new ContentScopeBarrier({
      coordinator: this.#coordinator,
      registry: this.#registry,
      ...(indexedDBOption === undefined ? {} : { indexedDB: indexedDBOption }),
      ...(locks === undefined ? {} : { locks }),
    });
    const store = new AccountStateStore();
    this.#selectedOrganization = new SelectedOrganizationController({
      store,
      barrier: this.#barrier,
      ...(locks === undefined ? {} : { locks }),
      ...(now === undefined ? {} : { now }),
      createRevision: () => opaqueId(this.#createId, "Organization revision"),
    });
    this.#ownerTabId = ownerTabId(this.#sessionStorage, this.#createId);
    this.#documentId = opaqueId(this.#createId, "Document id");
    this.#detachVeilSubscription = this.#veil.subscribe(() => this.#emit());
    const installNotices: BrowserSessionNoticeTransportFactory =
      noticeTransportFactory ??
      ((onNotice) =>
        installCrossDocumentAuthNotices({
          localStorage: this.#localStorage,
          onNotice,
          ...(this.#windowTarget === undefined ? {} : { windowTarget: this.#windowTarget }),
          createId: this.#createId,
        }));
    const noticesDuringInstall: CrossDocumentAuthNotice[] = [];
    let noticeHandlerReady = false;
    const transport = installNotices((notice) => {
      if (!noticeHandlerReady) {
        if (noticesDuringInstall.length < 256) noticesDuringInstall.push(notice);
        return;
      }
      this.#onCrossDocumentNotice(notice);
    });
    this.#notices = captureNoticeTransport(transport);
    noticeHandlerReady = true;
    for (const notice of noticesDuringInstall) this.#onCrossDocumentNotice(notice);
  }

  public getProjection(): BrowserSessionProjection {
    const veil = this.#veil.getSnapshot();
    if (veil.veiled && this.#state.kind !== "recovery") {
      return Object.freeze({ kind: "veiled", reason: veil.reason, revision: veil.revision });
    }
    return this.#state;
  }

  public subscribe(subscriber: BrowserSessionSubscriber): () => void {
    if (typeof subscriber !== "function") throw new TypeError("Browser session subscriber must be a function");
    this.#subscribers.add(subscriber);
    try {
      subscriber(this.getProjection());
    } catch (error) {
      this.#subscribers.delete(subscriber);
      throw error;
    }
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.#subscribers.delete(subscriber);
    };
  }

  /**
   * Captures an opaque HTTP facade for the exact selected account/org view.
   * The closure intentionally exposes neither the view lease nor coordinator
   * capabilities. It survives only routine credential rotation; navigation,
   * account replacement, logout, or hard suspension permanently stales it.
   */
  public captureActiveHttp(): BrowserSessionHttpFacade {
    const owner = this.#captureActiveHttpOwner();
    return Object.freeze({
      request: (inputValue: BrowserSessionHttpRequest): Promise<ActiveHttpResponse> => {
        // An async callee would otherwise defer these reads until a later
        // microtask. Snapshot all caller-controlled input in this synchronous
        // closure before the first await or authority check.
        const input = snapshotBrowserSessionHttpRequest(inputValue);
        return this.#requestActiveHttpOwned(owner, input);
      },
    });
  }

  public async start(): Promise<BrowserSessionProjection> {
    if (this.#disposed) throw new SessionError(sessionErrorCodes.staleOperation, "Browser session runtime is disposed");
    if (!this.#started) this.#installLifecycle();
    for (let attempts = 0; attempts < MAX_RECONCILIATION_ATTEMPTS; attempts += 1) {
      const operation = this.#begin("boot", true);
      try {
        await this.#ensureBootLegacyScrub();
        this.#assertCurrent(operation);
        const initialGeneration = this.#freshGeneration("anonymous");
        await this.#coordinator.bootstrapAnonymous(initialGeneration);
        this.#assertCurrent(operation);
        const authority = await this.#coordinator.readAuthority();
        this.#assertCurrent(operation);
        this.#recoveryLogoutOwner = authoritySource(authority);
        await this.#convergeAuthority(authority, operation, false);
        this.#finishNoticeFence(operation);
        return this.getProjection();
      } catch (error) {
        if (this.#noticeFenceChanged(operation) && !this.#suspended && !this.#disposed) continue;
        this.#fail(operation, error);
        if (this.#legacyScrubComplete && !this.#suspended) this.#releaseNoticeGateAndDrain();
        return this.getProjection();
      }
    }
    const operation = this.#begin("boot_recovery", true);
    const error = new SessionError(sessionErrorCodes.recoveryRequired, "Browser session boot did not converge");
    this.#fail(operation, error);
    if (!this.#suspended) this.#releaseNoticeGateAndDrain();
    return this.getProjection();
  }

  public async refresh(): Promise<BrowserSessionProjection> {
    const active = this.#requireActive();
    const operation = this.#begin("account_reconciliation");
    try {
      const reconciled = await this.#reconcileSelection(
        active.projection.accountLease,
        "refresh",
        active.projection.publication.state,
        null,
        operation,
      );
      const session = await this.#coordinator.readActiveSession();
      this.#assertCurrent(operation);
      if (!sameActivation(session.authority.session, active.projection.activation)) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Account changed during reconciliation");
      }
      this.#publishActive(
        active,
        session,
        reconciled,
        operation,
        !sameCredentialCursor(active.projection.credential, session.credential),
      );
      return this.getProjection();
    } catch (error) {
      return this.#restoreActiveOrFail(active, operation, error);
    }
  }

  public async switchOrganization(organizationId: string): Promise<BrowserSessionProjection> {
    const active = this.#requireActive();
    const requestedOrganizationId = organizationId;
    const operation = this.#begin("organization_reconciliation");
    try {
      const reconciled = await this.#reconcileSelection(
        active.projection.accountLease,
        "switch",
        active.projection.publication.state,
        requestedOrganizationId,
        operation,
      );
      const session = await this.#coordinator.readActiveSession();
      this.#assertCurrent(operation);
      if (!sameActivation(session.authority.session, active.projection.activation)) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Account changed during organization switch");
      }
      this.#publishActive(
        active,
        session,
        reconciled,
        operation,
        !sameCredentialCursor(active.projection.credential, session.credential),
      );
      return this.getProjection();
    } catch (error) {
      return this.#restoreActiveOrFail(active, operation, error);
    }
  }

  public resume(): Promise<BrowserSessionProjection> {
    if (this.#documentTarget?.visibilityState === "hidden") return Promise.resolve(this.getProjection());
    const cycle = this.#resumeCycle;
    const pending = this.#pendingResume;
    if (pending?.cycle === cycle) return pending.promise;

    const start = (): Promise<BrowserSessionProjection> => {
      if (this.#documentTarget?.visibilityState === "hidden") return Promise.resolve(this.getProjection());
      return this.#resumeOnce();
    };
    const promise = pending ? pending.promise.then(start, start) : start();
    const task = Object.freeze({ cycle, promise });
    this.#pendingResume = task;
    const clear = (): void => {
      if (this.#pendingResume === task) this.#pendingResume = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  async #resumeOnce(): Promise<BrowserSessionProjection> {
    const hardSuspendedActive = this.#hardSuspendedActive;
    this.#suspended = false;
    for (let attempts = 0; attempts < MAX_RECONCILIATION_ATTEMPTS; attempts += 1) {
      const active = this.#active ?? hardSuspendedActive;
      const operation = this.#begin("lifecycle_reconciliation", !this.#noticeProcessingReady);
      if (active) this.#recoveryLogoutOwner = active.activation;
      try {
        await this.#ensureBootLegacyScrub();
        this.#assertCurrent(operation);
        const pendingHttpRetirement = await this.#retryPendingTerminalActiveHttp401();
        if (pendingHttpRetirement) {
          await this.#convergeActiveHttpRetirement(pendingHttpRetirement.source, pendingHttpRetirement.retirement);
          return this.getProjection();
        }
        const pendingRetirement = await this.#retryPendingTerminalActiveMe401();
        if (pendingRetirement) {
          if (pendingRetirement.retirement === "superseded") {
            const authority = await this.#coordinator.readAuthority();
            this.#assertCurrent(operation);
            await this.#convergeAuthority(authority, operation, false);
            this.#finishNoticeFence(operation);
          } else {
            await this.#convergeCommittedOwned401(pendingRetirement.source);
          }
          return this.getProjection();
        }
        if (!this.#noticeProcessingReady) {
          const durable = await this.#coordinator.readAuthority();
          this.#assertCurrent(operation);
          if (!active || durable.mode !== "active" || !sameActivation(durable.session, active.activation)) {
            if (this.#active) this.#retireLocalActive(this.#active);
            await this.#convergeAuthority(durable, operation, true);
            this.#finishNoticeFence(operation);
            return this.getProjection();
          }
          const durableSession = await this.#coordinator.readActiveSession();
          this.#assertCurrent(operation);
          if (!sameCredentialCursor(durableSession.credential, active.projection.credential)) {
            this.#retireLocalActive(active);
            await this.#convergeAuthority(durableSession.authority, operation, true, undefined, active.activation);
            this.#finishNoticeFence(operation);
            return this.getProjection();
          }
        }
        if (!active) {
          const authority = await this.#coordinator.readAuthority();
          this.#assertCurrent(operation);
          await this.#convergeAuthority(authority, operation, true);
          this.#finishNoticeFence(operation);
          return this.getProjection();
        }
        let authority: ServerAuthorityReconciliation;
        try {
          authority = await this.#authority.reconcile(active.projection.activation.serverAuthority);
        } catch (error) {
          this.#assertCurrent(operation);
          if (this.#active === active) {
            this.#recoveryRemount = Object.freeze({
              activation: active.activation,
              expectedState: active.projection.publication.state,
            });
            this.#retireLocalActive(active);
            this.#registry.invalidateEpoch(active.activation.sessionEpoch);
          }
          throw error;
        }
        this.#assertCurrent(operation);
        if (authority.kind === "mismatch") {
          await this.#retireServerMismatch(active.projection.activation, operation, true);
          this.#finishNoticeFence(operation);
          return this.getProjection();
        }
        if (authority.kind === "unavailable") {
          const session = await this.#coordinator.readActiveSession();
          this.#assertCurrent(operation);
          if (
            !sameActivation(session.authority.session, active.projection.activation) ||
            !sameCredentialCursor(session.credential, active.projection.credential)
          ) {
            throw new SessionError(sessionErrorCodes.staleOperation, "Offline account authority changed");
          }
          const accountRuntime = captureAccountStoreRuntime(active.projection.accountLease);
          const view = active.projection.publication.viewLease;
          const contentRuntime = view ? captureContentStoreRuntime(view) : null;
          if (accountRuntime && (view === null || contentRuntime)) {
            this.#publishActive(
              active,
              session,
              Object.freeze({ me: active.projection.me, publication: active.projection.publication }),
              operation,
              false,
            );
            this.#finishNoticeFence(operation);
            return this.getProjection();
          }
          if (hardSuspendedActive !== active || accountRuntime !== null || (view !== null && contentRuntime !== null)) {
            throw new SessionError(
              sessionErrorCodes.recoveryRequired,
              "Offline resume has no exact hard-suspended account view",
            );
          }
          const suspendedPublication = active.projection.publication;
          const suspendedMe = active.projection.me;
          this.#recoveryRemount = Object.freeze({
            activation: active.activation,
            expectedState: suspendedPublication.state,
          });
          this.#retireLocalActive(active);
          const handle = this.#installAccountRuntime(active.activation);
          const suspendedRemount = Object.freeze({
            handle,
            session,
            me: suspendedMe,
          });
          this.#suspendedRemount = suspendedRemount;
          try {
            const publication = await this.#selectedOrganization.rebindSuspendedPublication({
              lease: handle.accountLease,
              publication: suspendedPublication,
            });
            this.#assertCurrent(operation);
            const currentSession = await this.#coordinator.readActiveSession();
            this.#assertCurrent(operation);
            if (
              !sameActivation(currentSession.authority.session, active.activation) ||
              !sameCredentialCursor(currentSession.credential, session.credential)
            ) {
              throw new SessionError(sessionErrorCodes.staleOperation, "Offline account changed before publication");
            }
            const finalAuthority = await this.#authority.reconcile(active.projection.activation.serverAuthority);
            this.#assertCurrent(operation);
            const finalAuthorityMatches =
              (finalAuthority.kind === "match" &&
                finalAuthority.authority === active.projection.activation.serverAuthority) ||
              (finalAuthority.kind === "unavailable" &&
                finalAuthority.expected === active.projection.activation.serverAuthority);
            if (!finalAuthorityMatches) {
              const mismatch = new SessionError(
                sessionErrorCodes.admissionDenied,
                "Server authority changed during offline account restoration",
              );
              this.#retireAccountHandle(handle, mismatch);
              await this.#retireServerMismatch(active.activation, operation, true);
              this.#finishNoticeFence(operation);
              return this.getProjection();
            }
            const deliverySession = await this.#coordinator.readActiveSession();
            this.#assertCurrent(operation);
            if (
              !sameActivation(deliverySession.authority.session, active.activation) ||
              !sameCredentialCursor(deliverySession.credential, currentSession.credential)
            ) {
              throw new SessionError(
                sessionErrorCodes.staleOperation,
                "Offline account changed during the final authority check",
              );
            }
            await this.#selectedOrganization.assertPublicationCurrent(handle.accountLease, publication);
            this.#assertCurrent(operation);
            this.#publishActive(
              handle,
              deliverySession,
              Object.freeze({ me: suspendedMe, publication }),
              operation,
              false,
            );
            this.#recoveryRemount = null;
          } catch (error) {
            this.#retireAccountHandle(handle, error);
            const latestPublication = this.#selectedOrganization.readCurrentPublication();
            this.#recoveryRemount = Object.freeze({
              activation: active.activation,
              expectedState: latestPublication?.state ?? suspendedPublication.state,
            });
            throw error;
          } finally {
            if (this.#suspendedRemount === suspendedRemount) this.#suspendedRemount = null;
          }
          this.#finishNoticeFence(operation);
          return this.getProjection();
        }
        const accountRuntime = captureAccountStoreRuntime(active.projection.accountLease);
        const viewLease = active.projection.publication.viewLease;
        const contentRuntime = viewLease === null ? true : captureContentStoreRuntime(viewLease) !== null;
        if (!accountRuntime || !contentRuntime) {
          const expectedState = active.projection.publication.state;
          const activation = active.projection.activation;
          this.#retireLocalActive(active);
          await this.#mountActive(activation, operation, expectedState, true);
          this.#finishNoticeFence(operation);
          return this.getProjection();
        }
        const reconciled = await this.#reconcileSelection(
          active.projection.accountLease,
          "refresh",
          active.projection.publication.state,
          null,
          operation,
        );
        const session = await this.#coordinator.readActiveSession();
        this.#assertCurrent(operation);
        this.#publishActive(
          active,
          session,
          reconciled,
          operation,
          !sameCredentialCursor(active.projection.credential, session.credential),
        );
        this.#finishNoticeFence(operation);
        return this.getProjection();
      } catch (error) {
        if (this.#noticeFenceChanged(operation) && !this.#suspended && !this.#disposed) continue;
        if (active && isServerMismatchFailure(error)) {
          try {
            await this.#retireServerMismatch(active.activation, operation, true);
            this.#finishNoticeFence(operation);
            return this.getProjection();
          } catch (retirementError) {
            this.#fail(operation, retirementError);
            if (!this.#suspended) this.#releaseNoticeGateAndDrain();
            return this.getProjection();
          }
        }
        this.#fail(operation, error);
        if (!this.#suspended) this.#releaseNoticeGateAndDrain();
        return this.getProjection();
      }
    }
    const operation = this.#begin("lifecycle_recovery", true);
    this.#fail(
      operation,
      new SessionError(sessionErrorCodes.recoveryRequired, "Lifecycle reconciliation did not converge"),
    );
    if (!this.#suspended) this.#releaseNoticeGateAndDrain();
    return this.getProjection();
  }

  public async logout(): Promise<BrowserSessionLogoutResult> {
    const captured = this.#active;
    const operation = this.#begin("logout");
    let pendingEpoch = captured?.projection.activation.sessionEpoch ?? null;
    if (captured) {
      this.#recoveryLogoutOwner = captured.projection.activation;
      this.#pendingUiRetirementEpoch = pendingEpoch;
      this.#retireLocalActive(captured);
    }
    try {
      if (!captured) {
        const authority = await this.#coordinator.readAuthority();
        this.#assertCurrent(operation);
        const result = await this.#logoutAuthoritativeState(
          authority,
          operation,
          (epoch) => {
            pendingEpoch = epoch;
            this.#pendingUiRetirementEpoch = epoch;
          },
          this.#recoveryLogoutOwner,
        );
        return result;
      }

      const result = await this.#coordinator.beginRetirement(
        captured.projection.activation,
        "logout",
        this.#freshGeneration("logout"),
      );
      this.#assertCurrent(operation);
      if (result === "superseded") {
        await this.#runLogoutLegacyScrub(operation);
        const authority = await this.#coordinator.readAuthority();
        this.#assertCurrent(operation);
        await this.#convergeLogoutSuperseded(authority, operation, captured.projection.activation);
        this.#releaseNoticeGateAndDrain();
        return "superseded";
      }
      const sourceNoticeDelivered = this.#announceSourceRetired(captured.projection.activation);
      const completion = await this.#finishRetirement(captured.projection.activation, undefined, operation);
      if (completion.kind === "superseded") {
        await this.#runLogoutLegacyScrub(operation);
        await this.#convergeLogoutSuperseded(completion.authority, operation, captured.projection.activation);
        this.#assertSourceNoticeDelivered(sourceNoticeDelivered);
        this.#releaseNoticeGateAndDrain();
        return "superseded";
      }
      this.#publishAnonymous(operation, true, sourceNoticeDelivered);
      this.#releaseNoticeGateAndDrain();
      return "completed";
    } catch (error) {
      this.#fail(operation, error);
      throw error;
    } finally {
      if (pendingEpoch !== null && this.#pendingUiRetirementEpoch === pendingEpoch)
        this.#pendingUiRetirementEpoch = null;
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#noticeProcessingReady = false;
    this.#suspended = true;
    this.#operationRevision += 1;
    this.#veil.begin("disposed");
    if (this.#active) this.#retireLocalActive(this.#active);
    this.#detachLifecycle?.();
    this.#detachLifecycle = null;
    this.#detachResumeListeners?.();
    this.#detachResumeListeners = null;
    this.#notices.dispose();
    this.#detachVeilSubscription();
    this.#hardSuspendedActive = null;
    this.#suspendedRemount = null;
    this.#pendingTerminalActiveMe401 = null;
    this.#pendingActiveHttpRefresh = null;
    this.#pendingTerminalActiveHttp401 = null;
    this.#pendingTerminalActiveHttp401Task = null;
    this.#subscribers.clear();
  }

  #installLifecycle(): void {
    this.#started = true;
    const onSuspend = (): void => {
      if (this.#disposed) return;
      const active = this.#active;
      if (active) {
        this.#hardSuspendedActive = active;
      } else {
        const remount = this.#suspendedRemount;
        const publication = remount ? this.#selectedOrganization.readCurrentPublication() : null;
        if (
          remount &&
          publication &&
          (publication.viewLease === null ||
            sameActivation(publication.viewLease.activation, remount.handle.activation))
        ) {
          this.#hardSuspendedActive = this.#captureSuspendedRemount(remount, publication);
        }
      }
      this.#suspended = true;
      this.#noticeProcessingReady = false;
    };
    this.#windowTarget?.addEventListener("pagehide", onSuspend, { capture: true });
    this.#documentTarget?.addEventListener("freeze", onSuspend, { capture: true });
    const onVeil = (): void => {
      if (this.#disposed) return;
      this.#resumeCycle += 1;
      this.#operationRevision += 1;
      this.#veil.begin("lifecycle_suspended");
    };
    const onLegacyStorageScrub = (): void => {
      scrubLegacyWebStorage({ localStorage: this.#localStorage, sessionStorage: this.#sessionStorage });
    };
    const onLifecycleError = (error: unknown): void => {
      this.#state = Object.freeze({ kind: "recovery", reason: recoveryReason(error) });
      this.#emit();
    };
    const detachSessionLifecycle = installSessionLifecycleHooks({
      registry: this.#registry,
      ...(this.#windowTarget === undefined ? {} : { windowTarget: this.#windowTarget }),
      ...(this.#documentTarget === undefined ? {} : { documentTarget: this.#documentTarget }),
      onVeil,
      onLegacyStorageScrub,
      onLifecycleError,
    });
    this.#detachLifecycle = () => {
      this.#windowTarget?.removeEventListener("pagehide", onSuspend, { capture: true });
      this.#documentTarget?.removeEventListener("freeze", onSuspend, { capture: true });
      detachSessionLifecycle();
    };

    const resume = (): void => {
      if (this.#disposed || this.#documentTarget?.visibilityState === "hidden") return;
      this.#suspended = false;
      void this.resume();
    };
    this.#windowTarget?.addEventListener("pageshow", resume);
    this.#documentTarget?.addEventListener("visibilitychange", resume);
    this.#detachResumeListeners = () => {
      this.#windowTarget?.removeEventListener("pageshow", resume);
      this.#documentTarget?.removeEventListener("visibilitychange", resume);
    };
  }

  async #scrubLegacy(): Promise<void> {
    const options: LegacyScrubOptions = {
      localStorage: this.#localStorage,
      sessionStorage: this.#sessionStorage,
      ...(this.#indexedDB === undefined ? {} : { indexedDB: this.#indexedDB }),
      ...(this.#onDatabaseBlocked === undefined ? {} : { onDatabaseBlocked: this.#onDatabaseBlocked }),
    };
    await scrubLegacyPersistence(options);
  }

  async #ensureBootLegacyScrub(): Promise<void> {
    if (this.#legacyScrubComplete) return;
    await (this.#legacyScrubTask ?? this.#startLegacyScrubCycle());
  }

  #startLegacyScrubCycle(): Promise<void> {
    return this.#queueLegacyScrub(() => this.#scrubLegacy());
  }

  #startAnonymousCleaningCycle(cleaning: AuthAuthority, anonymousGeneration: string): Promise<void> {
    return this.#queueLegacyScrub(() => this.#coordinator.completeAnonymousCleanup(cleaning, anonymousGeneration));
  }

  #queueLegacyScrub(work: () => Promise<void>): Promise<void> {
    const revision = this.#legacyScrubRevision + 1;
    this.#legacyScrubRevision = revision;
    this.#legacyScrubComplete = false;
    this.#noticeProcessingReady = false;
    const prior = this.#legacyScrubTask;
    const task = (prior ? prior.catch(() => undefined) : Promise.resolve())
      .then(work)
      .then(() => {
        if (this.#legacyScrubRevision === revision) this.#legacyScrubComplete = true;
      })
      .finally(() => {
        if (this.#legacyScrubTask === task) this.#legacyScrubTask = null;
      });
    this.#legacyScrubTask = task;
    return task;
  }

  async #runLogoutLegacyScrub(operation: RuntimeOperation): Promise<void> {
    // Start the cleanup immediately after the decisive authority CAS. It must
    // outlive this operation if pagehide/freeze supersedes the caller.
    const task = this.#startLegacyScrubCycle();
    this.#assertCurrent(operation);
    await task;
    this.#assertCurrent(operation);
  }

  async #logoutAuthoritativeState(
    authorityValue: AuthAuthority,
    operation: RuntimeOperation,
    setPendingEpoch: (epoch: string) => void,
    recoveryOwner: ActivationCertificate | null,
  ): Promise<BrowserSessionLogoutResult> {
    this.#assertCurrent(operation);
    let authority = authorityValue;

    if (authority.mode === "none") {
      if (recoveryOwner !== null) {
        await this.#runLogoutLegacyScrub(operation);
        this.#releaseNoticeGateAndDrain();
        return "superseded";
      }
      const cancellation = await this.#coordinator.cancelAnonymousAuthority(
        authority,
        this.#freshGeneration("logout-anonymous"),
      );
      this.#assertCurrent(operation);
      if (cancellation.kind === "superseded") {
        authority = cancellation.authority;
        if (authority.mode === "none") {
          await this.#runLogoutLegacyScrub(operation);
          this.#releaseNoticeGateAndDrain();
          return "superseded";
        }
      } else {
        const completion = await this.#finishAnonymousCleaning(cancellation.authority, operation);
        if (completion.kind === "superseded") {
          await this.#convergeLogoutSuperseded(completion.authority, operation, recoveryOwner);
          this.#releaseNoticeGateAndDrain();
          return "superseded";
        }
        this.#publishAnonymous(operation, true);
        this.#releaseNoticeGateAndDrain();
        return "completed";
      }
    }

    if (authority.mode === "cleaning") {
      const completion = await this.#finishAnonymousCleaning(authority, operation);
      if (completion.kind === "superseded") {
        await this.#convergeLogoutSuperseded(completion.authority, operation, recoveryOwner);
        this.#releaseNoticeGateAndDrain();
        return "superseded";
      }
      if (recoveryOwner !== null) {
        this.#releaseNoticeGateAndDrain();
        return "superseded";
      }
      this.#publishAnonymous(operation, true);
      this.#releaseNoticeGateAndDrain();
      return "completed";
    }

    if (authority.mode === "transition") {
      const ownsTransitionSource =
        recoveryOwner === null
          ? authority.source === null
          : authority.source !== null && sameActivation(recoveryOwner, authority.source);
      if (!ownsTransitionSource) {
        await this.#runLogoutLegacyScrub(operation);
        this.#releaseNoticeGateAndDrain();
        return "superseded";
      }
      const cancellation = await this.#coordinator.cancelAcquisitionTransition(
        authority.permit,
        this.#freshGeneration("logout-transition-cancel"),
      );
      this.#assertCurrent(operation);
      if (cancellation.kind === "superseded") {
        await this.#runLogoutLegacyScrub(operation);
        await this.#convergeLogoutSuperseded(cancellation.authority, operation, recoveryOwner);
        this.#releaseNoticeGateAndDrain();
        return "superseded";
      }
      if (cancellation.kind === "cleaning") {
        const completion = await this.#finishAnonymousCleaning(cancellation.authority, operation);
        if (completion.kind === "superseded") {
          await this.#convergeLogoutSuperseded(completion.authority, operation, recoveryOwner);
          this.#releaseNoticeGateAndDrain();
          return "superseded";
        }
        this.#publishAnonymous(operation, true);
        this.#releaseNoticeGateAndDrain();
        return "completed";
      }
      authority = cancellation.authority;
    }

    let source: ActivationCertificate;
    let existingReceipt: string | undefined;
    if (authority.mode === "active") {
      if (recoveryOwner === null || !sameActivation(recoveryOwner, authority.session)) {
        await this.#runLogoutLegacyScrub(operation);
        await this.#convergeLogoutSuperseded(authority, operation, recoveryOwner);
        this.#releaseNoticeGateAndDrain();
        return "superseded";
      }
      source = authority.session;
      const retirement = await this.#coordinator.beginRetirement(source, "logout", this.#freshGeneration("logout"));
      this.#assertCurrent(operation);
      if (retirement === "superseded") {
        await this.#runLogoutLegacyScrub(operation);
        const current = await this.#coordinator.readAuthority();
        this.#assertCurrent(operation);
        await this.#convergeLogoutSuperseded(current, operation, recoveryOwner);
        this.#releaseNoticeGateAndDrain();
        return "superseded";
      }
    } else if (authority.mode === "retiring") {
      if (recoveryOwner === null || !sameActivation(recoveryOwner, authority.source)) {
        await this.#runLogoutLegacyScrub(operation);
        this.#releaseNoticeGateAndDrain();
        return "superseded";
      }
      source = authority.source;
      existingReceipt = authority.cleanupReceipt;
    } else {
      throw new SessionError(sessionErrorCodes.recoveryRequired, "Logout authority did not retire its exact source");
    }

    setPendingEpoch(source.sessionEpoch);
    this.#registry.invalidateEpoch(source.sessionEpoch);
    const sourceNoticeDelivered = this.#announceSourceRetired(source);
    const completion = await this.#finishRetirement(source, existingReceipt, operation);
    if (completion.kind === "superseded") {
      await this.#runLogoutLegacyScrub(operation);
      await this.#convergeLogoutSuperseded(completion.authority, operation, source);
      this.#assertSourceNoticeDelivered(sourceNoticeDelivered);
      this.#releaseNoticeGateAndDrain();
      return "superseded";
    }
    this.#publishAnonymous(operation, true, sourceNoticeDelivered);
    this.#releaseNoticeGateAndDrain();
    return "completed";
  }

  async #convergeLogoutSuperseded(
    authority: AuthAuthority,
    operation: RuntimeOperation,
    cleanupOwner: ActivationCertificate | null,
  ): Promise<void> {
    await this.#convergeAuthority(authority, operation, false, undefined, undefined, cleanupOwner);
  }

  async #convergeAuthority(
    authorityValue: AuthAuthority,
    operation: RuntimeOperation,
    revalidatePinnedAuthority: boolean,
    sourceNoticeEvidence?: Readonly<{ sessionEpoch: string; delivered: boolean }>,
    mismatchOwner?: ActivationCertificate,
    cleanupOwner?: ActivationCertificate | null,
  ): Promise<void> {
    let authority = authorityValue;
    for (let attempts = 0; attempts < MAX_RECONCILIATION_ATTEMPTS; attempts += 1) {
      let carriedSourceNoticeDelivered: boolean | undefined;
      this.#assertCurrent(operation);
      if (authority.mode === "none") {
        if (cleanupOwner !== undefined && cleanupOwner !== null) return;
        this.#publishAnonymous(operation, false, sourceNoticeEvidence?.delivered ?? true);
        return;
      }
      if (authority.mode === "cleaning") {
        const completion = await this.#finishAnonymousCleaning(authority, operation);
        if (completion.kind === "superseded") {
          authority = completion.authority;
          continue;
        }
        if (cleanupOwner !== undefined && cleanupOwner !== null) return;
        this.#publishAnonymous(operation, true, sourceNoticeEvidence?.delivered ?? true);
        this.#releaseNoticeGateAndDrain();
        return;
      }
      if (authority.mode === "active") {
        const observed = await this.#authority.pin();
        this.#assertCurrent(operation);
        let mismatch = observed !== authority.session.serverAuthority;
        if (!mismatch && revalidatePinnedAuthority) {
          const reconciliation = await this.#authority.reconcile(authority.session.serverAuthority);
          this.#assertCurrent(operation);
          mismatch = reconciliation.kind === "mismatch";
          if (reconciliation.kind === "unavailable") {
            throw new SessionError(
              sessionErrorCodes.recoveryRequired,
              "A suspended active session requires online identity reconciliation",
            );
          }
        }
        if (mismatch) {
          if (!mismatchOwner || !sameActivation(mismatchOwner, authority.session)) {
            throw new SessionError(
              sessionErrorCodes.recoveryRequired,
              "This document does not own the mismatched durable session",
            );
          }
          if (this.#active && sameActivation(this.#active.projection.activation, authority.session)) {
            this.#retireLocalActive(this.#active);
          }
          const retirement = await this.#coordinator.beginRetirement(
            authority.session,
            "server_mismatch",
            this.#freshGeneration("server-mismatch"),
          );
          this.#assertCurrent(operation);
          if (retirement === "superseded") {
            authority = await this.#coordinator.readAuthority();
            this.#assertCurrent(operation);
            continue;
          }
          const sourceNoticeDelivered = this.#announceSourceRetired(authority.session);
          const completion = await this.#finishRetirement(authority.session, undefined, operation);
          if (completion.kind === "superseded") {
            authority = completion.authority;
            this.#assertSourceNoticeDelivered(sourceNoticeDelivered);
            continue;
          }
          this.#publishAnonymous(operation, true, sourceNoticeDelivered);
          return;
        }
        const freshAuthority = await this.#coordinator.readAuthority();
        this.#assertCurrent(operation);
        if (
          freshAuthority.mode !== "active" ||
          freshAuthority.revision !== authority.revision ||
          !sameActivation(freshAuthority.session, authority.session)
        ) {
          authority = freshAuthority;
          continue;
        }
        if (this.#active) this.#retireLocalActive(this.#active);
        const recoveryRemount = this.#recoveryRemount;
        if (recoveryRemount && !sameActivation(recoveryRemount.activation, authority.session)) {
          this.#recoveryRemount = null;
        }
        const expectedState =
          recoveryRemount && sameActivation(recoveryRemount.activation, authority.session)
            ? recoveryRemount.expectedState
            : undefined;
        await this.#mountActive(authority.session, operation, expectedState, expectedState !== undefined);
        if (this.#active && sameActivation(this.#active.activation, authority.session)) this.#recoveryRemount = null;
        return;
      }
      if (authority.mode === "transition") {
        const ownsTransitionSource =
          cleanupOwner === undefined ||
          (cleanupOwner === null
            ? authority.source === null
            : authority.source !== null && sameActivation(cleanupOwner, authority.source));
        if (!ownsTransitionSource) return;
        if (authority.permit.expiresAt > this.#now()) {
          if (authority.source !== null) {
            const sourceNoticeDelivered =
              sourceNoticeEvidence?.sessionEpoch === authority.source.sessionEpoch
                ? sourceNoticeEvidence.delivered
                : this.#announceSourceRetired(authority.source);
            const phaseBeforePurge = authority.phase;
            await this.#barrier.purgeAccountScope(authority.source, {
              localStorage: this.#localStorage,
              sessionStorage: this.#sessionStorage,
              ...(this.#onDatabaseBlocked === undefined ? {} : { onBlocked: this.#onDatabaseBlocked }),
            });
            this.#assertCurrent(operation);
            if (phaseBeforePurge !== "source_purged") this.#announceAuthorityAdvanced();
            this.#assertSourceNoticeDelivered(sourceNoticeDelivered);
          }
          return;
        }
        const cancellation = await this.#coordinator.cancelAcquisitionTransition(
          authority.permit,
          this.#freshGeneration("transition-cancel"),
        );
        this.#assertCurrent(operation);
        if (cancellation.kind === "superseded") {
          authority = cancellation.authority;
          continue;
        }
        if (cancellation.kind === "cleaning") {
          const completion = await this.#finishAnonymousCleaning(cancellation.authority, operation);
          if (completion.kind === "superseded") {
            authority = completion.authority;
            continue;
          }
          this.#publishAnonymous(operation, true, sourceNoticeEvidence?.delivered ?? true);
          this.#releaseNoticeGateAndDrain();
          return;
        }
        carriedSourceNoticeDelivered = this.#announceSourceRetired(cancellation.source);
        authority = cancellation.authority;
      }
      if (authority.mode === "retiring") {
        if (cleanupOwner !== undefined && (cleanupOwner === null || !sameActivation(cleanupOwner, authority.source))) {
          return;
        }
        const sourceNoticeDelivered =
          carriedSourceNoticeDelivered ??
          (sourceNoticeEvidence?.sessionEpoch === authority.source.sessionEpoch
            ? sourceNoticeEvidence.delivered
            : this.#announceSourceRetired(authority.source));
        const completion = await this.#finishRetirement(authority.source, authority.cleanupReceipt, operation);
        if (completion.kind === "superseded") {
          authority = completion.authority;
          this.#assertSourceNoticeDelivered(sourceNoticeDelivered);
          continue;
        }
        this.#publishAnonymous(operation, true, sourceNoticeDelivered);
        return;
      }
    }
    throw new SessionError(sessionErrorCodes.recoveryRequired, "Browser session did not converge");
  }

  async #mountActive(
    activation: ActivationCertificate,
    operation: RuntimeOperation,
    expectedState: SelectedOrganizationState | undefined,
    rotateObservedRevision: boolean,
  ): Promise<void> {
    this.#assertNoticeTransportAvailable();
    const session = await this.#coordinator.readActiveSession();
    this.#assertCurrent(operation);
    if (!sameActivation(session.authority.session, activation)) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Active session changed during boot");
    }
    const handle = this.#installAccountRuntime(activation);
    try {
      const reconciled = await this.#reconcileSelection(
        handle.accountLease,
        "initialize",
        expectedState,
        null,
        operation,
        rotateObservedRevision,
      );
      const currentSession = await this.#coordinator.readActiveSession();
      this.#assertCurrent(operation);
      if (!sameActivation(currentSession.authority.session, activation)) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Active session changed before boot publication");
      }
      this.#publishActive(
        handle,
        currentSession,
        reconciled,
        operation,
        !sameCredentialCursor(session.credential, currentSession.credential),
      );
    } catch (error) {
      this.#retireAccountHandle(handle, error);
      if (isServerMismatchFailure(error)) {
        await this.#retireServerMismatch(activation, operation, false);
        return;
      }
      if (await this.#recoverOwned401(activation, operation, error)) return;
      throw error;
    }
  }

  #installAccountRuntime(activation: ActivationCertificate): AccountRuntimeHandle {
    const sourceController = new AbortController();
    const accountLease = createAccountLease({
      activation,
      accountRevision: opaqueId(this.#createId, "Account revision"),
      ownerTabId: this.#ownerTabId,
      documentId: this.#documentId,
      signal: sourceController.signal,
    });
    const disposeAccountRuntime = installAccountStoreRuntime({ barrier: this.#barrier, lease: accountLease });
    return Object.freeze({
      activation,
      accountLease,
      sourceController,
      disposeAccountRuntime,
    });
  }

  #captureSuspendedRemount(remount: SuspendedRemount, publication: SelectedOrganizationPublication): ActiveRuntime {
    const projection: BrowserSessionActiveProjection = Object.freeze({
      kind: "active",
      activation: remount.handle.activation,
      accountLease: remount.handle.accountLease,
      credential: remount.session.credential,
      me: remount.me,
      publication,
    });
    return Object.freeze({
      activation: remount.handle.activation,
      accountLease: remount.handle.accountLease,
      sourceController: remount.handle.sourceController,
      disposeAccountRuntime: remount.handle.disposeAccountRuntime,
      projection,
    });
  }

  #terminalActiveMe401Error(retirement: RetirementResult): SessionError {
    return new SessionError(
      sessionErrorCodes.admissionDenied,
      "Account identity remained unauthorized after credential refresh",
      Object.freeze({ kind: "refresh_http_status", status: 401, retirement }),
    );
  }

  #retryPendingTerminalActiveMe401(): Promise<PendingTerminalActiveMe401Result | null> {
    const pending = this.#pendingTerminalActiveMe401;
    if (!pending) return Promise.resolve(null);
    return this.#coordinator
      .retireAccountAfterTerminalActiveMe401(pending.lease, pending.rejection)
      .then((retirement) => {
        if (this.#pendingTerminalActiveMe401 === pending) this.#pendingTerminalActiveMe401 = null;
        return Object.freeze({ source: pending.lease.activation, retirement });
      });
  }

  async #reconcileSelection(
    accountLease: AccountLease,
    reason: SelectedOrganizationReason,
    expectedState: SelectedOrganizationState | undefined,
    requestedOrganizationId: string | null,
    operation: RuntimeOperation,
    rotateObservedRevision = false,
  ): Promise<ReconciledSelection> {
    if (this.#pendingTerminalActiveHttp401) {
      throw new SessionError(
        sessionErrorCodes.recoveryRequired,
        "Authenticated HTTP retirement must settle before account reconciliation",
      );
    }
    const pendingRetirement = await this.#retryPendingTerminalActiveMe401();
    if (pendingRetirement) throw this.#terminalActiveMe401Error(pendingRetirement.retirement);
    let currentReason = reason;
    let currentExpected = expectedState;
    let latestMe: Readonly<Record<string, unknown>> | null = null;
    let credentialRefreshAttempted = false;
    let activeMeRetryClaim: unknown;
    for (let attempts = 0; attempts < MAX_RECONCILIATION_ATTEMPTS; attempts += 1) {
      let identity: Awaited<ReturnType<AuthSessionCoordinator["requestActiveMe"]>>;
      try {
        identity = await this.#coordinator.requestActiveMe(accountLease, activeMeRetryClaim);
      } catch (error) {
        if (activeMeRetryClaim !== undefined && sessionHttpStatus(error, "active_me_http_status") === 401) {
          if (!(error instanceof SessionError)) {
            throw new SessionError(sessionErrorCodes.invalidState, "Terminal account identity rejection is malformed");
          }
          const existing = this.#pendingTerminalActiveMe401;
          if (existing && !sameActivation(existing.lease.activation, accountLease.activation)) {
            throw new SessionError(
              sessionErrorCodes.recoveryRequired,
              "Another account owns the pending terminal identity retirement",
            );
          }
          if (existing) {
            const retirement = await this.#retryPendingTerminalActiveMe401();
            if (!retirement) {
              throw new SessionError(
                sessionErrorCodes.recoveryRequired,
                "Terminal identity retirement was not retained",
              );
            }
            throw this.#terminalActiveMe401Error(retirement.retirement);
          }

          let retirement: RetirementResult;
          try {
            retirement = await this.#coordinator.retireAccountAfterTerminalActiveMe401(accountLease, error);
          } catch (retirementError) {
            this.#pendingTerminalActiveMe401 = Object.freeze({ lease: accountLease, rejection: error });
            throw retirementError;
          }
          throw this.#terminalActiveMe401Error(retirement);
        }
        if (credentialRefreshAttempted || sessionHttpStatus(error, "active_me_http_status") !== 401) throw error;
        await this.#coordinator.refreshAccountCredentialAfterActiveMe401(
          accountLease,
          error,
          this.#freshGeneration("owned-401"),
        );
        this.#assertCurrent(operation);
        activeMeRetryClaim = error;
        credentialRefreshAttempted = true;
        continue;
      }
      this.#assertCurrent(operation);
      latestMe = identity.payload;
      const result = await this.#selectedOrganization.reconcile({
        lease: accountLease,
        identity: identity.proof,
        ...(requestedOrganizationId === null ? {} : { requestedOrganizationId }),
        ...(currentExpected === undefined ? {} : { expectedState: currentExpected }),
        reason: currentReason,
      });
      this.#assertCurrent(operation);
      if (result.kind === "superseded") {
        currentExpected = result.cursor;
        if (currentReason === "initialize" && !rotateObservedRevision) currentReason = "refresh";
        continue;
      }
      const publication = this.#selectedOrganization.readCurrentPublication();
      if (!publication || latestMe === null) {
        throw new SessionError(
          sessionErrorCodes.recoveryRequired,
          "Organization reconciliation did not publish a view",
        );
      }
      return Object.freeze({ me: latestMe, publication });
    }
    throw new SessionError(sessionErrorCodes.recoveryRequired, "Organization reconciliation did not converge");
  }

  async #finishRetirement(
    source: ActivationCertificate,
    existingReceipt: string | undefined,
    operation: RuntimeOperation,
  ): Promise<RetirementCompletion> {
    let localCleanupVerified = false;
    const legacyScrubRevision = this.#legacyScrubRevision;
    try {
      const receipt = await this.#barrier.purgeAccountScope(source, {
        localStorage: this.#localStorage,
        sessionStorage: this.#sessionStorage,
        ...(this.#onDatabaseBlocked === undefined ? {} : { onBlocked: this.#onDatabaseBlocked }),
      });
      if (existingReceipt !== undefined && receipt !== existingReceipt) {
        throw new SessionError(
          sessionErrorCodes.recoveryRequired,
          "Retirement cleanup receipt changed during recovery",
        );
      }
      localCleanupVerified = true;
      if (legacyScrubRevision === this.#legacyScrubRevision && this.#legacyScrubTask === null) {
        this.#legacyScrubComplete = true;
      }
      this.#assertCurrent(operation);
      await this.#coordinator.completeRetirement(source, receipt, this.#freshGeneration("anonymous"));
      this.#assertCurrent(operation);
      const authority = await this.#coordinator.readAuthority();
      this.#assertCurrent(operation);
      return authority.mode === "none"
        ? Object.freeze({ kind: "completed" })
        : Object.freeze({ kind: "superseded", authority });
    } catch (error) {
      this.#assertCurrent(operation);
      if (!localCleanupVerified) throw error;
      let authority: AuthAuthority;
      try {
        authority = await this.#coordinator.readAuthority();
      } catch {
        throw error;
      }
      this.#assertCurrent(operation);
      if (authority.mode === "none") return Object.freeze({ kind: "completed" });
      const samePendingSource =
        (authority.mode === "retiring" && sameActivation(authority.source, source)) ||
        (authority.mode === "transition" && authority.source !== null && sameActivation(authority.source, source));
      if (samePendingSource) throw error;
      return Object.freeze({ kind: "superseded", authority });
    }
  }

  async #finishAnonymousCleaning(cleaning: AuthAuthority, operation: RuntimeOperation): Promise<RetirementCompletion> {
    if (cleaning.mode !== "cleaning") {
      throw new SessionError(sessionErrorCodes.invalidState, "Anonymous cleanup authority is malformed");
    }
    let localCleanupVerified = false;
    try {
      const cleanup = this.#startAnonymousCleaningCycle(cleaning, this.#freshGeneration("anonymous"));
      await cleanup;
      localCleanupVerified = true;
      this.#assertCurrent(operation);
      const authority = await this.#coordinator.readAuthority();
      this.#assertCurrent(operation);
      return authority.mode === "none"
        ? Object.freeze({ kind: "completed" })
        : Object.freeze({ kind: "superseded", authority });
    } catch (error) {
      this.#assertCurrent(operation);
      if (!localCleanupVerified) throw error;
      let authority: AuthAuthority;
      try {
        authority = await this.#coordinator.readAuthority();
      } catch {
        throw error;
      }
      this.#assertCurrent(operation);
      if (authority.mode === "none") return Object.freeze({ kind: "completed" });
      if (
        authority.mode === "cleaning" &&
        authority.generation === cleaning.generation &&
        authority.revision === cleaning.revision
      ) {
        throw error;
      }
      return Object.freeze({ kind: "superseded", authority });
    }
  }

  #publishActive(
    prior: ActiveRuntime | AccountRuntimeHandle,
    session: ActiveSessionProjection,
    reconciled: ReconciledSelection,
    operation: RuntimeOperation,
    announceAuthority: boolean,
  ): void {
    this.#assertCurrent(operation);
    this.#assertNoticeTransportAvailable();
    if (
      !sameActivation(prior.activation, session.authority.session) ||
      !sameActivation(prior.accountLease.activation, session.authority.session)
    ) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Account authority changed before publication");
    }
    const publicationView = reconciled.publication.viewLease;
    if (publicationView && !sameActivation(publicationView.activation, session.authority.session)) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Organization publication belongs to another account");
    }
    if (this.#active && this.#active.projection.accountLease !== prior.accountLease) {
      throw new SessionError(
        sessionErrorCodes.staleOperation,
        "Another account runtime was installed before publication",
      );
    }
    const projection: BrowserSessionActiveProjection = Object.freeze({
      kind: "active",
      activation: session.authority.session,
      accountLease: prior.accountLease,
      credential: session.credential,
      me: reconciled.me,
      publication: reconciled.publication,
    });
    const active = Object.freeze({
      activation: prior.activation,
      accountLease: prior.accountLease,
      projection,
      sourceController: prior.sourceController,
      disposeAccountRuntime: prior.disposeAccountRuntime,
    });
    if (announceAuthority) this.#announceAuthorityAdvanced();
    this.#active = active;
    this.#recoveryLogoutOwner = null;
    this.#state = projection;
    try {
      this.#reveal(operation);
      this.#hardSuspendedActive = null;
    } catch (error) {
      if (this.#active === active) {
        this.#active = null;
        this.#retireAccountHandle(active, error);
      }
      throw error;
    }
  }

  #publishAnonymous(operation: RuntimeOperation, announceAuthority: boolean, sourceNoticeDelivered = true): void {
    this.#assertCurrent(operation);
    if (announceAuthority) this.#announceAuthorityAdvanced();
    this.#assertSourceNoticeDelivered(sourceNoticeDelivered);
    if (this.#active) this.#retireLocalActive(this.#active);
    this.#recoveryRemount = null;
    this.#recoveryLogoutOwner = null;
    this.#state = Object.freeze({ kind: "anonymous" });
    this.#reveal(operation);
    this.#hardSuspendedActive = null;
  }

  #retireLocalActive(active: ActiveRuntime): void {
    if (this.#active === active) this.#active = null;
    this.#retireAccountHandle(
      active,
      new SessionError(sessionErrorCodes.staleOperation, "Browser account runtime was retired"),
    );
  }

  #retireAccountHandle(handle: AccountRuntimeHandle, reason: unknown): void {
    handle.sourceController.abort(reason);
    handle.disposeAccountRuntime();
  }

  #captureActiveHttpOwner(): ActiveHttpOwner {
    const active = this.#requireActive();
    const publication = active.projection.publication;
    const view = publication.viewLease;
    if (!view) {
      throw new SessionError(
        sessionErrorCodes.admissionDenied,
        "Authenticated HTTP requires a selected organization view",
      );
    }
    if (
      !captureAccountStoreRuntime(active.accountLease) ||
      !captureContentStoreRuntime(view) ||
      active.accountLease.signal.aborted ||
      view.signal.aborted
    ) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Authenticated HTTP view is stale");
    }
    return Object.freeze({
      active,
      accountLease: active.accountLease,
      publication,
      view,
      credential: active.projection.credential,
    });
  }

  #readCurrentActiveHttpOwner(owner: ActiveHttpOwner): ActiveHttpOwner {
    const active = this.#active;
    if (
      this.#disposed ||
      !active ||
      active.accountLease !== owner.accountLease ||
      !sameActivation(active.activation, owner.active.activation) ||
      active.projection.publication !== owner.publication ||
      active.projection.publication.viewLease !== owner.view ||
      active.accountLease.signal.aborted ||
      owner.view.signal.aborted ||
      !captureAccountStoreRuntime(owner.accountLease) ||
      !captureContentStoreRuntime(owner.view)
    ) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Authenticated HTTP facade is stale");
    }
    return Object.freeze({
      active,
      accountLease: owner.accountLease,
      publication: owner.publication,
      view: owner.view,
      credential: active.projection.credential,
    });
  }

  async #assertActiveHttpOwner(
    owner: ActiveHttpOwner,
    expectedCredential?: CredentialCursor,
  ): Promise<ActiveHttpOwner> {
    let current = this.#readCurrentActiveHttpOwner(owner);
    if (expectedCredential && !sameCredentialCursor(current.credential, expectedCredential)) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Authenticated HTTP credential was replaced");
    }
    await this.#selectedOrganization.assertPublicationCurrent(owner.accountLease, owner.publication);
    current = this.#readCurrentActiveHttpOwner(owner);
    if (expectedCredential && !sameCredentialCursor(current.credential, expectedCredential)) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Authenticated HTTP credential was replaced");
    }
    return current;
  }

  #publishActiveHttpCredential(owner: ActiveHttpOwner, session: ActiveSessionProjection): ActiveRuntime {
    const current = this.#active;
    if (
      this.#disposed ||
      !current ||
      current.accountLease !== owner.accountLease ||
      !sameActivation(current.activation, owner.active.activation) ||
      current.accountLease.signal.aborted ||
      !captureAccountStoreRuntime(current.accountLease) ||
      !sameActivation(session.authority.session, current.activation)
    ) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Authenticated HTTP refresh changed account");
    }
    const projection: BrowserSessionActiveProjection = Object.freeze({
      ...current.projection,
      credential: session.credential,
    });
    const replacement: ActiveRuntime = Object.freeze({
      activation: current.activation,
      accountLease: current.accountLease,
      sourceController: current.sourceController,
      disposeAccountRuntime: current.disposeAccountRuntime,
      projection,
    });
    this.#active = replacement;
    if (this.#state.kind === "active" && this.#state.accountLease === current.accountLease) {
      this.#state = projection;
    }
    this.#emit();
    return replacement;
  }

  async #reconcileActiveHttpTransport(owner: ActiveHttpOwner, status: 421 | 503): Promise<"match" | "unavailable"> {
    const assertLocalSourceNotSuperseded = (): void => {
      if (this.#pendingUiRetirementEpoch === owner.active.activation.sessionEpoch) {
        throw new SessionError(
          sessionErrorCodes.staleOperation,
          "Authenticated transport evidence arrived after local retirement began",
        );
      }
      if (this.#active !== null && !sameActivation(this.#active.activation, owner.active.activation)) {
        throw new SessionError(
          sessionErrorCodes.staleOperation,
          "Authenticated transport evidence belongs to a superseded session",
        );
      }
    };
    const assertSourceStillActive = async (): Promise<void> => {
      const authority = await this.#coordinator.readAuthority();
      if (authority.mode !== "active" || !sameActivation(authority.session, owner.active.activation)) {
        throw new SessionError(
          sessionErrorCodes.staleOperation,
          "Authenticated transport evidence belongs to a superseded session",
        );
      }
      assertLocalSourceNotSuperseded();
    };
    // A coordinator-minted 421/503 is server-wide evidence for the exact
    // activation, not for only the organization view that happened to issue
    // the request. A same-session org replacement must not suppress it.
    assertLocalSourceNotSuperseded();
    let reconciliation: ServerAuthorityReconciliation;
    try {
      await assertSourceStillActive();
      reconciliation = await this.#authority.reconcile(owner.active.activation.serverAuthority);
      await assertSourceStillActive();
    } catch (error) {
      if (error instanceof SessionError && error.code === sessionErrorCodes.staleOperation) throw error;
      // A stale response must never veil or retire a replacement session.
      assertLocalSourceNotSuperseded();
      const operation = this.#begin("authenticated_http_authority_recovery");
      const active = this.#active;
      if (active && sameActivation(active.activation, owner.active.activation)) {
        this.#recoveryRemount = Object.freeze({
          activation: active.activation,
          expectedState: active.projection.publication.state,
        });
        this.#recoveryLogoutOwner = active.activation;
        this.#retireLocalActive(active);
        this.#registry.invalidateEpoch(active.activation.sessionEpoch);
      }
      this.#fail(operation, error);
      throw error;
    }

    if (reconciliation.kind === "mismatch") {
      const operation = this.#begin("authenticated_http_server_mismatch");
      this.#recoveryLogoutOwner = owner.active.activation;
      const active = this.#active;
      if (active && sameActivation(active.activation, owner.active.activation)) this.#retireLocalActive(active);
      try {
        await this.#retireServerMismatch(owner.active.activation, operation, false);
      } catch (error) {
        this.#fail(operation, error);
        throw error;
      }
      throw new SessionError(
        sessionErrorCodes.admissionDenied,
        "Authenticated request reached a different server authority",
      );
    }

    if (status === 421) {
      const error = new SessionError(
        sessionErrorCodes.recoveryRequired,
        "Authenticated request was rejected by the server authority boundary",
      );
      const operation = this.#begin("authenticated_http_authority_recovery");
      const active = this.#active;
      if (active && sameActivation(active.activation, owner.active.activation)) {
        this.#recoveryRemount = Object.freeze({
          activation: active.activation,
          expectedState: active.projection.publication.state,
        });
        this.#recoveryLogoutOwner = active.activation;
        this.#retireLocalActive(active);
        this.#registry.invalidateEpoch(active.activation.sessionEpoch);
      }
      this.#fail(operation, error);
      throw error;
    }
    return reconciliation.kind;
  }

  async #convergeActiveHttpRetirement(source: ActivationCertificate, retirement: RetirementResult): Promise<void> {
    if (retirement === "retired" || retirement === "already_retiring") {
      const active = this.#active;
      if (active && sameActivation(active.activation, source)) this.#retireLocalActive(active);
      this.#registry.invalidateEpoch(source.sessionEpoch);
      await this.#convergeCommittedOwned401(source);
      return;
    }
    const operation = this.#begin("owned_401_superseded");
    const authority = await this.#coordinator.readAuthority();
    this.#assertCurrent(operation);
    await this.#convergeAuthority(authority, operation, false);
  }

  #retryPendingTerminalActiveHttp401(): Promise<PendingTerminalActiveHttp401Result | null> {
    const pending = this.#pendingTerminalActiveHttp401;
    if (!pending) return Promise.resolve(null);
    if (this.#pendingTerminalActiveHttp401Task) return this.#pendingTerminalActiveHttp401Task;
    const task = this.#coordinator
      .retireActiveHttpAfterTerminal401(pending.response, pending.generation)
      .then((retirement) => {
        if (this.#pendingTerminalActiveHttp401 === pending) this.#pendingTerminalActiveHttp401 = null;
        return Object.freeze({ source: pending.source, retirement });
      });
    this.#pendingTerminalActiveHttp401Task = task;
    const clear = (): void => {
      if (this.#pendingTerminalActiveHttp401Task === task) this.#pendingTerminalActiveHttp401Task = null;
    };
    void task.then(clear, clear);
    return task;
  }

  #stageTerminalActiveHttp401(owner: ActiveHttpOwner, response: ActiveHttpResponse): void {
    if (this.#pendingUiRetirementEpoch === owner.active.activation.sessionEpoch) {
      throw new SessionError(
        sessionErrorCodes.staleOperation,
        "Authenticated rejection arrived after local retirement began",
      );
    }
    const existing = this.#pendingTerminalActiveHttp401;
    if (existing) {
      if (!sameActivation(existing.source, owner.active.activation)) {
        throw new SessionError(
          sessionErrorCodes.recoveryRequired,
          "Another account owns the pending authenticated HTTP retirement",
        );
      }
      return;
    }
    this.#pendingTerminalActiveHttp401 = Object.freeze({
      source: owner.active.activation,
      response,
      generation: this.#freshGeneration("owned-401-http"),
    });
  }

  async #retireTerminalActiveHttp401(owner: ActiveHttpOwner, response: ActiveHttpResponse): Promise<never> {
    this.#stageTerminalActiveHttp401(owner, response);
    const operation = this.#begin("owned_401_http_retirement");
    try {
      const result = await this.#retryPendingTerminalActiveHttp401();
      if (!result) {
        throw new SessionError(sessionErrorCodes.recoveryRequired, "Authenticated HTTP retirement disappeared");
      }
      await this.#convergeActiveHttpRetirement(result.source, result.retirement);
      throw new SessionError(
        sessionErrorCodes.admissionDenied,
        "Authenticated request remained unauthorized after credential refresh",
      );
    } catch (error) {
      if (this.#pendingTerminalActiveHttp401) {
        const active = this.#active;
        if (active && sameActivation(active.activation, owner.active.activation)) this.#retireLocalActive(active);
        this.#registry.invalidateEpoch(owner.active.activation.sessionEpoch);
        this.#recoveryLogoutOwner = owner.active.activation;
        this.#fail(operation, error);
      }
      throw error;
    }
  }

  async #refreshActiveHttpCredential(owner: ActiveHttpOwner): Promise<ActiveHttpOwner> {
    const current = await this.#assertActiveHttpOwner(owner, owner.credential);
    const existing = this.#pendingActiveHttpRefresh;
    if (
      existing &&
      sameActivation(existing.activation, owner.active.activation) &&
      sameCredentialCursor(existing.credential, owner.credential)
    ) {
      await existing.promise;
      return this.#assertActiveHttpOwner(owner);
    }
    if (existing) {
      await existing.promise;
      return this.#assertActiveHttpOwner(owner);
    }

    let task!: Promise<ActiveRuntime>;
    task = (async (): Promise<ActiveRuntime> => {
      try {
        const cursor = await this.#coordinator.refreshAccountCredential(
          current.accountLease,
          current.credential,
          this.#freshGeneration("owned-401-http-refresh"),
        );
        const session = await this.#coordinator.readActiveSession();
        if (
          !sameActivation(session.authority.session, current.active.activation) ||
          !sameCredentialCursor(session.credential, cursor)
        ) {
          throw new SessionError(sessionErrorCodes.staleOperation, "Authenticated HTTP refresh was superseded");
        }
        try {
          this.#announceAuthorityAdvanced();
        } catch (error) {
          const operation = this.#begin("credential_refresh_notification_failure");
          const active = this.#active;
          if (active && sameActivation(active.activation, current.active.activation)) this.#retireLocalActive(active);
          this.#recoveryLogoutOwner = current.active.activation;
          this.#fail(operation, error);
          throw error;
        }
        return this.#publishActiveHttpCredential(owner, session);
      } catch (error) {
        const retirement = owned401Retirement(error);
        if (retirement !== null) {
          await this.#convergeActiveHttpRetirement(current.active.activation, retirement);
        } else {
          const status = sessionHttpStatus(error, "refresh_http_status");
          if (status === 421 || status === 503) {
            await this.#reconcileActiveHttpTransport(current, status);
          }
        }
        throw error;
      } finally {
        if (this.#pendingActiveHttpRefresh?.promise === task) this.#pendingActiveHttpRefresh = null;
      }
    })();
    this.#pendingActiveHttpRefresh = Object.freeze({
      activation: current.active.activation,
      credential: current.credential,
      promise: task,
    });
    await task;
    return this.#assertActiveHttpOwner(owner);
  }

  async #requestActiveHttpOwned(
    owner: ActiveHttpOwner,
    input: CapturedBrowserSessionHttpRequest,
  ): Promise<ActiveHttpResponse> {
    const pending = await this.#retryPendingTerminalActiveHttp401();
    if (pending) await this.#convergeActiveHttpRetirement(pending.source, pending.retirement);
    let current = await this.#assertActiveHttpOwner(owner);
    const path = selectedHttpPath(input.target, owner.view.organizationId);
    const request = (attemptOwner: ActiveHttpOwner): Promise<ActiveHttpResponse> =>
      this.#coordinator.requestActiveHttp({
        view: attemptOwner.view,
        credential: attemptOwner.credential,
        scope: input.target.kind,
        path,
        ...(input.method === undefined ? {} : { method: input.method }),
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        ...(input.body === undefined ? {} : { body: input.body }),
        responseType: input.responseType,
        ...(input.maxResponseBytes === undefined ? {} : { maxResponseBytes: input.maxResponseBytes }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

    let response = await request(current);
    if (response.status === 421 || response.status === 503) {
      await this.#reconcileActiveHttpTransport(current, response.status);
    }
    current = await this.#assertActiveHttpOwner(owner, current.credential);
    if (response.status !== 401) {
      this.#readCurrentActiveHttpOwner(owner);
      return response;
    }

    current = await this.#refreshActiveHttpCredential(current);
    current = await this.#assertActiveHttpOwner(owner, current.credential);
    response = await request(current);
    if (response.status === 401) {
      // The coordinator returned this object only after its exact
      // credential/view response gate. Persist the realm-local capability
      // synchronously before any further await so pagehide, org replacement,
      // or selected-head I/O can suppress UI delivery but cannot lose the
      // decisive retirement.
      this.#stageTerminalActiveHttp401(current, response);
      return this.#retireTerminalActiveHttp401(current, response);
    }
    if (response.status === 421 || response.status === 503) {
      await this.#reconcileActiveHttpTransport(current, response.status);
    }
    await this.#assertActiveHttpOwner(owner, current.credential);
    this.#readCurrentActiveHttpOwner(owner);
    return response;
  }

  #requireActive(): ActiveRuntime {
    if (this.#disposed || !this.#active) {
      throw new SessionError(sessionErrorCodes.admissionDenied, "No active browser account runtime is installed");
    }
    return this.#active;
  }

  async #restoreActiveOrFail(
    active: ActiveRuntime,
    operation: RuntimeOperation,
    error: unknown,
  ): Promise<BrowserSessionProjection> {
    if (isServerMismatchFailure(error)) {
      try {
        this.#assertCurrent(operation);
      } catch {
        if (this.#active !== active) return this.getProjection();
      }
      this.#recoveryLogoutOwner = active.activation;
      if (this.#active === active) this.#retireLocalActive(active);
      try {
        await this.#retireServerMismatch(active.activation, operation, false);
      } catch (retirementError) {
        this.#fail(operation, retirementError);
      }
      return this.getProjection();
    }
    if (isAuthenticationFailure(error)) {
      try {
        this.#assertCurrent(operation);
      } catch {
        if (this.#active !== active) return this.getProjection();
      }
      this.#recoveryLogoutOwner = active.activation;
      if (this.#active === active) this.#retireLocalActive(active);
      try {
        if (await this.#recoverOwned401(active.activation, operation, error)) return this.getProjection();
        this.#fail(operation, error);
      } catch (recoveryError) {
        this.#fail(operation, recoveryError);
      }
      return this.getProjection();
    }
    try {
      this.#assertCurrent(operation);
      this.#assertNoticeTransportAvailable();
      const session = await this.#coordinator.readActiveSession();
      this.#assertCurrent(operation);
      if (
        !sameActivation(session.authority.session, active.activation) ||
        !sameCredentialCursor(session.credential, active.projection.credential)
      ) {
        throw new SessionError(sessionErrorCodes.staleOperation, "Account credential changed before view restoration");
      }
      const accountRuntime = captureAccountStoreRuntime(active.projection.accountLease);
      if (!accountRuntime) throw error;
      await accountRuntime.withShared(() => undefined);
      this.#assertCurrent(operation);
      const view = active.projection.publication.viewLease;
      if (view) {
        const contentRuntime = captureContentStoreRuntime(view);
        if (!contentRuntime) throw error;
        await contentRuntime.withShared(() => undefined);
        this.#assertCurrent(operation);
      }
      this.#state = active.projection;
      this.#reveal(operation);
      this.#hardSuspendedActive = null;
      return this.getProjection();
    } catch {
      try {
        this.#assertCurrent(operation);
      } catch {
        return this.getProjection();
      }
      this.#recoveryLogoutOwner = active.activation;
      if (this.#active === active) {
        this.#retireLocalActive(active);
        this.#registry.invalidateEpoch(active.activation.sessionEpoch);
      }
      this.#fail(operation, error);
      return this.getProjection();
    }
  }

  async #recoverOwned401(source: ActivationCertificate, operation: RuntimeOperation, error: unknown): Promise<boolean> {
    const retirement = owned401Retirement(error);
    if (retirement === null) return false;
    if (retirement === "superseded") {
      const authority = await this.#coordinator.readAuthority();
      this.#assertCurrent(operation);
      await this.#convergeAuthority(authority, operation, false);
      return true;
    }
    await this.#convergeCommittedOwned401(source);
    return true;
  }

  async #convergeCommittedOwned401(source: ActivationCertificate): Promise<void> {
    // The coordinator retirement transaction is authoritative even if a
    // re-entrant refresh, page lifecycle event, or subscriber superseded the
    // operation that initiated it. Transfer local cleanup to a fresh
    // operation so the sender does not depend on receiving its own notice.
    const convergence = this.#begin("owned_401_retirement_convergence");
    this.#pendingUiRetirementEpoch = source.sessionEpoch;
    try {
      const sourceNoticeDelivered = this.#announceSourceRetired(source);
      const authority = await this.#coordinator.readAuthority();
      this.#assertCurrent(convergence);
      await this.#convergeAuthority(
        authority,
        convergence,
        false,
        Object.freeze({ sessionEpoch: source.sessionEpoch, delivered: sourceNoticeDelivered }),
      );
    } catch (error) {
      this.#fail(convergence, error);
      throw error;
    } finally {
      if (this.#pendingUiRetirementEpoch === source.sessionEpoch) this.#pendingUiRetirementEpoch = null;
    }
  }

  async #retireServerMismatch(
    source: ActivationCertificate,
    operation: RuntimeOperation,
    revalidatePinnedAuthority: boolean,
  ): Promise<void> {
    const active = this.#active;
    if (active && sameActivation(active.activation, source)) this.#retireLocalActive(active);
    this.#registry.invalidateEpoch(source.sessionEpoch);
    this.#pendingUiRetirementEpoch = source.sessionEpoch;
    try {
      const retirement = await this.#coordinator.beginRetirement(
        source,
        "server_mismatch",
        this.#freshGeneration("server-mismatch"),
      );
      this.#assertCurrent(operation);
      if (retirement === "superseded") {
        const current = await this.#coordinator.readAuthority();
        this.#assertCurrent(operation);
        await this.#convergeAuthority(current, operation, revalidatePinnedAuthority);
        return;
      }
      const sourceNoticeDelivered = this.#announceSourceRetired(source);
      const completion = await this.#finishRetirement(source, undefined, operation);
      if (completion.kind === "superseded") {
        await this.#convergeAuthority(completion.authority, operation, revalidatePinnedAuthority);
        this.#assertSourceNoticeDelivered(sourceNoticeDelivered);
        return;
      }
      this.#publishAnonymous(operation, true, sourceNoticeDelivered);
    } finally {
      if (this.#pendingUiRetirementEpoch === source.sessionEpoch) this.#pendingUiRetirementEpoch = null;
    }
  }

  #onCrossDocumentNotice(notice: CrossDocumentAuthNotice): void {
    if (this.#disposed) return;
    this.#noticeRevision += 1;
    if (!this.#noticeProcessingReady || this.#suspended) {
      this.#queueCrossDocumentNotice(notice);
      return;
    }
    this.#processCrossDocumentNotice(notice);
  }

  #queueCrossDocumentNotice(notice: CrossDocumentAuthNotice): void {
    if (notice.kind === "authority-advanced") {
      this.#pendingAuthorityNotice = true;
      return;
    }
    const epoch = notice.sessionEpoch;
    this.#registry.invalidateEpoch(epoch);
    if (this.#pendingSourceNotices.size < MAX_PENDING_SOURCE_NOTICES) this.#pendingSourceNotices.add(epoch);
    else this.#pendingAuthorityNotice = true;
    const active = this.#active;
    if (active && active.projection.activation.sessionEpoch === epoch) {
      this.#operationRevision += 1;
      this.#veil.begin("cross_document_retirement");
      this.#recoveryLogoutOwner = active.activation;
      this.#retireLocalActive(active);
    }
  }

  #processCrossDocumentNotice(notice: CrossDocumentAuthNotice): void {
    if (notice.kind === "authority-advanced") {
      this.#authorityNoticeDirty = true;
      if (this.#authorityNoticeTask === null) {
        const task = this.#runAuthorityNoticeLoop().finally(() => {
          if (this.#authorityNoticeTask === task) this.#authorityNoticeTask = null;
        });
        this.#authorityNoticeTask = task;
      }
      return;
    }

    const epoch = notice.sessionEpoch;
    const active = this.#active;
    if (active && active.projection.activation.sessionEpoch === epoch) {
      if (this.#pendingUiRetirementEpoch === epoch || this.#backgroundSourceAssists.has(epoch)) {
        this.#registry.invalidateEpoch(epoch);
        return;
      }
      const operation = this.#begin("cross_document_retirement");
      const expectedState = active.projection.publication.state;
      this.#recoveryLogoutOwner = active.activation;
      this.#retireLocalActive(active);
      this.#registry.invalidateEpoch(epoch);
      this.#startSourceAssist(epoch, operation, expectedState, active.activation);
      return;
    }

    this.#registry.invalidateEpoch(epoch);
    if (this.#pendingUiRetirementEpoch === epoch || this.#backgroundSourceAssists.has(epoch)) return;
    this.#startSourceAssist(epoch, null, undefined, undefined);
  }

  #finishNoticeFence(operation: RuntimeOperation): void {
    this.#assertCurrent(operation);
    if (operation.noticeRevision === null) return;
    if (!this.#legacyScrubComplete) {
      throw new SessionError(sessionErrorCodes.recoveryRequired, "Legacy cleanup is incomplete");
    }
    this.#pendingSourceNotices.clear();
    this.#pendingAuthorityNotice = false;
    this.#noticeProcessingReady = true;
  }

  #releaseNoticeGateAndDrain(): void {
    if (this.#disposed || this.#suspended || this.#noticeProcessingReady || !this.#legacyScrubComplete) return;
    const sourceEpochs = [...this.#pendingSourceNotices];
    const authorityPending = this.#pendingAuthorityNotice;
    this.#pendingSourceNotices.clear();
    this.#pendingAuthorityNotice = false;
    this.#noticeProcessingReady = true;
    for (const epoch of sourceEpochs) {
      this.#processCrossDocumentNotice(
        Object.freeze({ v: 1, kind: "source-retired", eventId: `deferred:${epoch}`, sessionEpoch: epoch }),
      );
    }
    if (authorityPending) {
      this.#processCrossDocumentNotice(Object.freeze({ v: 1, kind: "authority-advanced", eventId: "deferred" }));
    }
  }

  #startSourceAssist(
    epoch: string,
    operation: RuntimeOperation | null,
    expectedState: SelectedOrganizationState | undefined,
    expectedActivation: ActivationCertificate | undefined,
  ): void {
    const task = (
      operation
        ? this.#reconcileNoticedAuthority(epoch, operation, undefined, expectedState, expectedActivation)
        : this.#inspectNoticeAuthority(epoch)
    )
      .catch((error) => {
        if (operation) this.#fail(operation, error);
        else this.#reportBackgroundError(error);
      })
      .finally(() => {
        if (this.#backgroundSourceAssists.get(epoch) === task) this.#backgroundSourceAssists.delete(epoch);
      });
    this.#backgroundSourceAssists.set(epoch, task);
  }

  async #runAuthorityNoticeLoop(): Promise<void> {
    while (!this.#disposed && this.#authorityNoticeDirty) {
      this.#authorityNoticeDirty = false;
      await this.#inspectNoticeAuthority(null);
    }
  }

  async #inspectNoticeAuthority(sourceEpoch: string | null): Promise<void> {
    const observedRevision = this.#operationRevision;
    const observedActive = this.#active;
    let operation: RuntimeOperation | null = null;
    try {
      const authority = await this.#coordinator.readAuthority();
      if (this.#disposed || observedRevision !== this.#operationRevision || this.#active !== observedActive) return;

      if (
        sourceEpoch !== null &&
        observedActive &&
        observedActive.activation.sessionEpoch !== sourceEpoch &&
        authority.mode === "active" &&
        sameActivation(authority.session, observedActive.activation)
      ) {
        return;
      }
      if (
        observedActive &&
        authority.mode === "active" &&
        sameActivation(authority.session, observedActive.activation)
      ) {
        const session = await this.#coordinator.readActiveSession();
        if (this.#disposed || observedRevision !== this.#operationRevision || this.#active !== observedActive) return;
        if (sameCredentialCursor(session.credential, observedActive.projection.credential)) return;
      } else if (!observedActive && this.#state.kind === "anonymous" && authority.mode === "none") {
        return;
      }

      operation = this.#begin(sourceEpoch === null ? "cross_document_authority" : "cross_document_retirement");
      const expectedState =
        observedActive && authority.mode === "active" && sameActivation(observedActive.activation, authority.session)
          ? observedActive.projection.publication.state
          : undefined;
      if (observedActive) this.#recoveryLogoutOwner = observedActive.activation;
      if (this.#active) this.#retireLocalActive(this.#active);
      await this.#reconcileNoticedAuthority(
        sourceEpoch,
        operation,
        authority,
        expectedState,
        expectedState === undefined ? undefined : observedActive?.activation,
      );
    } catch (error) {
      if (operation) {
        this.#fail(operation, error);
      } else if (
        sourceEpoch === null &&
        !this.#disposed &&
        observedRevision === this.#operationRevision &&
        this.#active === observedActive
      ) {
        operation = this.#begin("cross_document_authority_failure");
        if (observedActive && this.#active === observedActive) {
          this.#recoveryLogoutOwner = observedActive.activation;
          this.#retireLocalActive(observedActive);
          this.#registry.invalidateEpoch(observedActive.activation.sessionEpoch);
        }
        this.#fail(operation, error);
      } else {
        this.#reportBackgroundError(error);
      }
    }
  }

  async #reconcileNoticedAuthority(
    sourceEpoch: string | null,
    operation: RuntimeOperation,
    authorityValue?: AuthAuthority,
    expectedState?: SelectedOrganizationState,
    expectedActivation?: ActivationCertificate,
  ): Promise<void> {
    let authority = authorityValue ?? (await this.#coordinator.readAuthority());
    let noticedSourceEpoch = sourceEpoch;
    for (let attempts = 0; attempts < MAX_RECONCILIATION_ATTEMPTS; attempts += 1) {
      this.#assertCurrent(operation);
      if (authority.mode === "none") {
        this.#publishAnonymous(operation, false);
        return;
      }
      if (authority.mode === "cleaning") {
        const completion = await this.#finishAnonymousCleaning(authority, operation);
        if (completion.kind === "superseded") {
          authority = completion.authority;
          continue;
        }
        this.#publishAnonymous(operation, true);
        this.#releaseNoticeGateAndDrain();
        return;
      }
      if (authority.mode === "active") {
        const observed = await this.#authority.pin();
        this.#assertCurrent(operation);
        if (observed !== authority.session.serverAuthority) {
          if (!expectedActivation || !sameActivation(expectedActivation, authority.session)) {
            throw new SessionError(
              sessionErrorCodes.recoveryRequired,
              "This document does not own the mismatched durable session",
            );
          }
          const retirement = await this.#coordinator.beginRetirement(
            authority.session,
            "server_mismatch",
            this.#freshGeneration("server-mismatch"),
          );
          this.#assertCurrent(operation);
          if (retirement === "superseded") {
            authority = await this.#coordinator.readAuthority();
            continue;
          }
          const sourceNoticeDelivered =
            noticedSourceEpoch === authority.session.sessionEpoch || this.#announceSourceRetired(authority.session);
          const completion = await this.#finishRetirement(authority.session, undefined, operation);
          if (completion.kind === "superseded") {
            authority = completion.authority;
            this.#assertSourceNoticeDelivered(sourceNoticeDelivered);
            continue;
          }
          this.#publishAnonymous(operation, true, sourceNoticeDelivered);
          return;
        }
        const freshAuthority = await this.#coordinator.readAuthority();
        this.#assertCurrent(operation);
        if (
          freshAuthority.mode !== "active" ||
          freshAuthority.revision !== authority.revision ||
          !sameActivation(freshAuthority.session, authority.session)
        ) {
          authority = freshAuthority;
          continue;
        }
        const reusableState =
          expectedState && expectedActivation && sameActivation(expectedActivation, authority.session)
            ? expectedState
            : undefined;
        await this.#mountActive(authority.session, operation, reusableState, reusableState !== undefined);
        return;
      }

      const pendingSource = authority.source;
      if (
        noticedSourceEpoch !== null &&
        (pendingSource === null || pendingSource.sessionEpoch !== noticedSourceEpoch)
      ) {
        noticedSourceEpoch = null;
      }
      if (authority.mode === "transition") {
        if (pendingSource === null) return;
        const sourceNoticeDelivered =
          noticedSourceEpoch === pendingSource.sessionEpoch || this.#announceSourceRetired(pendingSource);
        const phaseBeforePurge = authority.phase;
        await this.#barrier.purgeAccountScope(pendingSource, {
          localStorage: this.#localStorage,
          sessionStorage: this.#sessionStorage,
          ...(this.#onDatabaseBlocked === undefined ? {} : { onBlocked: this.#onDatabaseBlocked }),
        });
        this.#assertCurrent(operation);
        const latest = await this.#coordinator.readAuthority();
        this.#assertCurrent(operation);
        if (
          phaseBeforePurge !== "source_purged" &&
          latest.mode === "transition" &&
          latest.permit.permitId === authority.permit.permitId &&
          latest.phase === "source_purged"
        ) {
          this.#announceAuthorityAdvanced();
        }
        this.#assertSourceNoticeDelivered(sourceNoticeDelivered);
        if (latest.mode === "transition" && latest.permit.permitId === authority.permit.permitId) return;
        authority = latest;
        continue;
      }

      const sourceNoticeDelivered =
        noticedSourceEpoch === authority.source.sessionEpoch || this.#announceSourceRetired(authority.source);
      const completion = await this.#finishRetirement(authority.source, authority.cleanupReceipt, operation);
      if (completion.kind === "superseded") {
        authority = completion.authority;
        this.#assertSourceNoticeDelivered(sourceNoticeDelivered);
        continue;
      }
      this.#publishAnonymous(operation, true, sourceNoticeDelivered);
      return;
    }
    throw new SessionError(sessionErrorCodes.recoveryRequired, "Cross-document session notice did not converge");
  }

  #assertNoticeTransportAvailable(): void {
    if (!this.#notices.available) {
      throw new SessionError(
        sessionErrorCodes.platformUnavailable,
        "Cross-document session coordination is unavailable",
      );
    }
  }

  #announceSourceRetired(source: ActivationCertificate): boolean {
    try {
      const delivery = this.#notices.publishSourceRetired(source.sessionEpoch);
      return delivery.broadcast || delivery.storage;
    } catch (error) {
      this.#reportBackgroundError(error);
      return false;
    }
  }

  #assertSourceNoticeDelivered(delivered: boolean): void {
    if (!delivered) {
      throw new SessionError(
        sessionErrorCodes.recoveryRequired,
        "Cross-document source retirement notification could not be delivered",
      );
    }
  }

  #announceAuthorityAdvanced(): void {
    let delivered = false;
    try {
      const delivery = this.#notices.publishAuthorityAdvanced();
      delivered = delivery.broadcast || delivery.storage;
    } catch (error) {
      this.#reportBackgroundError(error);
    }
    if (!delivered) {
      throw new SessionError(
        sessionErrorCodes.recoveryRequired,
        "Cross-document authority notification could not be delivered",
      );
    }
  }

  #reportBackgroundError(error: unknown): void {
    try {
      globalThis.reportError?.(error);
    } catch {
      // Advisory transport diagnostics never become session authority.
    }
  }

  #freshGeneration(label: string): string {
    return `${label}:${opaqueId(this.#createId, "Auth generation")}`;
  }

  #begin(reason: string, fenceNotices = false): RuntimeOperation {
    if (this.#disposed) throw new SessionError(sessionErrorCodes.staleOperation, "Browser session runtime is disposed");
    this.#operationRevision += 1;
    return Object.freeze({
      revision: this.#operationRevision,
      veil: this.#veil.begin(reason),
      noticeRevision: fenceNotices ? this.#noticeRevision : null,
    });
  }

  #assertCurrent(operation: RuntimeOperation): void {
    if (
      this.#disposed ||
      operation.revision !== this.#operationRevision ||
      (operation.noticeRevision !== null && operation.noticeRevision !== this.#noticeRevision)
    ) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Browser session operation was superseded");
    }
  }

  #noticeFenceChanged(operation: RuntimeOperation): boolean {
    return operation.noticeRevision !== null && operation.noticeRevision !== this.#noticeRevision;
  }

  #reveal(operation: RuntimeOperation): void {
    this.#assertCurrent(operation);
    if (!this.#veil.reveal(operation.veil)) {
      throw new SessionError(sessionErrorCodes.staleOperation, "Browser session reveal was superseded");
    }
  }

  #fail(operation: RuntimeOperation, error: unknown): void {
    if (
      this.#disposed ||
      operation.revision !== this.#operationRevision ||
      (operation.noticeRevision !== null && operation.noticeRevision !== this.#noticeRevision)
    ) {
      return;
    }
    this.#state = Object.freeze({ kind: "recovery", reason: recoveryReason(error) });
    this.#emit();
    this.#veil.fail(operation.veil, recoveryReason(error));
  }

  #emit(): void {
    const operationRevision = this.#operationRevision;
    const projection = this.getProjection();
    for (const subscriber of [...this.#subscribers]) {
      if (this.#operationRevision !== operationRevision) return;
      try {
        subscriber(projection);
      } catch (error) {
        try {
          globalThis.reportError?.(error);
        } catch {
          // A projection listener cannot interrupt an authority transition.
        }
      }
    }
  }
}

export { OWNER_TAB_STORAGE_KEY };
