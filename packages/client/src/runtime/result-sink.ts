import { documentContextSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FirstTreeHubSDK } from "../sdk.js";
import type { ParticipantCache } from "./agent-io.js";
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
 * - For `mention_only` peers the trigger sender is added to the outbound
 *   mention list so the server's fan-out filter routes the reply back to them
 *   even if the handler didn't explicitly `@` them. This applies in groups
 *   AND in agent↔agent direct chats (both participants are `mention_only`
 *   under migration 0029 to break A↔B reply loops); we skip it in
 *   human↔agent direct chats where the human stays `full` and the prefix
 *   would just be UI noise.
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
  /**
   * Shared participant cache (also consumed by formatInboundContent) — the
   * runtime owns a single fetch per session so both "is this a group?"
   * and "what's the sender's name?" questions share one round-trip.
   */
  participants: ParticipantCache;
  /**
   * Optional repo-local base path for markdown document links emitted by the
   * handler. When present, web preview resolves `docs/foo.md` inside that
   * worktree instead of the per-chat workspace root.
   */
  getDocumentBasePath?: () => Promise<string | null>;
};

export type ResultSink = (text: string) => Promise<void>;

export function createResultSink(deps: ResultSinkDeps): ResultSink {
  async function buildMetadata(trigger: Trigger | null): Promise<Record<string, unknown> | undefined> {
    const metadata: Record<string, unknown> = {};
    const documentBasePath = await deps.getDocumentBasePath?.();
    if (documentBasePath) {
      metadata.documentContext = documentContextSchema.parse({ basePath: documentBasePath });
    }

    // Default-mention the trigger sender so the server's fan-out wakes them
    // regardless of whether the handler text contains an explicit `@`. Skip
    // when the peer is `full` AND we're 1:1: the message reaches them
    // anyway, so the prefix would just be UI noise (typically a human in a
    // human↔agent direct chat). In groups we always emit the @ — it's the
    // visual cue that says "this reply is for X" and the routing guarantee
    // for any `mention_only` participant who happens to be the trigger.
    if (trigger && trigger.senderId !== deps.agent.agentId) {
      const participants = await deps.participants.get();
      if (participants.length <= 2) {
        const peer = participants.find((p) => p.agentId === trigger.senderId);
        if (!peer || peer.mode === "mention_only") {
          metadata.mentions = [trigger.senderId];
        }
      } else {
        metadata.mentions = [trigger.senderId];
      }
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  return async function forwardResult(text: string): Promise<void> {
    // Silent-turn protocol: an empty / whitespace-only output is the agent's
    // explicit signal that it has nothing new for the recipient. Skip
    // delivery and free the turn. The runtime does NOT evaluate content
    // length or "meaningfulness" — that's the agent's semantic decision.
    // The matching prompt directive lives in bootstrap.ts generateToolsDoc.
    if (text.trim().length === 0) {
      deps.clearTrigger();
      deps.log("silent turn: agent produced empty output, skipping delivery");
      return;
    }

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
