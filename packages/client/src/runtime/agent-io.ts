import type { FirstTreeHubSDK } from "../sdk.js";
import type { AgentIdentity, SessionMessage } from "./handler.js";

/**
 * Cross-handler plumbing for Agent Hub ↔ agent-runtime interaction.
 *
 * Every handler that shells out to the `first-tree-hub` CLI or otherwise acts
 * on behalf of the agent needs the same envelope variables (server URL, agent
 * id, inbox id, chat id). And every handler that hands inbound messages to an
 * LLM benefits from the same `[From: sender-id]` attribution header so the
 * LLM can see who authored each message.
 *
 * Keeping these helpers in one place means adding a second handler (Gemini,
 * Cursor Agent, custom LLM, …) does not reimplement either concern.
 */

/**
 * Build the env for CLI sub-processes that need to call `first-tree-hub ...`.
 * Layers the Agent-Hub envelope variables on top of the parent env. Handlers
 * that start sub-processes should call this so every one of them sees the
 * same envelope — enabling replyTo inference, access-token propagation, and
 * agent-id binding without per-handler duplication.
 */
export function buildAgentEnv(
  parentEnv: NodeJS.ProcessEnv,
  ctx: { sdk: Pick<FirstTreeHubSDK, "serverUrl">; agent: AgentIdentity; chatId: string },
): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    FIRST_TREE_HUB_SERVER_URL: ctx.sdk.serverUrl,
    FIRST_TREE_HUB_AGENT_ID: ctx.agent.agentId,
    FIRST_TREE_HUB_INBOX_ID: ctx.agent.inboxId,
    FIRST_TREE_HUB_CHAT_ID: ctx.chatId,
  };
}

/**
 * Produce the handler-facing string form of an inbound message. Prefixes a
 * `[From: <senderId>]` line when the sender is known so the LLM can
 * distinguish messages from different team members. Structured content is
 * serialised to JSON — handlers that want to feed structured content some
 * other way should opt out and format themselves.
 */
export function formatInboundContent(message: SessionMessage): string {
  const rawContent = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  return message.senderId ? `[From: ${message.senderId}]\n\n${rawContent}` : rawContent;
}
