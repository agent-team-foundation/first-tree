import type { InboxEntryWithMessage, MessageFormat } from "@agent-hub/shared";
import type { InboundMessage } from "./protocol.js";

/** Convert an inbox entry (from Server API) into the NDJSON InboundMessage format. */
export function toInboundMessage(entry: InboxEntryWithMessage): InboundMessage {
  return {
    type: "message",
    entryId: entry.id,
    chatId: entry.chatId ?? entry.message.chatId,
    message: {
      id: entry.message.id,
      senderId: entry.message.senderId,
      format: entry.message.format,
      content: entry.message.content,
      metadata: entry.message.metadata as Record<string, unknown>,
      inReplyTo: entry.message.inReplyTo ?? null,
      createdAt: entry.message.createdAt,
    },
  };
}

/** Normalize an optional format string to MessageFormat, defaulting to "text". */
export function toMessageFormat(raw: string | undefined): MessageFormat {
  return (raw ?? "text") as MessageFormat;
}
