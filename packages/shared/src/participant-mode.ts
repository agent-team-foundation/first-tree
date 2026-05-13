import type { AgentType } from "./schemas/agent.js";
import type { ChatType } from "./schemas/chat.js";
import type { ParticipantMode } from "./schemas/message.js";

/**
 * Derive the `chat_membership.mode` that a freshly inserted speaker row MUST
 * get, given the chat's `type` and the joining agent's `type`. This is the
 * single authoritative rule for the invariant
 *
 *   `(chat.type === 'group' && agent.type !== 'human') ⇒ mode === 'mention_only'`
 *
 * plus the legacy "agent-only direct chat" anti-echo rule. The helper is
 * pure and synchronous; all DB lookups are the caller's responsibility (see
 * `services/participant-mode.ts::addChatParticipants` for the canonical
 * server entrypoint that wires it).
 *
 * Rule (encoded once, here):
 *
 *   - `agent.type === 'human'`                          → 'full'
 *   - `chat.type  === 'group'` (and agent is non-human) → 'mention_only'
 *   - `chat.type  === 'direct'` + agent non-human:
 *       - if every other participant on this chat is also non-human →
 *         'mention_only' (prevents the A↔B reply loop noted in migration
 *         0029)
 *       - otherwise → 'full' (the peer is a human / external user, so the
 *         agent should listen to every message in this 1:1 line)
 *
 * `peerAgentTypes` is read only in the `direct` branch; callers may pass
 * an empty array (or omit it) for `group` chats — it's ignored. Watcher
 * rows (`chat_membership.access_mode = 'watcher'`) are unaffected; the
 * helper only governs the "speaking" mode column.
 */
export function defaultParticipantMode(
  chatType: ChatType,
  agentType: AgentType,
  peerAgentTypes: ReadonlyArray<AgentType> = [],
): ParticipantMode {
  if (agentType === "human") return "full";
  if (chatType === "group") return "mention_only";
  // chatType === 'direct' + agent non-human:
  const allAgent = peerAgentTypes.every((t) => t !== "human");
  return allAgent ? "mention_only" : "full";
}
