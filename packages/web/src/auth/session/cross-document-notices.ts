import { SessionError, sessionErrorCodes } from "./errors.js";

export const CROSS_DOCUMENT_AUTH_CHANNEL_NAME = "first-tree:auth-authority:v1";
export const CROSS_DOCUMENT_AUTH_STORAGE_KEY = "first-tree:auth-authority-notice:v1";

const NOTICE_VERSION = 1 as const;
const MAX_NOTICE_BYTES = 4 * 1024;
const MAX_EVENT_ID_BYTES = 1024;
const MAX_SESSION_EPOCH_BYTES = 2048;
const MAX_RECENT_EVENT_IDS = 256;

export type SourceRetiredNotice = Readonly<{
  v: typeof NOTICE_VERSION;
  kind: "source-retired";
  eventId: string;
  sessionEpoch: string;
}>;

export type AuthorityAdvancedNotice = Readonly<{
  v: typeof NOTICE_VERSION;
  kind: "authority-advanced";
  eventId: string;
}>;

export type CrossDocumentAuthNotice = SourceRetiredNotice | AuthorityAdvancedNotice;

export type CrossDocumentNoticeDelivery = Readonly<{
  broadcast: boolean;
  storage: boolean;
}>;

export type CrossDocumentNoticeStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export type CrossDocumentBroadcastChannel = Readonly<{
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: string): void;
  close(): void;
}>;

type StorageEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type CrossDocumentNoticeOptions = Readonly<{
  localStorage: CrossDocumentNoticeStorage;
  onNotice: (notice: CrossDocumentAuthNotice) => void;
  windowTarget?: StorageEventTarget;
  createBroadcastChannel?: (name: string) => CrossDocumentBroadcastChannel | null;
  createId?: () => string;
}>;

export type CrossDocumentNoticeTransport = Readonly<{
  available: boolean;
  publishSourceRetired(sessionEpoch: string): CrossDocumentNoticeDelivery;
  publishAuthorityAdvanced(): CrossDocumentNoticeDelivery;
  dispose(): void;
}>;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function requireBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > maxBytes) {
    throw new SessionError(sessionErrorCodes.invalidState, `${label} must be a non-empty bounded string`);
  }
  return value;
}

function defaultCreateId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new SessionError(
      sessionErrorCodes.platformUnavailable,
      "Secure randomness is required for cross-document session notices",
    );
  }
  return globalThis.crypto.randomUUID();
}

function defaultCreateBroadcastChannel(name: string): CrossDocumentBroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  return new BroadcastChannel(name);
}

function serializeNotice(notice: CrossDocumentAuthNotice): string {
  const serialized = JSON.stringify(notice);
  if (byteLength(serialized) > MAX_NOTICE_BYTES) {
    throw new SessionError(sessionErrorCodes.invalidState, "Cross-document session notice is too large");
  }
  return serialized;
}

/**
 * Accept only this module's canonical JSON. Besides rejecting extra fields,
 * this also rejects duplicate keys, alternate escaping, and whitespace-shaped
 * variants without trying to interpret them as authorization.
 */
