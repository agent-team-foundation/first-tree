import { z } from "zod";

/**
 * NHA (Need Human Attention) — agent → human attention primitive.
 *
 * An Attention is a structured "I need a human" event raised by an agent.
 * It is chat-bound, targets exactly one human, and carries either a request
 * (`requires_response=true`, expects a reply) or a notification
 * (`requires_response=false`, fire-and-forget). System invariants:
 *
 *   - origin.agent must be a member of origin.chat
 *   - target must be type=human and must be a member of origin.chat
 *     (not-a-member → 409, agent should `chat invite` first)
 *   - only the target can respond
 *   - only the origin.agent can cancel
 *   - closed records are immutable
 *   - requires_response=false → state=closed on creation (notification
 *     does not occupy the "needs your reply" queue)
 *
 * Modification flow: an agent that needs to revise / supersede an open
 * Attention `cancel`s the old one and `raise`s a new one — there is no
 * SUPERSEDED state and no replacement chain. The new Attention's `body`
 * explains the relationship to humans.
 *
 * Decoupling from `messages`: attention owns its own content (`subject`
 * / `body` / `response`) — it never references a `messages` row and a
 * raise never writes a chat message. Two state machines, two substrates:
 *
 *   - **Messages** are append-only chat artefacts with edit / delete,
 *     @mention parsing, attachments, search index. Audience: chat
 *     speakers, broad.
 *   - **Attention** is a structured contract with state machine (open →
 *     closed) and lifecycle hooks (raise / respond / cancel). Audience:
 *     exactly one target human + the origin agent.
 *
 * Resulting design choices, all intentional:
 *
 *   - `@<name>` tokens in `body` are NOT parsed and DO NOT fire
 *     notifications. Attention already names its target; mention would
 *     break the single-target invariant. Raise a separate attention or
 *     post a normal chat message if you need a second human's eyes.
 *   - Attachments ride on `metadata` (extensible bag with catchall);
 *     the convention lives in the skill, not in this schema.
 *   - Search over attentions is a follow-up; it does not piggyback on
 *     the messages search pipeline.
 *   - Chat archive does NOT cascade-delete attentions. Closed records
 *     remain as audit; raising new attentions in an archived chat is
 *     refused by the speaker-membership gate.
 *   - **Asks do not enter the chat stream; replies do.** Per proposal
 *     §5.1, raising an attention is silent in chat (no message is
 *     written). Responding, by contrast, posts a normal chat message
 *     with the human as `sender_id` so the conversation thread carries
 *     the decision inline — co-speakers see "alice answered: deploy"
 *     without having to dig into the sidebar's closed-attention view.
 *     The message is a best-effort echo; `attentions.response` is the
 *     canonical authoritative value.
 *
 * For the design rationale see proposals/nha-need-human-attention.md.
 */

// ---------------------------------------------------------------------------
// Metadata bag — extensible, fields are convention-driven, agent-author-set.
// Agents are expected to use these patterns where they fit; UI degrades to
// free-text rendering when a field isn't recognised. The `catchall` keeps
// forward-rolling agents from being rejected by an older server validator.
// ---------------------------------------------------------------------------

/** A single selectable option presented to the human. */
export const attentionOptionItemSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  /** Optional one-line hint shown beneath the label. */
  hint: z.string().optional(),
  /** Some options collect typed input from the human. */
  input: z
    .object({
      type: z.enum(["text", "number", "datetime"]),
      required: z.boolean().optional(),
      placeholder: z.string().optional(),
    })
    .optional(),
});
export type AttentionOptionItem = z.infer<typeof attentionOptionItemSchema>;

/** A group of selectable options for one decision point. */
export const attentionOptionGroupSchema = z.object({
  mode: z.enum(["single", "multi"]),
  /** Minimum number of selections required (multi-mode). */
  min: z.number().int().nonnegative().optional(),
  /** Maximum number of selections allowed (multi-mode). */
  max: z.number().int().positive().optional(),
  /** Pre-selected default value(s). UI may surface this as a one-click action. */
  defaultValue: z.union([z.string(), z.array(z.string())]).optional(),
  items: z.array(attentionOptionItemSchema).min(1),
});
export type AttentionOptionGroup = z.infer<typeof attentionOptionGroupSchema>;

/**
 * One decision point inside a multi-question Attention. Each question has
 * its own prompt + options. The Attention as a whole is submitted atomically
 * once all questions are answered. (M1 末 UI renders a single top-level
 * question; multi-question support lands in M2 初.)
 */
export const attentionQuestionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  /** Optional background specific to this sub-question. */
  context: z.string().optional(),
  options: attentionOptionGroupSchema.optional(),
});
export type AttentionQuestion = z.infer<typeof attentionQuestionSchema>;

/**
 * The extensible metadata bag. Every field is optional; agents add what they
 * have. `.catchall(z.unknown())` lets the schema accept unknown keys so an
 * agent on a newer convention is not rejected by an older server build.
 */
export const attentionMetadataSchema = z
  .object({
    /** Top-level options when the Attention is a single decision. */
    options: attentionOptionGroupSchema.optional(),
    /** Multi-question Attention: each entry has its own prompt + options. */
    questions: z.array(attentionQuestionSchema).optional(),
    /** Free-form hint about how long the agent intends to wait. e.g. "4h". */
    timeoutHint: z.string().optional(),
    /** Free-form description of the answer's binding scope. e.g. "this commit". */
    validityScope: z.string().optional(),
    /** Free-form description of what the agent will do on timeout. */
    fallback: z.string().optional(),
    /** Free-form tag list, e.g. ["endorse", "deploy"]. UI may filter on these. */
    tags: z.array(z.string()).optional(),
  })
  .catchall(z.unknown());
