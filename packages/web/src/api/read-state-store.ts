/**
 * Per-chat resume state. Physical persistence is account+server scoped and
 * row keys include the exact selected organization.
 */

import {
  CHAT_CONTENT_DATABASE_SPEC,
  type ContentOperation,
  captureContentStoreRuntime,
  type ViewLease,
} from "../auth/session/index.js";

const STORE = "read-state";

export type ReadState = {
  chatId: string;
  bottomVisibleMessageId: string;
  latestKnownMessageId?: string;
  updatedAt: number;
};

type StoredReadState = ReadState & {
  organizationId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStoredReadState(value: unknown, organizationId: string, chatId: string): ReadState | null {
  if (!isRecord(value)) return null;
  if (
    value.organizationId !== organizationId ||
    value.chatId !== chatId ||
    typeof value.bottomVisibleMessageId !== "string" ||
    (value.latestKnownMessageId !== undefined && typeof value.latestKnownMessageId !== "string") ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt)
  ) {
    return null;
  }
  return {
    chatId,
    bottomVisibleMessageId: value.bottomVisibleMessageId,
    ...(value.latestKnownMessageId === undefined ? {} : { latestKnownMessageId: value.latestKnownMessageId }),
    updatedAt: value.updatedAt,
  };
}

async function withChatDatabase<T>(
  operation: ContentOperation,
  callback: (database: IDBDatabase) => Promise<T>,
): Promise<T> {
  const database = await operation.openDatabase(CHAT_CONTENT_DATABASE_SPEC);
  try {
    return await callback(database);
  } finally {
    operation.closeDatabase(database);
  }
}

export function getReadState(lease: ViewLease, chatId: string): Promise<ReadState | null>;
/** @deprecated AuthContext integration must pass an explicit captured ViewLease. */
export function getReadState(chatId: string): Promise<ReadState | null>;
export async function getReadState(
  leaseOrChatId: ViewLease | string,
  capturedChatId?: string,
): Promise<ReadState | null> {
  if (typeof leaseOrChatId === "string" || capturedChatId === undefined) return null;
  const chatId = capturedChatId;
  let runtime: ReturnType<typeof captureContentStoreRuntime>;
  try {
    runtime = captureContentStoreRuntime(leaseOrChatId);
  } catch {
    return null;
  }
  if (!runtime) return null;

  try {
    return await runtime.withShared(async (operation, lease) => {
      operation.assertOrganization(lease.organizationId);
      return withChatDatabase(operation, async (database) => {
        let result: ReadState | null = null;
        await operation.runTransaction(database, STORE, "readonly", (transaction) => {
          const request = transaction.objectStore(STORE).get([lease.organizationId, chatId]);
          request.onsuccess = () => {
            result = readStoredReadState(request.result, lease.organizationId, chatId);
          };
        });
        return result;
      });
    });
  } catch {
    return null;
  }
}

export function setReadState(
  lease: ViewLease,
  chatId: string,
  bottomVisibleMessageId: string,
  latestKnownMessageId: string,
): Promise<void>;
/** @deprecated AuthContext integration must pass an explicit captured ViewLease. */
export function setReadState(
  chatId: string,
  bottomVisibleMessageId: string,
  latestKnownMessageId: string,
): Promise<void>;
export async function setReadState(
  leaseOrChatId: ViewLease | string,
  chatIdOrBottomVisibleMessageId: string,
  bottomVisibleOrLatestKnownMessageId: string,
  capturedLatestKnownMessageId?: string,
): Promise<void> {
  if (typeof leaseOrChatId === "string" || capturedLatestKnownMessageId === undefined) return;
  const chatId = chatIdOrBottomVisibleMessageId;
  const bottomVisibleMessageId = bottomVisibleOrLatestKnownMessageId;
  const latestKnownMessageId = capturedLatestKnownMessageId;
  let runtime: ReturnType<typeof captureContentStoreRuntime>;
  try {
    runtime = captureContentStoreRuntime(leaseOrChatId);
  } catch {
    return;
  }
  if (!runtime) return;

  try {
    await runtime.withShared(async (operation, lease) => {
      operation.assertOrganization(lease.organizationId);
      await withChatDatabase(operation, async (database) => {
        await operation.runTransaction(database, STORE, "readwrite", (transaction) => {
          const row: StoredReadState = {
            organizationId: lease.organizationId,
            chatId,
            bottomVisibleMessageId,
            latestKnownMessageId,
            updatedAt: Date.now(),
          };
          transaction.objectStore(STORE).put(row);
        });
      });
    });
  } catch {
    // Best-effort scroll state. A stale view is intentionally a no-op.
  }
}

export function clearReadState(lease: ViewLease, chatId: string): Promise<void>;
/** @deprecated AuthContext integration must pass an explicit captured ViewLease. */
export function clearReadState(chatId: string): Promise<void>;
export async function clearReadState(leaseOrChatId: ViewLease | string, capturedChatId?: string): Promise<void> {
  if (typeof leaseOrChatId === "string" || capturedChatId === undefined) return;
  const chatId = capturedChatId;
  let runtime: ReturnType<typeof captureContentStoreRuntime>;
  try {
    runtime = captureContentStoreRuntime(leaseOrChatId);
  } catch {
    return;
  }
  if (!runtime) return;

  try {
    await runtime.withShared(async (operation, lease) => {
      operation.assertOrganization(lease.organizationId);
      await withChatDatabase(operation, async (database) => {
        await operation.runTransaction(database, STORE, "readwrite", (transaction) => {
          transaction.objectStore(STORE).delete([lease.organizationId, chatId]);
        });
      });
    });
  } catch {
    // Diagnostic removal remains best effort within the captured view.
  }
}
