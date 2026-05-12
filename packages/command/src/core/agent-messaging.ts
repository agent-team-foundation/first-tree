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

/**
 * Resolve which locally-configured agent the CLI should authenticate as
 * (the SENDER) for an outbound `agent send` / `agent chats` / etc. call.
 *
 * Resolution order:
 *   1. Explicit `--agent <name>` override.
 *   2. `FIRST_TREE_HUB_AGENT_ID` env — set by the runtime when the CLI is
 *      shelled out from inside an agent sub-process. Reverse-look the uuid
 *      back to a local agent name. Without this, a multi-agent client (e.g.
 *      one machine running both `architect` and `developer`) forces every
 *      sub-process call to repeat `--agent <name>`, which trips up LLMs that
 *      don't realise their own identity is already in env (issue #192).
 *   3. The single configured agent on this machine (no ambiguity).
 *   4. Otherwise: no automatic pick — caller must select with `--agent`.
 *
 * Pure / IO-free so the four resolution branches can be unit-pinned without
 * mocking the filesystem; the caller (`commands/agent.ts`) maps each kind to
 * its own CLI exit message.
 */
export type ResolveSenderResult =
  | { kind: "ok"; name: string }
  | { kind: "none" }
  | { kind: "ambiguous"; available: string[] }
  | { kind: "envMismatch"; envAgentId: string; available: string[] };

export function resolveSenderName(input: {
  override?: string;
  envAgentId?: string;
  agents: ReadonlyMap<string, { agentId: string }>;
}): ResolveSenderResult {
  const { override, envAgentId, agents } = input;

  if (agents.size === 0) return { kind: "none" };

  if (override) return { kind: "ok", name: override };

  if (envAgentId) {
    for (const [name, cfg] of agents) {
      if (cfg.agentId === envAgentId) return { kind: "ok", name };
    }
    // Env says we're agent <uuid> but no local config matches it. Could be
    // a fresh agent the user hasn't `agent add`-ed locally yet, or stale env
    // leaking from a sibling process. Fall through with a hint instead of
    // silently picking the wrong agent.
    return { kind: "envMismatch", envAgentId, available: [...agents.keys()] };
  }

  if (agents.size === 1) {
    const [only] = [...agents.keys()];
    if (only) return { kind: "ok", name: only };
  }

  return { kind: "ambiguous", available: [...agents.keys()] };
}
