import type { FastifyInstance } from "fastify";
import type { Database } from "../db/connection.js";
import {
  type DeferredSendMessagePostCommitEffects,
  runDeferredSendMessagePostCommitEffects,
  sendMessage,
} from "./message.js";
import { notifyRecipients } from "./notifier.js";

export type DeferredScmCardPostCommitEffects = {
  messageId: string;
  recipients: string[];
  messageEffects: DeferredSendMessagePostCommitEffects;
};

/** Generic trusted SCM card side effect. Provider adapters still own planning and card content. */
export async function sendScmSystemCard(
  app: FastifyInstance,
  input: {
    chatId: string;
    senderId: string;
    provider: "github" | "gitlab";
    content: unknown;
    metadata: Record<string, unknown>;
    database?: Database;
    deferPostCommitEffects?: boolean;
  },
) {
  const sent = await sendMessage(
    input.database ?? app.db,
    input.chatId,
    input.senderId,
    {
      format: "card",
      content: input.content,
      source: input.provider,
      metadata: { ...input.metadata, source: input.provider, systemSender: input.provider },
    },
    {
      allowSystemSender: true,
      allowRecipientlessSend: true,
      dropInactiveMentionTargets: true,
      deferPostCommitEffects: input.deferPostCommitEffects,
    },
  );
  const { message, recipients } = sent;
  if (input.deferPostCommitEffects) {
    if (!sent.deferredPostCommitEffects) {
      throw new Error("Deferred SCM card send did not return post-commit effects");
    }
    return {
      message,
      recipients,
      deferredPostCommitEffects: {
        messageId: message.id,
        recipients,
        messageEffects: sent.deferredPostCommitEffects,
      } satisfies DeferredScmCardPostCommitEffects,
    };
  }
  notifyRecipients(app.notifier, recipients, message.id);
  return { message, recipients };
}

/** Flush external message effects only after the caller's outer transaction commits. */
export async function runDeferredScmCardPostCommitEffects(
  app: FastifyInstance,
  effects: DeferredScmCardPostCommitEffects,
): Promise<void> {
  await runDeferredSendMessagePostCommitEffects(app.db, effects.messageEffects);
  notifyRecipients(app.notifier, effects.recipients, effects.messageId);
}
