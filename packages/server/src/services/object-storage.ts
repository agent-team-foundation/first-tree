import type { Readable } from "node:stream";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ATTACHMENT_PRESIGN_TTL_SECONDS } from "@first-tree/shared";
import type { Config } from "../config.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("ObjectStorage");

export type ObjectStorageConfig = NonNullable<Config["objectStorage"]>;

/** Deterministic payload key for an attachment row. */
export function attachmentObjectKey(attachmentId: string): string {
  return `attachments/${attachmentId}`;
}

/** Deterministic payload key for an agent avatar (overwritten in place). */
export function avatarObjectKey(agentUuid: string): string {
  return `avatars/${agentUuid}`;
}

export type PutObjectStreamOptions = {
  /** Exact payload length. Required — uploads reserve quota from the declared size. */
  contentLength: number;
  contentType: string;
  /** Aborts the in-flight PUT promptly (e.g. when the body stream failed). */
  abortSignal?: AbortSignal;
};

export type GetObjectStreamResult = {
  body: Readable;
  contentLength: number | undefined;
};

export type PresignGetOptions = {
  /** Original filename, carried into `Content-Disposition` of the S3 response. */
  filename: string;
  /** Logical MIME type, carried into `Content-Type` of the S3 response. */
  mimeType: string;
  /** Disposition type; the download route serves inline like it always has. */
  disposition: "inline" | "attachment";
};

/**
 * Thin, S3-compatible object-storage boundary (AWS S3, Cloudflare R2, MinIO).
 *
 * Deliberately storage-dumb: keys are opaque strings owned by the callers
 * (`attachmentObjectKey` / `avatarObjectKey`), lifecycle and quota decisions
 * live in the attachment services, and every method maps 1:1 onto one S3
 * call so failure semantics stay predictable.
 */
export type ObjectStorage = {
  /**
   * Stream a payload into the bucket. The body is NOT buffered — callers
   * pass the (possibly transformed) request stream plus the exact
   * `contentLength`, and the SDK signs a single streaming PUT.
   */
  putObjectStream(key: string, body: Readable, opts: PutObjectStreamOptions): Promise<void>;
  /**
   * Open a payload stream. Returns `null` when the object does not exist —
   * for a `stored` row that is corruption, and the caller decides how loud
   * to be about it.
   */
  getObjectStream(key: string): Promise<GetObjectStreamResult | null>;
  /** Delete a payload. Idempotent: a missing object resolves silently. */
  deleteObject(key: string): Promise<void>;
  /**
   * Presign a short-lived GET (redirect download mode). Signed against
   * `publicEndpoint` when configured so browsers can reach storage across a
   * split-horizon network; response content headers are pinned so the
   * browser sees the original filename/MIME regardless of bucket metadata.
   */
  presignGetUrl(key: string, opts: PresignGetOptions): Promise<string>;
  /**
   * Best-effort bucket bootstrap for dev/test convenience: create the
   * bucket when it is missing. Never throws — production deployments often
   * scope credentials to object CRUD only and pre-provision the bucket, so
   * a failed probe/create degrades to a warning and the first real
   * operation surfaces the actual error.
   */
  ensureBucket(): Promise<void>;
};

function buildClient(config: ObjectStorageConfig, endpoint: string | undefined): S3Client {
  return new S3Client({
    region: config.region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Skip the SDK's default CRC32 wrapping of every PutObject body: none of
    // our calls require checksums, the extra internal body pipe leaks an
    // unhandled rejection when an aborted streaming upload destroys the
    // source mid-flight, and some S3-compatible backends reject the
    // checksum trailers anyway.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = "name" in error ? (error as { name?: unknown }).name : undefined;
  if (name === "NoSuchKey" || name === "NotFound" || name === "NoSuchBucket") return true;
  const status =
    "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode
      : undefined;
  return status === 404;
}

export function createObjectStorage(config: ObjectStorageConfig): ObjectStorage {
  const client = buildClient(config, config.endpoint);
  // Separate client for presigning only: URLs must be reachable by browsers,
  // which may live on the public side of a split-horizon network.
  const presignClient = config.publicEndpoint ? buildClient(config, config.publicEndpoint) : client;
  const bucket = config.bucket;

  return {
    async putObjectStream(key, body, opts) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: opts.contentLength,
          ContentType: opts.contentType,
        }),
        { abortSignal: opts.abortSignal },
      );
    },

    async getObjectStream(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = response.Body;
        if (!body) return null;
        // The SDK types Body as a browser/node union; under Node a GetObject
        // body is always a Readable (SdkStream<IncomingMessage>).
        return { body: body as unknown as Readable, contentLength: response.ContentLength };
      } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
      }
    },

    async deleteObject(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        // S3 DeleteObject already succeeds on missing keys; tolerate backends
        // that surface 404/NoSuchKey instead so retries stay idempotent.
        if (isNotFoundError(error)) return;
        throw error;
      }
    },

    async presignGetUrl(key, opts) {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentType: opts.mimeType,
        ResponseContentDisposition: contentDisposition(opts.filename, opts.disposition),
      });
      return getSignedUrl(presignClient, command, { expiresIn: ATTACHMENT_PRESIGN_TTL_SECONDS });
    },

    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        return;
      } catch (error) {
        if (!isNotFoundError(error)) {
          log.warn({ err: error, bucket }, "object storage bucket probe failed; continuing");
          return;
        }
      }
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        log.info({ bucket }, "created object storage bucket");
      } catch (error) {
        log.warn({ err: error, bucket }, "object storage bucket create failed; continuing");
      }
    },
  };
}

/**
 * RFC 6266 / RFC 5987 Content-Disposition for arbitrary (possibly
 * non-ASCII) filenames: an ASCII fallback plus a UTF-8 `filename*`. Used by
 * the proxy download path and presigned URLs so both modes emit identical
 * headers.
 */
export function contentDisposition(filename: string, disposition: "inline" | "attachment"): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "'");
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
