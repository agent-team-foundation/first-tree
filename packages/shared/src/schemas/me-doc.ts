import { z } from "zod";

export const workspaceDocRefSchema = z.object({
  type: z.literal("workspace"),
  chatId: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  basePath: z.string().trim().optional(),
  path: z.string().trim().min(1),
});
export type WorkspaceDocRef = z.infer<typeof workspaceDocRefSchema>;

/**
 * Cap on the inert-chip failedMentions list. The runtime scanner already caps
 * per-message mention count via the BARE_PATH regex on a single text body;
 * this is a hard ceiling against pathological inputs.
 */
export const MAX_FAILED_DOC_MENTIONS_PER_MESSAGE = 16;
/** Schema-side raw-token length cap. Generous because absolute paths can be
 *  long, but bounded so a misbehaving runtime cannot lodge giant strings. */
export const MAX_FAILED_DOC_MENTION_RAW_LEN = 512;

/**
 * Why a `.md` mention that LOOKED like a workspace path didn't end up as an
 * attachment ref. The web renders a disabled "doc chip" in place of the raw
 * token + a reason-mapped tooltip so the failure is visible instead of
 * silently degrading to plain text (and the agent — re-reading its own
 * message — can see WHY the preview didn't materialise).
 *
 * Scanner-static rejections (domain-shaped, fenced code blocks, HTML tag
 * bodies, reference link definitions) do NOT produce failedMentions — those
 * tokens are by design not workspace paths. Only mentions that made it to the
 * runtime resolver AND failed to capture (resolve / read / upload) are
 * reported.
 */
export const docSnapshotFailReasonSchema = z.enum([
  "missing",
  "out-of-fence",
  "hidden-segment",
  "too-large",
  "budget-exceeded",
  "unreadable",
]);
export type DocSnapshotFailReason = z.infer<typeof docSnapshotFailReasonSchema>;

export const failedDocMentionSchema = z.object({
  /** Agent-authored raw token, suffix-stripped to its writtenPath form so two
   *  occurrences of the same file under `:line` variants dedupe to one entry.
   *  Web does `stripDocPathLineSuffix(match.raw)` before lookup. */
  raw: z.string().trim().min(1).max(MAX_FAILED_DOC_MENTION_RAW_LEN),
  reason: docSnapshotFailReasonSchema,
});
export type FailedDocMention = z.infer<typeof failedDocMentionSchema>;

const snapshotDocumentContextSchema = z.object({
  kind: z.literal("snapshot"),
  /** Failure roster for inert chip rendering. The successful captures now live
   *  in `metadata.attachments[]` as generic `AttachmentRef`s; this context only
   *  carries the failures so the chat-view can render disabled chips + reason
   *  tooltips at the original token positions. */
  failedMentions: z.array(failedDocMentionSchema).max(MAX_FAILED_DOC_MENTIONS_PER_MESSAGE).min(1),
});

const pathDocumentContextSchema = z.object({
  kind: z.literal("path"),
  basePath: z.string().trim().min(1),
});

/**
 * `messages.metadata.documentContext` discriminated union.
 *
 * - `kind: "snapshot"` — failure roster ONLY (inert chips). Successful doc
 *   captures are stored as generic `AttachmentRef`s in `metadata.attachments[]`
 *   (kind: "document"), fetched on demand from the attachments blob store.
 * - `kind: "path"` — PR #356 path-based fallback, only meaningful when server
 *   and runtime share a filesystem (local dev / single-host).
 *
 * Legacy compat: messages written before the `kind` field had a bare
 * `{ basePath: string }`. The preprocessor normalises that to
 * `{ kind: "path", basePath }`. Pre-cutover messages that carried the inline
 * `kind: "snapshot"` shape with `docs[].content` no longer match this schema
 * (the `docs` field is gone); `safeParse` fails and readers fall back to
 * no-preview / plain text — the intended graceful degradation for old rows.
 */
export const documentContextSchema = z.preprocess(
  (val) => {
    if (val && typeof val === "object" && !Array.isArray(val) && !("kind" in val) && "basePath" in val) {
      return { kind: "path", ...(val as Record<string, unknown>) };
    }
    return val;
  },
  z.discriminatedUnion("kind", [snapshotDocumentContextSchema, pathDocumentContextSchema]),
);
export type DocumentContext = z.infer<typeof documentContextSchema>;

export const getMeDocSchema = z.object({
  agentId: z.string().trim().min(1),
  basePath: z.string().trim().optional(),
  path: z.string().trim().min(1),
});
export type GetMeDoc = z.infer<typeof getMeDocSchema>;

export const getMeDocResponseSchema = z.object({
  ref: workspaceDocRefSchema,
  path: z.string(),
  content: z.string(),
});
export type GetMeDocResponse = z.infer<typeof getMeDocResponseSchema>;
