/**
 * Server-wins hot cache for finalized chat messages.
 *
 * Persistence is admitted only through the document's captured authenticated
 * view. The physical database is account+server scoped, while every row and
 * index key is also organization scoped. A missing, retired, or stale view is
 * a cache miss/no-op; it never falls back to origin-global persistence.
 */

import { messageSchema } from "@first-tree/shared";
import {
  CHAT_CONTENT_DATABASE_SPEC,
  type ContentOperation,
  captureContentStoreRuntime,
  type ViewLease,
} from "../auth/session/index.js";
import type { MessageWithDelivery } from "./chats.js";

const STORE = "messages";
const INDEX_BY_ORG_CHAT_CREATED = "by_org_chat_created";

type StoredMessage = {
  organizationId: string;
  chatId: string;
  messageId: string;
  payload: MessageWithDelivery;
  createdAt: string;
  cachedAt: number;
};

const DELIVERY_STATUSES = new Set(["sent", "pending", "delivered", "acked"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageWithDelivery(value: unknown): value is MessageWithDelivery {
  if (!messageSchema.safeParse(value).success) return false;
  const deliveryStatus = (value as { deliveryStatus?: unknown }).deliveryStatus;
  return deliveryStatus === undefined || (typeof deliveryStatus === "string" && DELIVERY_STATUSES.has(deliveryStatus));
}

function readStoredMessage(value: unknown, organizationId: string, chatId: string): MessageWithDelivery | null {
  if (!isRecord(value)) return null;
  const { cachedAt, createdAt, messageId, organizationId: storedOrganizationId, payload, chatId: storedChatId } = value;
  if (
    storedOrganizationId !== organizationId ||
    storedChatId !== chatId ||
    typeof messageId !== "string" ||
    typeof createdAt !== "string" ||
    typeof cachedAt !== "number" ||
    !Number.isFinite(cachedAt) ||
    !isMessageWithDelivery(payload) ||
    payload.id !== messageId ||
    payload.chatId !== chatId ||
    payload.createdAt !== createdAt
  ) {
    return null;
  }
  return payload;
}

function snapshotMessages(messages: readonly MessageWithDelivery[]): readonly MessageWithDelivery[] | null {
  if (typeof structuredClone !== "function") return null;
  let cloned: unknown;
  try {
    cloned = structuredClone(messages);
  } catch {
    return null;
  }
  if (!Array.isArray(cloned)) return null;
  const output = cloned.filter(isMessageWithDelivery);
  return Object.freeze(output);
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

/** Returns the current org's cached timeline in server creation order. */
export function getCachedMessages(lease: ViewLease, chatId: string): Promise<MessageWithDelivery[]>;
/** @deprecated AuthContext integration must pass an explicit captured ViewLease. */
export function getCachedMessages(chatId: string): Promise<MessageWithDelivery[]>;
export async function getCachedMessages(
  leaseOrChatId: ViewLease | string,
  capturedChatId?: string,
): Promise<MessageWithDelivery[]> {
  if (typeof leaseOrChatId === "string" || capturedChatId === undefined) return [];
  const chatId = capturedChatId;
  let runtime: ReturnType<typeof captureContentStoreRuntime>;
  try {
    runtime = captureContentStoreRuntime(leaseOrChatId);
  } catch {
    return [];
  }
  if (!runtime) return [];

  try {
    return await runtime.withShared(async (operation, lease) => {
      operation.assertOrganization(lease.organizationId);
      return withChatDatabase(operation, async (database) => {
        const output: MessageWithDelivery[] = [];
        await operation.runTransaction(database, STORE, "readonly", (transaction) => {
          const index = transaction.objectStore(STORE).index(INDEX_BY_ORG_CHAT_CREATED);
          const range = IDBKeyRange.bound([lease.organizationId, chatId, ""], [lease.organizationId, chatId, "\uffff"]);
          const request = index.openCursor(range);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            const message = readStoredMessage(cursor.value, lease.organizationId, chatId);
            if (message) output.push(message);
            cursor.continue();
          };
        });
        return output;
      });
    });
  } catch {
    return [];
  }
}

/** Idempotently warms the current account/server/org message cache. */
export function cacheMessages(
  lease: ViewLease,
  chatId: string,
  messages: readonly MessageWithDelivery[],
): Promise<void>;
/** @deprecated AuthContext integration must pass an explicit captured ViewLease. */
export function cacheMessages(chatId: string, messages: readonly MessageWithDelivery[]): Promise<void>;
export async function cacheMessages(
  leaseOrChatId: ViewLease | string,
  chatIdOrMessages: string | readonly MessageWithDelivery[],
  capturedMessages?: readonly MessageWithDelivery[],
): Promise<void> {
  if (typeof leaseOrChatId === "string" || typeof chatIdOrMessages !== "string" || !capturedMessages) return;
  const chatId = chatIdOrMessages;
  const messages = snapshotMessages(capturedMessages);
  if (!messages || messages.length === 0) return;
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
          const store = transaction.objectStore(STORE);
          const cachedAt = Date.now();
          for (const message of messages) {
            if (message.chatId !== chatId) continue;
            const row: StoredMessage = {
              organizationId: lease.organizationId,
              chatId,
              messageId: message.id,
              payload: message,
              createdAt: message.createdAt,
              cachedAt,
            };
            store.put(row);
          }
        });
      });
    });
  } catch {
    // This is a recoverable server-backed hot cache. Stale/unavailable writes
    // are deliberately discarded rather than escaping the captured view.
  }
}

/** Removes one chat only from the current account/server/org cache. */
export function clearChatCache(lease: ViewLease, chatId: string): Promise<void>;
/** @deprecated AuthContext integration must pass an explicit captured ViewLease. */
export function clearChatCache(chatId: string): Promise<void>;
export async function clearChatCache(leaseOrChatId: ViewLease | string, capturedChatId?: string): Promise<void> {
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
          const index = transaction.objectStore(STORE).index(INDEX_BY_ORG_CHAT_CREATED);
          const range = IDBKeyRange.bound([lease.organizationId, chatId, ""], [lease.organizationId, chatId, "\uffff"]);
          const request = index.openCursor(range);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            cursor.delete();
            cursor.continue();
          };
        });
      });
    });
  } catch {
    // Best-effort diagnostic cache removal; account retirement performs the
    // authoritative whole-scope deletion through the exclusive barrier.
  }
}
