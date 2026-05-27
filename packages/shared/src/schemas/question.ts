import { z } from "zod";

/**
 * Surviving pending-question type vocabulary.
 *
 * NHA M0 cleanup removed the chat-internal ask-user payload (SDK bridge +
 * `format=question` / `format=question_answer` content schemas + answer
 * submission DTO). What remains is the `pending_questions` lifecycle status
 * — kept because the table itself stays in place (the needs-you chat-list
 * signal is reused by the NHA primitive in M1 末).
 */

export const QUESTION_STATUSES = {
  PENDING: "pending",
  ANSWERED: "answered",
  SUPERSEDED: "superseded",
} as const;
export const questionStatusSchema = z.enum(["pending", "answered", "superseded"]);
export type QuestionStatus = z.infer<typeof questionStatusSchema>;
