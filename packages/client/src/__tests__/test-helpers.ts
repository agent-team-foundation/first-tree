import type { InboxEntryWithMessage } from "@agent-team-foundation/first-tree-hub-shared";

/** Create a mock inbox entry for testing. */
export function mockEntry(opts: { id?: number; chatId?: string; content?: string } = {}): InboxEntryWithMessage {
  const chatId = opts.chatId ?? "chat-1";
  return {
    id: opts.id ?? 1,
    inboxId: "inbox-test",
    messageId: `msg-${opts.id ?? 1}`,
    chatId,
    status: "delivered",
    retryCount: 0,
    createdAt: new Date().toISOString(),
    deliveredAt: new Date().toISOString(),
    ackedAt: null,
    message: {
      id: `msg-${opts.id ?? 1}`,
      chatId,
      senderId: "sender-1",
      format: "text",
      content: opts.content ?? "hello",
      metadata: {},
      replyToInbox: null,
      replyToChat: null,
      inReplyTo: null,
      source: null,
      createdAt: new Date().toISOString(),
      configVersion: 1,
    },
  };
}
