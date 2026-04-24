import type { ChatParticipantDetail } from "@agent-team-foundation/first-tree-hub-shared";
import type { FirstTreeHubSDK } from "../sdk.js";
import type { AgentIdentity, SessionMessage } from "./handler.js";

/**
 * Cross-handler plumbing for Agent Hub ↔ agent-runtime interaction.
 *
 * Every handler that shells out to the `first-tree-hub` CLI or otherwise acts
 * on behalf of the agent needs the same envelope variables (server URL, agent
 * id, inbox id, chat id). And every handler that hands inbound messages to an
 * LLM benefits from the same `[From: <name>]` attribution header so the LLM
 * can see who authored each message in human-readable terms.
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

/** Session-scoped participant cache shared by result-sink and inbound formatter. */
export type ParticipantCache = {
  get: () => Promise<ChatParticipantDetail[]>;
};

export function createParticipantCache(
  sdk: Pick<FirstTreeHubSDK, "listChatParticipants">,
  chatId: string,
  log: (msg: string) => void,
): ParticipantCache {
  let cached: ChatParticipantDetail[] | null = null;
  let inflight: Promise<ChatParticipantDetail[]> | null = null;
  return {
    async get() {
      if (cached) return cached;
      if (!inflight) {
        inflight = (async () => {
          try {
            const rows = await sdk.listChatParticipants(chatId);
            cached = rows;
            return rows;
          } catch (err) {
            log(`listChatParticipants failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
          } finally {
            inflight = null;
          }
        })();
      }
      return inflight;
    },
  };
}

/**
 * Resolve `senderId` → display-friendly label the LLM can actually
 * disambiguate. Prefers `name` (unique per chat, used as the `@<name>`
 * mention token), falls back to `displayName`, then to the raw id. The last
 * fallback matters for edge cases — e.g. a participant removed mid-session
 * after we cached an earlier participants snapshot.
 */
export function resolveSenderLabel(senderId: string, participants: ChatParticipantDetail[]): string {
  for (const p of participants) {
    if (p.agentId !== senderId) continue;
    if (p.name) return p.name;
    if (p.displayName) return p.displayName;
    return senderId;
  }
  return senderId;
}

/**
 * Produce the handler-facing string form of an inbound message. Prefixes a
 * `[From: <name>]` line when the sender is a known participant. Structured
 * content is serialised to JSON — handlers that want to feed structured
 * content some other way should opt out and format themselves.
 *
 * Async because the participant list may need a server round-trip on first
 * use; subsequent messages in the same session hit the cache.
 */
export async function formatInboundContent(message: SessionMessage, participants: ParticipantCache): Promise<string> {
  const rawContent = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  if (!message.senderId) return rawContent;
  const label = resolveSenderLabel(message.senderId, await participants.get());
  return `[From: ${label}]\n\n${rawContent}`;
}
