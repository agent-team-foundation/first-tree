import {
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_MIME_HEADER,
  type UploadAttachmentResponse,
  uploadAttachmentResponseSchema,
} from "@first-tree/shared";
import { apiFetchRaw, withOrg } from "./client.js";

/**
 * Upload a file's bytes to the org-scoped object store and return its
 * metadata — the `id` is what an image message references. Targets the
 * currently-viewed org via `withOrg`; the chat lives in that org, so its
 * members can fetch the bytes back through the capability-model download.
 *
 * The filename is `encodeURIComponent`-escaped because HTTP header values are
 * limited to ISO-8859-1 and a raw unicode name would make `fetch` throw. The
 * user-visible filename shown in chat comes from the message ref (JSON body),
 * not this header — the header only feeds the download `Content-Disposition`.
 */
export async function uploadImageAttachment(file: File): Promise<UploadAttachmentResponse> {
  const bytes = await file.arrayBuffer();
  const res = await apiFetchRaw(withOrg("/attachments"), {
    method: "POST",
    body: bytes,
    headers: {
      "Content-Type": "application/octet-stream",
      [ATTACHMENT_MIME_HEADER]: file.type,
      [ATTACHMENT_FILENAME_HEADER]: encodeURIComponent(file.name),
    },
  });
  return uploadAttachmentResponseSchema.parse(await res.json());
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected FileReader result"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Download attachment bytes (capability model — a valid session plus the
 * unguessable id is sufficient). Returns base64 + the served MIME so callers
 * can render a `data:` URL and warm the IndexedDB cache with one shape.
 */
export async function fetchAttachmentBase64(id: string): Promise<{ base64: string; mimeType: string }> {
  const res = await apiFetchRaw(`/attachments/${encodeURIComponent(id)}`);
  const blob = await res.blob();
  const mimeType = res.headers.get("content-type") ?? blob.type ?? "application/octet-stream";
  return { base64: await blobToBase64(blob), mimeType };
}

/**
 * Download attachment bytes as decoded text — the doc-preview drawer's data
 * source. Returns the UTF-8 text, the served MIME, and the raw byte length so
 * callers can verify integrity (sha256) and enforce a render size cap.
 */
export async function fetchAttachmentText(id: string): Promise<{ text: string; mimeType: string; sizeBytes: number }> {
  const res = await apiFetchRaw(`/attachments/${encodeURIComponent(id)}`);
  const buffer = await res.arrayBuffer();
  const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
  const text = new TextDecoder("utf-8").decode(buffer);
  return { text, mimeType, sizeBytes: buffer.byteLength };
}

/**
 * Compute the lowercase hex SHA-256 of a UTF-8 string via the Web Crypto API —
 * used by the doc-preview drawer to verify fetched bytes against the captured
 * `ref.sha256`. Throws when `crypto.subtle` is unavailable (insecure context);
 * callers treat that as "skip verification".
 */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto subtle digest is unavailable");
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
