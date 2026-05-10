import { api } from "./client.js";

export type SubmitQuestionAnswerResponse = {
  correlationId: string;
  messageId: string;
};

/**
 * Submit answers to a pending agent-emitted question.
 *
 * Mirrors `POST /api/v1/chats/:chatId/questions/:correlationId/answer`
 * (commit 2). Returns the new `format=question_answer` message id so the
 * UI can optimistically pin the answered state without round-tripping
 * through the message list query.
 *
 * Errors propagate verbatim (api client throws `ApiError` for non-2xx);
 * common shapes:
 *   - 409 — question is no longer pending (already answered or superseded)
 *   - 400 — answer keys don't match the original questions
 *   - 404 — wrong chatId / unknown correlationId
 */
export function submitQuestionAnswer(
  chatId: string,
  correlationId: string,
  answers: Record<string, string>,
): Promise<SubmitQuestionAnswerResponse> {
  return api.post<SubmitQuestionAnswerResponse>(
    `/chats/${encodeURIComponent(chatId)}/questions/${encodeURIComponent(correlationId)}/answer`,
    { answers },
  );
}
