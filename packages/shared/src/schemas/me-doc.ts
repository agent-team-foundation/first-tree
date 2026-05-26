import { z } from "zod";
import { isCanonicalDocLinkPath } from "../lib/doc-path.js";

export const workspaceDocRefSchema = z.object({
  type: z.literal("workspace"),
  chatId: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  basePath: z.string().trim().optional(),
  path: z.string().trim().min(1),
});
export type WorkspaceDocRef = z.infer<typeof workspaceDocRefSchema>;

/** Per-message snapshot caps. Server-side byte counting + sha256 calibration
 *  happen in `services/message.ts sendMessage` (these schemas only enforce
 *  shape and `string.length`-based ceilings; cf. proposal §安全与限制). */
export const MAX_DOC_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_DOC_SNAPSHOTS_PER_MESSAGE = 5;
export const MAX_TOTAL_DOC_SNAPSHOT_BYTES = 512 * 1024;

/** Cap on the inert-chip failedMentions list. Existing scanner already caps
 *  per-message mention count via the BARE_PATH regex on a single text body;
 *  this is a hard ceiling against pathological inputs. */
export const MAX_FAILED_DOC_MENTIONS_PER_MESSAGE = 16;
/** Schema-side raw-token length cap. Generous because absolute paths can be
 *  long, but bounded so a misbehaving runtime cannot lodge giant strings. */
export const MAX_FAILED_DOC_MENTION_RAW_LEN = 512;

export const snapshotDocSchema = z.object({
  /**
   * Canonical workspace-relative path — must already be in the form produced
   * by `normalizeDocLinkPath` (POSIX "/" separators, no leading slash, no
   * "./" / ".." segments, no hidden segments). Web link click handlers
   * normalise hrefs through the same helper before cache lookup, so the
   * canonical form is the only one that produces deterministic snapshot
   * hits and a non-canonical value would silently miss.
   *
   * The schema is the trust boundary: even though runtime + web reject
   * non-`.md` paths upstream, server enforces the `.md` suffix here too so
   * a misbehaving (or compromised) runtime cannot lodge arbitrary file
   * paths in immutable message history.
   */
  path: z
    .string()
    .trim()
    .min(1)
    .refine(isCanonicalDocLinkPath, {
      message: "path must be a canonical workspace-relative doc path (no leading /, no ./, no ..)",
    })
    .refine((p) => p.toLowerCase().endsWith(".md"), {
      message: "path must have a .md extension",
    }),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex chars"),
  size: z.number().int().nonnegative(),
  content: z.string(),
});
export type SnapshotDoc = z.infer<typeof snapshotDocSchema>;

/**
 * Why a `.md` mention that LOOKED like a workspace path didn't end up as an
 * inline snapshot. The web renders a disabled "doc chip" in place of the raw
 * token + a reason-mapped tooltip so the failure is visible instead of
 * silently degrading to plain text (and the agent — re-reading its own
 * message — can see WHY the preview didn't materialise).
 *
 * Scanner-static rejections (domain-shaped, fenced code blocks, HTML tag
 * bodies, reference link definitions) do NOT produce failedMentions — those
 * tokens are by design not workspace paths. Only mentions that made it to the
 * runtime resolver AND failed to snapshot are reported.
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

const snapshotDocumentContextSchema = z
  .object({
    kind: z.literal("snapshot"),
    /** Successful snapshots embedded inline. May be empty when ALL mentions
     *  failed — see the refinement below. */
    docs: z.array(snapshotDocSchema).max(MAX_DOC_SNAPSHOTS_PER_MESSAGE).default([]),
    /** Failure roster for inert chip rendering. Optional for backward
     *  compatibility with the pre-Phase-2 schema where only `docs` existed. */
    failedMentions: z.array(failedDocMentionSchema).max(MAX_FAILED_DOC_MENTIONS_PER_MESSAGE).optional(),
  })
  .refine((d) => d.docs.length > 0 || (d.failedMentions?.length ?? 0) > 0, {
    message: "snapshot documentContext must include at least one snapshot or one failedMention",
  });

const pathDocumentContextSchema = z.object({
  kind: z.literal("path"),
  basePath: z.string().trim().min(1),
});

/**
 * `messages.metadata.documentContext` discriminated union.
 *
 * - `kind: "snapshot"` — inline preview content. Each snapshot carries the
 *   markdown body verbatim at the moment the message was sent. Used by
 *   cloud Hub server + local agent runtime topology where the server
 *   cannot read the runtime's workspace filesystem.
 * - `kind: "path"` — PR #356 path-based fallback, only meaningful when
 *   server and runtime share a filesystem (local dev / single-host).
 *
 * Legacy compat: messages written before this schema landed have a bare
 * `{ basePath: string }` (no `kind` field). The preprocessor below
 * normalises that to `{ kind: "path", basePath }` so legacy messages stay
 * parseable without a DB backfill.
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
