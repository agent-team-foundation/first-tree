import type { SessionMessage } from "../../runtime/handler.js";

export function turnCompletionIdForMessages(messages: readonly SessionMessage[]): string {
  const parts = messages.map((message) =>
    message.inboxEntryId !== undefined ? `inbox:${message.inboxEntryId}` : `message:${message.id}`,
  );
  if (parts.length === 0) throw new Error("cannot build a turn completion id without messages");
  return parts.join("+");
}