function parseNotice(serialized: unknown): CrossDocumentAuthNotice | null {
  if (typeof serialized !== "string" || serialized.length === 0 || byteLength(serialized) > MAX_NOTICE_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const value = parsed as Readonly<Record<string, unknown>>;
  if (value.v !== NOTICE_VERSION) return null;

  try {
    const eventId = requireBoundedString(value.eventId, "Notice event id", MAX_EVENT_ID_BYTES);
    if (value.kind === "authority-advanced") {
      const notice = Object.freeze({ v: NOTICE_VERSION, kind: value.kind, eventId });
      return serializeNotice(notice) === serialized ? notice : null;
    }
    if (value.kind === "source-retired") {
      const sessionEpoch = requireBoundedString(value.sessionEpoch, "Notice session epoch", MAX_SESSION_EPOCH_BYTES);
      const notice = Object.freeze({ v: NOTICE_VERSION, kind: value.kind, eventId, sessionEpoch });
      return serializeNotice(notice) === serialized ? notice : null;
    }
  } catch {
    return null;
  }
  return null;
}

function safeEventProperty(event: Event, property: "data" | "key" | "newValue" | "storageArea"): unknown {
  try {
    return Reflect.get(event, property);
  } catch {
    return undefined;
  }
}

/**
 * Installs redundant advisory transports. A notice is only a synchronous
 * wake-up hint: receivers must reread the transactional auth coordinator
 * before deleting data, activating credentials, or declaring logout complete.
 */
export function installCrossDocumentAuthNotices(options: CrossDocumentNoticeOptions): CrossDocumentNoticeTransport {
  // Snapshot every caller-owned property exactly once. Runtime mutation or a
  // getter that returns a different value later cannot swap the authority
  // wake-up handler or either transport after installation.
  const storage = options.localStorage;
  const onNotice = options.onNotice;
  const explicitWindowTarget = options.windowTarget;
  const explicitCreateBroadcastChannel = options.createBroadcastChannel;
  const explicitCreateId = options.createId;
  if (typeof onNotice !== "function") {
    throw new SessionError(sessionErrorCodes.invalidState, "Cross-document notice handler is required");
  }
  const windowTarget = explicitWindowTarget ?? (typeof window === "undefined" ? undefined : window);
  const createId = explicitCreateId ?? defaultCreateId;
  const createBroadcastChannel = explicitCreateBroadcastChannel ?? defaultCreateBroadcastChannel;
  const recentIds = new Set<string>();
  const recentOrder: string[] = [];
  let disposed = false;
  let channel: CrossDocumentBroadcastChannel | null = null;

  try {
    channel = createBroadcastChannel(CROSS_DOCUMENT_AUTH_CHANNEL_NAME);
  } catch {
    // The localStorage event pulse remains available as the redundant path.
  }

  let storageAvailable = false;
  try {
    const probe = "first-tree-cross-document-notice-preflight";
    storage.setItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY, probe);
    if (storage.getItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY) === probe) {
      storage.removeItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY);
      storageAvailable = storage.getItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY) === null;
    } else {
      storage.removeItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY);
    }
  } catch {
    try {
      storage.removeItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY);
    } catch {
      // Availability remains false; the coordinator cannot infer otherwise.
    }
  }
  const available = channel !== null || storageAvailable;

  const remember = (eventId: string): boolean => {
    if (recentIds.has(eventId)) return false;
    recentIds.add(eventId);
    recentOrder.push(eventId);
    if (recentOrder.length > MAX_RECENT_EVENT_IDS) {
      const evicted = recentOrder.shift();
      if (evicted !== undefined) recentIds.delete(evicted);
    }
    return true;
  };

  const deliver = (serialized: unknown): void => {
    if (disposed) return;
    const notice = parseNotice(serialized);
    if (!notice || !remember(notice.eventId)) return;
    // Deliberately synchronous: BrowserSessionRuntime veils and retires a
    // matching epoch before starting its fresh coordinator read.
    try {
      onNotice(notice);
    } catch (error) {
      // One projection bug cannot unwind event dispatch, make a sender report
      // transport failure, or poison delivery of a later distinct notice.
      try {
        globalThis.reportError?.(error);
      } catch {
        // Reporting is never part of cross-document session authority.
      }
    }
  };

  const onMessage = (event: MessageEvent<unknown>): void => {
    deliver(safeEventProperty(event, "data"));
  };
  const onStorage: EventListener = (event): void => {
    if (safeEventProperty(event, "key") !== CROSS_DOCUMENT_AUTH_STORAGE_KEY) return;
    const eventStorage = safeEventProperty(event, "storageArea");
    if (eventStorage !== null && eventStorage !== undefined && eventStorage !== storage) return;
    deliver(safeEventProperty(event, "newValue"));
  };

  channel?.addEventListener("message", onMessage);
  windowTarget?.addEventListener("storage", onStorage);

  const publish = (notice: CrossDocumentAuthNotice): CrossDocumentNoticeDelivery => {
    if (disposed) return Object.freeze({ broadcast: false, storage: false });
    const serialized = serializeNotice(notice);
    // Real BroadcastChannel does not echo to its sender. Remembering here also
    // suppresses non-conforming/test loopback without invoking local authority.
    if (!remember(notice.eventId)) return Object.freeze({ broadcast: false, storage: false });

    let broadcast = false;
    try {
      if (channel) {
        channel.postMessage(serialized);
        broadcast = true;
      }
    } catch {
      // Storage remains an independent advisory path.
    }

    let storageDelivered = false;
    try {
      storage.removeItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY);
      if (storage.getItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY) === null) {
        storage.setItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY, serialized);
        if (storage.getItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY) === serialized) {
          storage.removeItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY);
          storageDelivered = storage.getItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY) === null;
        } else {
          storage.removeItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY);
        }
      }
    } catch {
      try {
        storage.removeItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY);
      } catch {
        // The false diagnostic is the only conclusion; this is not authority.
      }
    }
    return Object.freeze({ broadcast, storage: storageDelivered });
  };

  return Object.freeze({
    available,
    publishSourceRetired(sessionEpochValue: string): CrossDocumentNoticeDelivery {
      const sessionEpoch = requireBoundedString(sessionEpochValue, "Notice session epoch", MAX_SESSION_EPOCH_BYTES);
      const eventId = requireBoundedString(createId(), "Notice event id", MAX_EVENT_ID_BYTES);
      return publish(Object.freeze({ v: NOTICE_VERSION, kind: "source-retired", eventId, sessionEpoch }));
    },
    publishAuthorityAdvanced(): CrossDocumentNoticeDelivery {
      const eventId = requireBoundedString(createId(), "Notice event id", MAX_EVENT_ID_BYTES);
      return publish(Object.freeze({ v: NOTICE_VERSION, kind: "authority-advanced", eventId }));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      windowTarget?.removeEventListener("storage", onStorage);
      try {
        channel?.removeEventListener("message", onMessage);
        channel?.close();
      } catch {
        // Disposal cannot create or revoke session authority.
      }
      channel = null;
      recentIds.clear();
      recentOrder.length = 0;
    },
  });
}
