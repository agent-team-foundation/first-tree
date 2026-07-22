/** Account+server physical, organization-keyed cache for server attachments. */

import {
  type ContentOperation,
  captureContentStoreRuntime,
  IMAGE_CONTENT_DATABASE_SPEC,
  type ViewLease,
} from "../auth/session/index.js";

const STORE = "images";

type StoredImage = {
  organizationId: string;
  imageId: string;
  base64: string;
  mimeType: string;
  createdAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStoredImage(
  value: unknown,
  organizationId: string,
  imageId: string,
): { base64: string; mimeType: string } | null {
  if (!isRecord(value)) return null;
  if (
    value.organizationId !== organizationId ||
    value.imageId !== imageId ||
    typeof value.base64 !== "string" ||
    typeof value.mimeType !== "string" ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt)
  ) {
    return null;
  }
  return { base64: value.base64, mimeType: value.mimeType };
}

function unavailable(cause?: unknown): Error {
  const error = new Error("Image storage unavailable for the current authenticated view");
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause });
  return error;
}

async function withImageDatabase<T>(
  operation: ContentOperation,
  callback: (database: IDBDatabase) => Promise<T>,
): Promise<T> {
  const database = await operation.openDatabase(IMAGE_CONTENT_DATABASE_SPEC);
  try {
    return await callback(database);
  } finally {
    operation.closeDatabase(database);
  }
}

/**
 * Warms the server-backed attachment cache. Unlike other cache writes this
 * preserves its historical rejection contract so callers can explicitly
 * swallow/report cache-warm failures.
 */
type PutImageParams = { imageId: string; base64: string; mimeType: string };

export function putImage(lease: ViewLease, params: PutImageParams): Promise<void>;
/** @deprecated AuthContext integration must pass an explicit captured ViewLease. */
export function putImage(params: PutImageParams): Promise<void>;
export async function putImage(
  leaseOrParams: ViewLease | PutImageParams,
  capturedParams?: PutImageParams,
): Promise<void> {
  if (capturedParams === undefined) throw unavailable();
  let params: Readonly<PutImageParams>;
  try {
    const { base64, imageId, mimeType } = capturedParams;
    if (typeof imageId !== "string" || typeof base64 !== "string" || typeof mimeType !== "string") {
      throw new TypeError("Invalid image cache input");
    }
    params = Object.freeze({ imageId, base64, mimeType });
  } catch (error) {
    throw unavailable(error);
  }
  let runtime: ReturnType<typeof captureContentStoreRuntime>;
  try {
    runtime = captureContentStoreRuntime(leaseOrParams);
  } catch (error) {
    throw unavailable(error);
  }
  if (!runtime) throw unavailable();

  try {
    await runtime.withShared(async (operation, lease) => {
      operation.assertOrganization(lease.organizationId);
      await withImageDatabase(operation, async (database) => {
        await operation.runTransaction(database, STORE, "readwrite", (transaction) => {
          const row: StoredImage = {
            organizationId: lease.organizationId,
            imageId: params.imageId,
            base64: params.base64,
            mimeType: params.mimeType,
            createdAt: Date.now(),
          };
          transaction.objectStore(STORE).put(row);
        });
      });
    });
  } catch (error) {
    throw unavailable(error);
  }
}

export function getImage(lease: ViewLease, imageId: string): Promise<{ base64: string; mimeType: string } | null>;
/** @deprecated AuthContext integration must pass an explicit captured ViewLease. */
export function getImage(imageId: string): Promise<{ base64: string; mimeType: string } | null>;
export async function getImage(
  leaseOrImageId: ViewLease | string,
  capturedImageId?: string,
): Promise<{ base64: string; mimeType: string } | null> {
  if (typeof leaseOrImageId === "string" || capturedImageId === undefined) return null;
  const imageId = capturedImageId;
  let runtime: ReturnType<typeof captureContentStoreRuntime>;
  try {
    runtime = captureContentStoreRuntime(leaseOrImageId);
  } catch {
    return null;
  }
  if (!runtime) return null;

  try {
    return await runtime.withShared(async (operation, lease) => {
      operation.assertOrganization(lease.organizationId);
      return withImageDatabase(operation, async (database) => {
        let result: { base64: string; mimeType: string } | null = null;
        await operation.runTransaction(database, STORE, "readonly", (transaction) => {
          const request = transaction.objectStore(STORE).get([lease.organizationId, imageId]);
          request.onsuccess = () => {
            result = readStoredImage(request.result, lease.organizationId, imageId);
          };
        });
        return result;
      });
    });
  } catch {
    return null;
  }
}
