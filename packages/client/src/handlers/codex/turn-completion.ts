import type { SessionMessage } from "../../runtime/handler.js";

export const LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED = "landing_trial_turn_completion_confirm_failed";

export class LandingTrialTurnCompletionConfirmError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "LandingTrialTurnCompletionConfirmError";
    this.cause = cause;
  }
}

export function turnCompletionIdForMessages(messages: readonly SessionMessage[]): string {
  const parts = messages.map((message) =>
    message.inboxEntryId !== undefined ? `inbox:${message.inboxEntryId}` : `message:${message.id}`,
  );
  if (parts.length === 0) throw new Error("cannot build a turn completion id without messages");
  return parts.join("+");
}
