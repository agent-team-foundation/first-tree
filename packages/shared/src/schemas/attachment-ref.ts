import { z } from "zod";
import { SUPPORTED_IMAGE_MIMES, type SupportedImageMime } from "./image-payload.js";

const SUPPORTED_IMAGE_MIME_SET = new Set<string>(SUPPORTED_IMAGE_MIMES);

/**
 * Attachment kinds carried by an {@link AttachmentRef}. `kind` is derived from
 * the mime type at capture time and stored explicitly so render/delivery code
 * can branch without re-sniffing the mime on every read:
 *  - `image`    — a picture (rendered inline / lightbox). New tracked-request
 *                 images use this generic ref; ordinary and historical image
 *                 messages retain `imageRefContent` in `messages.content`
 *                 until a separately scoped migration.
 *  - `document` — a text document previewed in the doc drawer (markdown today).
 *  - `file`     — any other blob; rendered as a download card.
 */
export const ATTACHMENT_KINDS = ["image", "document", "file"] as const;
export const attachmentKindSchema = z.enum(ATTACHMENT_KINDS);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

/**
 * Generic "this message references a stored blob" model, mounted at
 * `messages.metadata.attachments[]`. Documents/files and new tracked-request
 * images use it; legacy image-message content remains readable during the
 * transition. The sender uploads bytes to
 * `POST /orgs/:orgId/attachments`, then sends a message carrying only this
 * reference. Every reader fetches the bytes on demand from
 * `GET /attachments/:attachmentId` — bytes never travel inside the message.
 *
 * `sha256` is computed client-side at capture and verified by the renderer for
 * end-to-end integrity (and is the hook a future "show latest" comparison
 * would use). `source` is present only for refs captured from an agent's
 * workspace filesystem; `path` is the workspace-relative path (display / in-doc
 * cross-navigation) and `sourcePath` is a forward hook for "show latest" that
 * is written but not consumed this phase.
 */
export const attachmentRefSchema = z
  .object({
    attachmentId: z.string().uuid(),
    kind: attachmentKindSchema,
    mimeType: z.string().min(1),
    filename: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex chars")
      .optional(),
    // SECURITY: `source.path` (and `sourcePath`) is UNTRUSTED, DISPLAY-ONLY
    // metadata. A ref's bytes are self-supplied by the sender and downloads are
    // capability-based (valid session + unguessable attachmentId), so a malicious
    // runtime can fabricate bytes and pair them with an arbitrary `source.path`.
    // The server cannot meaningfully validate a free-form display string, so it
    // does not — this is display-spoofing only, NOT access escalation. NEVER use
    // `source.path` for authorization, routing, or filesystem access.
    source: z
      .object({
        path: z.string(),
        sourcePath: z.string().optional(),
      })
      .optional(),
  })
  .superRefine((ref, ctx) => {
    if (ref.kind === "image" && !SUPPORTED_IMAGE_MIME_SET.has(ref.mimeType)) {
      ctx.addIssue({
        code: "custom",
        path: ["mimeType"],
        message: "image attachments must use a supported image MIME type",
      });
    }
  });
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
export type ImageAttachmentRef = AttachmentRef & {
  kind: "image";
  mimeType: SupportedImageMime;
};

/**
 * Hard cap on attachment refs a single message may carry. Bounds the
 * per-render fetch fan-out and the size of the metadata blob; doc-preview's
 * original "snapshot N docs" UX needed ~5, so this stays generous-but-finite.
 * Bump only with product sign-off.
 */
export const MAX_MESSAGE_ATTACHMENT_REFS = 10;

const ATTACHMENT_KINDS_SET = new Set<string>(ATTACHMENT_KINDS);

/**
 * UUID shape check matching `z.string().uuid()` — kept in the hand-rolled guard
 * so a non-uuid `attachmentId` cannot slip past `isAttachmentRef` (and thus the
 * count-matched server reader) when the schema requires a uuid.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lowercase-hex sha256 shape, mirroring `attachmentRefSchema.sha256`. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Hand-rolled guard for {@link AttachmentRef} — kept cheap (instead of
 * `schema.safeParse`) because every inbound message in chat-view / runtime
 * passes through it on render. Mirrors the contract of `attachmentRefSchema`;
 * if the schema gains a required field this guard must match. Style follows
 * `isImageRefContent` in `image-payload.ts` so the family stays consistent.
 */
export function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.attachmentId !== "string" || !UUID_RE.test(v.attachmentId)) return false;
  if (typeof v.kind !== "string" || !ATTACHMENT_KINDS_SET.has(v.kind)) return false;
  if (typeof v.mimeType !== "string" || v.mimeType.length === 0) return false;
  if (v.kind === "image" && !SUPPORTED_IMAGE_MIME_SET.has(v.mimeType)) return false;
  if (typeof v.filename !== "string" || v.filename.length === 0) return false;
  if (typeof v.size !== "number" || !Number.isInteger(v.size) || v.size < 0) return false;
  if (v.sha256 !== undefined && (typeof v.sha256 !== "string" || !SHA256_RE.test(v.sha256))) return false;
  if (v.source !== undefined) {
    if (!v.source || typeof v.source !== "object") return false;
    const s = v.source as Record<string, unknown>;
    if (typeof s.path !== "string") return false;
    if (s.sourcePath !== undefined && typeof s.sourcePath !== "string") return false;
  }
  return true;
}

/**
 * Read the validated `AttachmentRef[]` from a message's free-form metadata.
 * Returns an empty array when the field is absent or malformed — readers must
 * degrade gracefully (old messages have no `attachments` key), never throw.
 */
export function attachmentRefsFromMetadata(metadata: Record<string, unknown> | undefined): AttachmentRef[] {
  if (!metadata) return [];
  const raw = metadata.attachments;
  if (!Array.isArray(raw)) return [];
  const out: AttachmentRef[] = [];
  for (const entry of raw) {
    if (isAttachmentRef(entry)) out.push(entry);
  }
  return out;
}

/**
 * Read generic image attachments from message metadata. The generic ref schema
 * and its hand-rolled reader both enforce the MIME set supported by renderers
 * and the local image store.
 */
export function imageAttachmentRefsFromMetadata(metadata: Record<string, unknown> | undefined): ImageAttachmentRef[] {
  return attachmentRefsFromMetadata(metadata).filter(
    (ref): ref is ImageAttachmentRef => ref.kind === "image" && SUPPORTED_IMAGE_MIME_SET.has(ref.mimeType),
  );
}
