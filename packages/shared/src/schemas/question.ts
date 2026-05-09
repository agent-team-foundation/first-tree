import { z } from "zod";

/**
 * Structured ask-user payloads bridged from the Claude Agent SDK
 * `AskUserQuestion` tool to Hub messages.
 *
 * Shape mirrors the SDK 0.2.84 input/output verbatim so the client
 * runtime adapter can pass `updatedInput` straight through. See
 * verify scripts under `packages/client/tmp-verify/` for the live
 * matrix this was validated against.
 *
 * Lifecycle:
 *  1. Agent emits a `format: "question"` message — its `content` is a
 *     `QuestionMessageContent` carrying `correlationId` + `questions[]`.
 *  2. User picks options in the Web UI and POSTs answers; server writes
 *     a `format: "question_answer"` message — its `content` is a
 *     `QuestionAnswerMessageContent` referencing the same `correlationId`.
 *  3. Client runtime resolves the in-flight `canUseTool` promise with the
 *     answers, and the SDK feeds them back to the model.
 *
 * `pending → answered → superseded` runtime status lives in a separate
 * server table (`pending_questions`) and is not part of the message —
 * messages are immutable once written.
 */

/**
 * Single option inside a question. `preview` is rich content rendered above
 * the label — the SDK's tool input emits it as `string | undefined` (the
 * field is omitted when the model didn't generate any preview content), so
 * we accept undefined / null / string and normalise downstream renderers
 * to treat all three the same way.
 */
export const questionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string(),
  /** SDK-emitted HTML or Markdown snippet. Optional — the SDK omits this field when there's no preview. */
  preview: z.string().nullable().optional(),
});
export type QuestionOption = z.infer<typeof questionOptionSchema>;

/**
 * One question. `header` is a chip-style short tag. The SDK schema docs
 * describe ≤12 chars but in practice the model occasionally emits
 * slightly longer headers; we keep the rule loose (≤24) so a stylistic
 * regression doesn't fail-closed at canUseTool and abandon the entire
 * tool call. The UI truncates visually if needed.
 */
export const questionItemSchema = z.object({
  /** The question text. Used as the answer-dictionary key in `QuestionAnswerMessageContent.answers`. */
  question: z.string().min(1),
  header: z.string().min(1).max(24),
  options: z.array(questionOptionSchema).min(2).max(4),
  multiSelect: z.boolean(),
});
export type QuestionItem = z.infer<typeof questionItemSchema>;

/** Session-level preview format hint. Mirrors `toolConfig.askUserQuestion.previewFormat`. */
export const questionPreviewFormatSchema = z.enum(["html", "markdown"]).nullable();
export type QuestionPreviewFormat = z.infer<typeof questionPreviewFormatSchema>;

/**
 * Content payload for a message whose `format === "question"`.
 *
 * `correlationId` ties the question to its eventual answer message AND to the
 * server-side `pending_questions` row; client runtime uses it to resolve the
 * waiting `canUseTool` promise. Reuse the SDK `tool_use_id` when available so
 * a single id flows end-to-end.
 */
export const questionMessageContentSchema = z.object({
  correlationId: z.string().min(1),
  questions: z.array(questionItemSchema).min(1).max(4),
  previewFormat: questionPreviewFormatSchema,
  /** Whether the UI should append a fixed "Other..." free-text choice to every question. v1 fixed `true`. */
  allowFreeText: z.boolean(),
});
export type QuestionMessageContent = z.infer<typeof questionMessageContentSchema>;

/**
 * Content payload for a message whose `format === "question_answer"`.
 *
 * `answers` is keyed by `QuestionItem.question` text. For `multiSelect` questions
 * the value is a `, `-joined string of selected labels (matches SDK convention).
 * For free-text answers the value is the user's raw input.
 */
export const questionAnswerMessageContentSchema = z.object({
  correlationId: z.string().min(1),
  answers: z.record(z.string().min(1), z.string()),
});
export type QuestionAnswerMessageContent = z.infer<typeof questionAnswerMessageContentSchema>;

/** Submit-answer request body for `POST /api/admin/questions/:correlationId/answer`. */
export const submitQuestionAnswerSchema = z.object({
  answers: z.record(z.string().min(1), z.string()),
});
export type SubmitQuestionAnswer = z.infer<typeof submitQuestionAnswerSchema>;

/** Lifecycle status of a question (server-side, not in message schema). */
export const QUESTION_STATUSES = {
  PENDING: "pending",
  ANSWERED: "answered",
  SUPERSEDED: "superseded",
} as const;
export const questionStatusSchema = z.enum(["pending", "answered", "superseded"]);
export type QuestionStatus = z.infer<typeof questionStatusSchema>;