export type AttentionMetadata = z.infer<typeof attentionMetadataSchema>;

// ---------------------------------------------------------------------------
// Lifecycle state
// ---------------------------------------------------------------------------

export const ATTENTION_STATES = {
  OPEN: "open",
  CLOSED: "closed",
} as const;
export const attentionStateSchema = z.enum(["open", "closed"]);
export type AttentionState = z.infer<typeof attentionStateSchema>;

// ---------------------------------------------------------------------------
// Wire shape — the canonical Attention record returned by the API.
// Timestamps are ISO-8601 strings (Postgres timestamptz → JSON string).
// ---------------------------------------------------------------------------

export const attentionRecordSchema = z.object({
  id: z.string(),
  /** Agent that raised the Attention. Must be a member of `originChatId`. */
  originAgentId: z.string(),
  /** Chat the Attention is anchored to. */
  originChatId: z.string(),
  /** Single human target. Must be a member of `originChatId` at raise time. */
  targetHumanId: z.string(),
  subject: z.string().min(1).max(500),
  body: z.string(),
  /** true = request (expects respond), false = notification (closed on creation). */
  requiresResponse: z.boolean(),
  state: attentionStateSchema,
  /** Human-supplied response, when answered. Free text by default. */
  response: z.string().nullable(),
  respondedBy: z.string().nullable(),
  respondedAt: z.string().nullable(),
  /** True when the origin agent cancelled the Attention. */
  cancelled: z.boolean(),
  cancelledReason: z.string().nullable(),
  metadata: attentionMetadataSchema,
  createdAt: z.string(),
  closedAt: z.string().nullable(),
});
export type Attention = z.infer<typeof attentionRecordSchema>;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/** Body for `POST /api/attention`. */
export const raiseAttentionInputSchema = z.object({
  chatId: z.string().min(1),
  /** Target human's agent id. Server rejects non-human or non-member targets. */
  target: z.string().min(1),
  subject: z.string().min(1).max(500),
  body: z.string().default(""),
  requiresResponse: z.boolean().default(false),
  metadata: attentionMetadataSchema.default({}),
});
export type RaiseAttentionInput = z.infer<typeof raiseAttentionInputSchema>;

/**
 * Body for `POST /api/attention/:id/respond`.
 *
 * One of `text` or `answers` must be present. `text` is the free-form path
 * and is always allowed. `answers` is a structured object keyed by question
 * id (or "default" for single-question), with values whose shape depends on
 * the agent-provided options — server does NOT validate the shape so that
 * the convention can evolve in skill without a schema bump. The server
 * stringifies `answers` into the stored `response` field if `text` is absent.
 */
export const respondAttentionInputSchema = z
  .object({
    text: z.string().min(1).optional(),
    answers: z.record(z.string().min(1), z.unknown()).optional(),
  })
  .refine((v) => v.text != null || v.answers != null, {
    message: "Either `text` or `answers` is required",
  });
export type RespondAttentionInput = z.infer<typeof respondAttentionInputSchema>;

/** Body for `POST /api/attention/:id/cancel`. */
export const cancelAttentionInputSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type CancelAttentionInput = z.infer<typeof cancelAttentionInputSchema>;

/** Query params for `GET /api/attention`. */
export const listAttentionsQuerySchema = z.object({
  /** Filter by target human id. */
  target: z.string().optional(),
  /** Filter by chat id. */
  chat: z.string().optional(),
  /** Filter by origin agent id. */
  agent: z.string().optional(),
  /** state="all" returns both open and closed. Default "open". */
  state: z.enum(["open", "closed", "all"]).default("open"),
  limit: z.coerce.number().int().positive().max(200).default(50),
  /**
   * Pagination cursor — ISO-8601 timestamp from the last row of the previous
   * page (e.g. `attentions[attentions.length-1].createdAt`). Server returns
   * rows strictly older than this cursor. Omit for the first page.
   */
  cursor: z.string().datetime().optional(),
});
export type ListAttentionsQuery = z.infer<typeof listAttentionsQuerySchema>;

// ---------------------------------------------------------------------------
// WebSocket frames
// ---------------------------------------------------------------------------

/**
 * Emitted to the target human's connections when an Attention is raised
 * (or, for notifications, immediately on creation). The web client refetches
 * the per-chat attention list on receipt; the CLI may use it as a wake-up
 * signal for a `--watch` mode (M2).
 */
export const attentionOpenedFrameSchema = z
  .object({
    type: z.literal("attention:opened"),
    attentionId: z.string(),
    chatId: z.string(),
    targetHumanId: z.string(),
    requiresResponse: z.boolean(),
  })
  .passthrough();
export type AttentionOpenedFrame = z.infer<typeof attentionOpenedFrameSchema>;

/**
 * Emitted to the target human's connections when the origin agent cancels
 * an open Attention. The UI removes the "needs you" indicator without
 * waiting for a list refetch.
 */
export const attentionCancelledFrameSchema = z
  .object({
    type: z.literal("attention:cancelled"),
    attentionId: z.string(),
    targetHumanId: z.string(),
    reason: z.string().nullable(),
  })
  .passthrough();
export type AttentionCancelledFrame = z.infer<typeof attentionCancelledFrameSchema>;
