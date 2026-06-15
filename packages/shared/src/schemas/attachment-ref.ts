import { z } from "zod";

/**
 * Attachment kinds carried by an {@link AttachmentRef}. `kind` is derived from
 * the mime type at capture time and stored explicitly so render/delivery code
 * can branch without re-sniffing the mime on every read:
 *  - `image`    — a picture (rendered inline / lightbox). NOTE: images today
 *                 still travel as `imageRefContent` in `messages.content`; this
 *                 kind exists for the future convergence onto the generic ref.
 *  - `document` — a text document previewed in the doc drawer (markdown today).
 *  - `file`     — any other blob; rendered as a download card.
 */
export const ATTACHMENT_KINDS = ["image", "document", "file"] as const;
export const attachmentKindSchema = z.enum(ATTACHMENT_KINDS);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

/**
 * Generic "this message references a stored blob" model — the single shape
 * every consumer (image / document / arbitrary file) hangs off, mounted at
 * `messages.metadata.attachments[]`. Mirrors the live image-ref convergence
 * onto the `attachments` blob substrate: the sender uploads bytes to
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
export const attachmentRefSchema = z.object({
  attachmentId: z.string().uuid(),
  kind: attachmentKindSchema,
  mimeType: z.string().min(1),
  filename: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64).optional(),
  source: z
    .object({
      path: z.string(),
      sourcePath: z.string().optional(),
    })
    .optional(),
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

/**
 * Hard cap on attachment refs a single message may carry. Bounds the
 * per-render fetch fan-out and the size of the metadata blob; doc-preview's
 * original "snapshot N docs" UX needed ~5, so this stays generous-but-finite.
 * Bump only with product sign-off.
 */
export const MAX_MESSAGE_ATTACHMENT_REFS = 10;

const ATTACHMENT_KINDS_SET = new Set<string>(ATTACHMENT_KINDS);

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
  if (typeof v.attachmentId !== "string") return false;
  if (typeof v.kind !== "string" || !ATTACHMENT_KINDS_SET.has(v.kind)) return false;
  if (typeof v.mimeType !== "string" || v.mimeType.length === 0) return false;
  if (typeof v.filename !== "string" || v.filename.length === 0) return false;
  if (typeof v.size !== "number" || !Number.isInteger(v.size) || v.size < 0) return false;
  if (v.sha256 !== undefined && (typeof v.sha256 !== "string" || v.sha256.length !== 64)) return false;
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
