/**
 * Resolve `replyTo` envelope fields for `agent send`. When the CLI is invoked
 * from inside a claude-code session (the handler exports
 * `FIRST_TREE_HUB_CHAT_ID` + `FIRST_TREE_HUB_INBOX_ID`), default the reply
 * target to the calling session's own chat so the peer's reply routes back
 * to the caller rather than echoing in the peer-created direct chat.
 *
 * Explicit `--reply-to-*` flags always win. See proposals/
 * hub-agent-messaging-reply-and-mentions §3.2.
 */
export function resolveReplyToFromEnv(
  env: NodeJS.ProcessEnv,
  override: { replyToInbox?: string; replyToChat?: string },
): { replyToInbox: string | undefined; replyToChat: string | undefined } {
  const envChatId = env.FIRST_TREE_HUB_CHAT_ID;
  const envInboxId = env.FIRST_TREE_HUB_INBOX_ID;
  const envComplete = Boolean(envChatId && envInboxId);
  return {
    replyToInbox: override.replyToInbox ?? (envComplete ? envInboxId : undefined),
    replyToChat: override.replyToChat ?? (envComplete ? envChatId : undefined),
  };
}
