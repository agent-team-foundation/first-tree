import type {
  InboxEntryWithMessage,
  InReplyToSnapshot,
  PrecedingMessage,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { SessionMessage } from "../runtime/handler.js";

/**
 * Minimal stub for the runtime-provided `SessionContext` plumbing fields
 * (forwardResult / buildAgentEnv / formatInboundContent / resolveSenderLabel).
 * Keeps legacy tests — which pre-date the runtime migration and still assert
 * directly on `sdk.sendMessage` — green without duplicating the stub in every
 * file.
 *
 * The stubbed `forwardResult` just proxies to `sdk.sendMessage` with no
 * enrichment — it's deliberately not a faithful copy of the real result-sink
 * (mentions / inReplyTo / trigger lookup live in the runtime). Tests that
 * need enrichment coverage should exercise the real sink in
 * `result-sink.test.ts` instead of going through the handler.
 *
 * The stubbed name-resolution path returns the raw senderId — the production
 * `[From: <name>]` path is covered separately in `agent-io.test.ts`.
 */
export function mockCtxPlumbing(
  sdk: { sendMessage: (chatId: string, body: Record<string, unknown>) => Promise<unknown> },
  chatId: string,
): {
  forwardResult: (text: string) => Promise<void>;
  buildAgentEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  formatInboundContent: (msg: SessionMessage) => Promise<string>;
  resolveSenderLabel: (senderId: string) => Promise<string>;
} {
  return {
    forwardResult: async (text: string) => {
      await sdk.sendMessage(chatId, { format: "text", content: text });
    },
    buildAgentEnv: (env) => env,
    formatInboundContent: async (msg) => {
      const raw = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return msg.senderId ? `[From: ${msg.senderId}]\n\n${raw}` : raw;
    },
    resolveSenderLabel: async (senderId) => senderId,
  };
}

/** Create a mock inbox entry for testing. */
export function mockEntry(
  opts: {
    id?: number;
    chatId?: string;
    content?: string;
    senderId?: string;
    inReplyTo?: string | null;
    inReplyToSnapshot?: InReplyToSnapshot;
    recipientMode?: "full" | "mention_only";
    metadata?: Record<string, unknown>;
    precedingMessages?: PrecedingMessage[];
    /** Override the derived `message.id` — needed when two entries share a
     * messageId but differ on chatId (the replyTo cross-chat routing shape). */
    messageId?: string;
  } = {},
): InboxEntryWithMessage {
  const chatId = opts.chatId ?? "chat-1";
  const messageId = opts.messageId ?? `msg-${opts.id ?? 1}`;
  return {
    id: opts.id ?? 1,
    inboxId: "inbox-test",
    messageId,
    chatId,
    status: "delivered",
    retryCount: 0,
    createdAt: new Date().toISOString(),
    deliveredAt: new Date().toISOString(),
    ackedAt: null,
    message: {
      id: messageId,
      chatId,
      senderId: opts.senderId ?? "sender-1",
      format: "text",
      content: opts.content ?? "hello",
      metadata: opts.metadata ?? {},
      replyToInbox: null,
      replyToChat: null,
      inReplyTo: opts.inReplyTo ?? null,
      source: null,
      createdAt: new Date().toISOString(),
      configVersion: 1,
      recipientMode: opts.recipientMode ?? "full",
      inReplyToSnapshot: opts.inReplyToSnapshot ?? null,
      precedingMessages: opts.precedingMessages ?? [],
    },
  };
}
