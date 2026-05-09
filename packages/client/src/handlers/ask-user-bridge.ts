import { questionAnswerMessageContentSchema } from "@agent-team-foundation/first-tree-hub-shared";

/**
 * Module-singleton bridge between the Claude Agent SDK `AskUserQuestion`
 * tool and Hub's inbox / question-answer round-trip.
 *
 * Lifecycle for one question:
 *   1. The Claude handler's `canUseTool` callback intercepts the tool call,
 *      sends a `format: "question"` message via the SDK upstream, and calls
 *      {@link registerPendingQuestion} with the SDK's `toolUseID` as the
 *      correlation key.
 *   2. The Promise stays unresolved until the matching `question_answer`
 *      message arrives via the inbox WS / poll path. SessionManager.dispatch
 *      short-circuits that message kind into {@link tryResolveQuestionAnswer},
 *      which decodes the answers and resolves the Promise.
 *   3. The handler resumes and returns `{ behavior: "allow", updatedInput:
 *      { questions, answers } }` to the SDK; the model carries on as if the
 *      user had typed those answers directly.
 *
 * The Map is process-wide so a session that suspends/resumes during the wait
 * window keeps the same correlation key working — `agentId` is only used to
 * scope the {@link rejectPendingForAgent} cleanup on full handler shutdown.
 *
 * The Promise contract is `{ status: "answered", answers }` for a normal
 * answer or `{ status: "denied", reason }` when the question has been
 * superseded (chat archived, client claimed) or the handler is going down.
 * The handler maps these to `{ behavior: "allow", updatedInput }` or
 * `{ behavior: "deny", message }` for the SDK callback.
 */

export type BridgeAnswerResult =
  | { status: "answered"; answers: Record<string, string> }
  | { status: "denied"; reason: string };

type PendingEntry = {
  agentId: string;
  chatId: string;
  registeredAt: number;
  resolve: (result: BridgeAnswerResult) => void;
};

const pending = new Map<string, PendingEntry>();

/**
 * Register a Promise that will resolve when the matching `question_answer`
 * message arrives. Same `correlationId` re-registration is treated as the
 * SDK retrying — the previous entry is rejected as superseded so its
 * `canUseTool` callback unblocks.
 */
export function registerPendingQuestion(args: {
  correlationId: string;
  agentId: string;
  chatId: string;
}): Promise<BridgeAnswerResult> {
  const { correlationId, agentId, chatId } = args;
  const existing = pending.get(correlationId);
  if (existing) {
    existing.resolve({ status: "denied", reason: "Question re-registered with the same correlation id." });
  }
  return new Promise<BridgeAnswerResult>((resolve) => {
    pending.set(correlationId, { agentId, chatId, registeredAt: Date.now(), resolve });
  });
}

/**
 * Best-effort resolve. Called by the inbox dispatcher when a
 * `format: "question_answer"` message arrives. Returns `true` when an entry
 * matched (so the caller knows it can ack + skip normal session routing),
 * `false` when there was no waiter (stale answer, e.g. session resumed after
 * the bridge was already cleaned up).
 *
 * Schema validation lives here too — a malformed answer payload is logged
 * (well, `false` returned and the dispatcher emits a warn) but never throws.
 */
export function tryResolveQuestionAnswer(content: unknown): boolean {
  const parsed = questionAnswerMessageContentSchema.safeParse(content);
  if (!parsed.success) return false;
  const entry = pending.get(parsed.data.correlationId);
  if (!entry) return false;
  pending.delete(parsed.data.correlationId);
  entry.resolve({ status: "answered", answers: parsed.data.answers });
  return true;
}

/** Cleanup hook used by handler.shutdown() to fail-fast every in-flight question. */
export function rejectPendingForAgent(agentId: string, reason: string): number {
  let count = 0;
  for (const [correlationId, entry] of pending) {
    if (entry.agentId !== agentId) continue;
    pending.delete(correlationId);
    entry.resolve({ status: "denied", reason });
    count++;
  }
  return count;
}

/** Test-only: snapshot the current pending count. Lets unit tests verify
 *  cleanup without exposing the Map itself. */
export function pendingQuestionCount(): number {
  return pending.size;
}

/** Test-only: drain everything (used by integration tests between cases so a
 *  leaked entry doesn't bleed across test boundaries). */
export function clearAllPendingQuestionsForTest(): void {
  for (const [, entry] of pending) {
    entry.resolve({ status: "denied", reason: "Test cleanup." });
  }
  pending.clear();
}
