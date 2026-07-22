import type { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "../config.js";

/**
 * S3 object-storage client wrapper for attachment bytes.
 *
 * Thin on purpose: SigV4 signing, unknown-length multipart streaming, and
 * presigned GET URLs are delegated to the AWS SDK v3 (the de-facto standard
 * that works against AWS S3, MinIO, and Cloudflare R2 alike). The wrapper
 * owns only the semantics this codebase cares about:
 *
 *  - streaming upload whose caller can abort mid-flight (the oversize
 *    counting stream cancels the multipart upload instead of buffering);
 *  - idempotent delete — `NoSuchKey` / 404 is treated as success so every
 *    delete entry point (orphan sweep, edit-delete, upload-failure
 *    compensation) can be retried symmetrically;
 *  - presigned GetObject (300s) carrying the stored mime / filename so the
 *    object response renders like the legacy buffered download did.
 */
export type S3AttachmentConfig = NonNullable<Config["s3"]>;

/** Presigned download URLs live 5 minutes — long enough for a browser fetch. */
export const ATTACHMENT_PRESIGN_EXPIRY_SECONDS = 300;

export type AttachmentStore = {
  /** Bucket every key below resolves against. */
  readonly bucket: string;
  /**
   * Stream `body` to `key`. Unknown length is fine — `@aws-sdk/lib-storage`
   * multipart-uploads as parts fill. When `signal` fires, the upload aborts
   * (in-flight parts cancelled, multipart upload aborted) and the returned
   * promise rejects; the caller maps that to its own error.
   */
  upload(key: string, body: Readable, contentType: string, signal?: AbortSignal): Promise<void>;
  /** Delete `key`. Idempotent: a missing object counts as deleted. */
  deleteObject(key: string): Promise<void>;
  /**
   * Presign a GetObject for `key` (300s). The signed response overrides
   * Content-Type / Content-Disposition with the row's stored values so a
   * browser following the 302 sees the same headers the legacy buffered
   * download served.
   */
  presignGetUrl(key: string, opts: { mimeType: string; filename: string }): Promise<string>;
};

export function createAttachmentStore(config: S3AttachmentConfig): AttachmentStore {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const bucket = config.bucket;

  return {
    bucket,

    async upload(key, body, contentType, signal) {
      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType },
      });
      if (signal) {
        if (signal.aborted) {
          upload.abort();
        } else {
          signal.addEventListener("abort", () => upload.abort(), { once: true });
        }
      }
      await upload.done();
    },

    async deleteObject(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        // Delete is idempotent by contract: the goal state "object gone"
        // already holds, so NoSuchKey / 404 is success. Everything else
        // (auth, network, 5xx) propagates so the caller retries later.
        if (isNoSuchKeyError(err)) return;
        throw err;
      }
    },

    async presignGetUrl(key, opts) {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentType: opts.mimeType,
        ResponseContentDisposition: `inline; filename="${encodeRfc6266Filename(opts.filename)}"`,
      });
      return getSignedUrl(client, command, { expiresIn: ATTACHMENT_PRESIGN_EXPIRY_SECONDS });
    },
  };
}

function isNoSuchKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  if (name === "NoSuchKey" || name === "NotFound") return true;
  const status = (err as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return status === 404;
}

/**
 * RFC 6266 percent-encoding for the `filename` directive — `inline; filename="..."`.
 * Only percent-encodes characters that would break the quoted-string parser
 * (CR/LF, quote, backslash). Browsers tolerate non-ASCII inside the quoted
 * form, but raw quotes / control chars would smuggle headers.
 */
export function encodeRfc6266Filename(name: string): string {
  return name.replace(/[\r\n"\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}
