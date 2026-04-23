import type { ChatParticipantDetail } from "@agent-team-foundation/first-tree-hub-shared";
import type { FirstTreeHubSDK } from "../sdk.js";
import type { AgentIdentity } from "./handler.js";

/**
 * Forward-to-chat sink — the single place that owns "handler produced a final
 * text, now turn it into a wire message". Lives in the runtime layer so
 * every handler (Claude Code today, Gemini / Cursor / custom tomorrow) reuses
 * the same enrichment:
 *
 * - `inReplyTo` is pulled from the current trigger (the message that kicked
 *   off this turn), so peers that threaded via reply routing see the answer
 *   in their waiting chat — see proposals/hub-agent-messaging-reply-and-mentions §3.4.
 * - In `mention_only` group chats the trigger sender is added to the outbound
 *   mention list so the server's fan-out filter routes the reply back to them
 *   even if the handler didn't explicitly `@` them.
 *
 * Content-level `@<name>` resolution (extracting tokens and cross-validating
 * against the participant list) is the server's job — see
 * `services/message.ts sendMessage`. The server merges its resolved mentions
 * with whatever we pass in metadata, so this sink only needs to contribute
 * the *default* mention a handler can't know about (the trigger sender).
 */

export type Trigger = { messageId: string; senderId: string };

export type ResultSinkDeps = {
  sdk: FirstTreeHubSDK;
  agent: AgentIdentity;
  chatId: string;
  /** Reads the current trigger (managed by session-manager). Returning
   *  `null` means the handler's reply is unprompted — typically on resume
   *  with no new message, or post-shutdown. */
  getTrigger: () => Trigger | null;
  /** Called by the sink to clear the trigger before awaiting the transport,
   *  so a concurrently-arriving inject() can set a fresh trigger without this
   *  reply consuming it. */
  clearTrigger: () => void;
  log: (msg: string) => void;
};

export type ResultSink = (text: string) => Promise<void>;

export function createResultSink(deps: ResultSinkDeps): ResultSink {
  // Lazy participants cache scoped to this session. We only need it to
  // decide "is this chat a group?" (default-mention rule applies) — the
  // server handles `@name` resolution from the content itself.
  let participantsCache: ChatParticipantDetail[] | null = null;
  let participantsFetch: Promise<ChatParticipantDetail[]> | null = null;

  async function getParticipants(): Promise<ChatParticipantDetail[]> {
    if (participantsCache) return participantsCache;
    if (!participantsFetch) {
      // Wrap in async IIFE so sync throws from SDK mocks without
      // `listChatParticipants` resolve to [] rather than break auto-forward.
      participantsFetch = (async () => {
        try {
          const rows = await deps.sdk.listChatParticipants(deps.chatId);
          participantsCache = rows;
          return rows;
        } catch (err) {
          deps.log(`listChatParticipants failed: ${err instanceof Error ? err.message : String(err)}`);
          return [];
        } finally {
          participantsFetch = null;
        }
      })();
    }
    return participantsFetch;
  }

  async function buildMetadata(trigger: Trigger | null): Promise<Record<string, unknown> | undefined> {
    // Direct chats (2 participants) never need a default mention — the peer
    // sits in `full` mode so fan-out reaches them regardless.
    if (!trigger || trigger.senderId === deps.agent.agentId) return undefined;
    const participants = await getParticipants();
    if (participants.length <= 2) return undefined;
    return { mentions: [trigger.senderId] };
  }

  return async function forwardResult(text: string): Promise<void> {
    const trigger = deps.getTrigger();
    // Clear BEFORE the await so a concurrent inject() setting a new trigger
    // isn't accidentally attached to this outbound reply.
    deps.clearTrigger();

    const metadata = await buildMetadata(trigger);

    await deps.sdk.sendMessage(deps.chatId, {
      format: "text",
      content: text,
      ...(trigger ? { inReplyTo: trigger.messageId } : {}),
      ...(metadata ? { metadata } : {}),
    });
  };
}
