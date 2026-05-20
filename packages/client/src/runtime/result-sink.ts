import { documentContextSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FirstTreeHubSDK } from "../sdk.js";
import { buildMessageDocumentSnapshots } from "./doc-snapshots.js";
import type { AgentIdentity } from "./handler.js";

/**
 * Forward-to-chat sink — the single place that owns "handler produced a final
 * text, now turn it into a wire message". Lives in the runtime layer so every
 * handler (Claude Code today, Gemini / Cursor / custom tomorrow) reuses the
 * same enrichment:
 *
 * - `inReplyTo` is pulled from the current trigger (the message that kicked
 *   off this turn), so peers that threaded via reply routing see the answer
 *   in their waiting chat — see proposals/hub-agent-messaging-reply-and-mentions §3.4.
 * - `metadata.documentContext` is populated (when the handler has a
 *   document base path) so the web markdown preview can resolve repo-local
 *   doc links — see PR #356.
 *
 * The sink deliberately does NOT auto-mention the trigger sender. v1
 * (`proposals/hub-chat-message-v1-design §四 改造 4`) removed that branch
 * because it was the structural fuel for agent ↔ agent echo loops: a final
 * text always woke the trigger sender, so a courteous "thanks / got it"
 * reply kept the conversation alive forever. Final text now reaches the
 * chat for **human observers** only; to make another agent take action,
 * the agent must explicitly call `first-tree-hub chat send <name>` (see
 * the "Communication Rules" section in `tools.md`).
 *
 * Content-level `@<name>` resolution (extracting tokens and cross-validating
 * against the participant list) is the server's job — see
 * `services/message.ts sendMessage`.
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
   * Optional repo-local base path for markdown document links emitted by the
   * handler. When present, web preview resolves `docs/foo.md` inside that
   * worktree instead of the per-chat workspace root.
   */
  getDocumentBasePath?: () => Promise<string | null>;
};

export type ResultSink = (text: string) => Promise<void>;

export function createResultSink(deps: ResultSinkDeps): ResultSink {
  // Build the outbound payload: the (possibly rewritten) content + metadata.
  // The content may differ from `text` when a referenced doc was written as an
  // absolute-in-root path: `buildMessageDocumentSnapshots` rewrites that span
  // to the canonical workspace-relative path so web's unchanged re-scan can
  // match the snapshot. Relative mentions are returned verbatim.
  async function prepareOutbound(text: string): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const metadata: Record<string, unknown> = {};
    let content = text;
    const documentBasePath = await deps.getDocumentBasePath?.();
    if (documentBasePath) {
      // Embed the inline-snapshot variant only. This is the cloud-friendly
      // form: web gets the bytes straight from the message, no second server
      // round-trip and no dependency on the server having access to the
      // agent's local workspace filesystem (see proposal §核心设计).
      //
      // We deliberately do NOT fall back to the legacy `kind:"path"` variant.
      // It carries the agent host's local absolute workspace path into
      // immutable chat history (a cloud-topology leak), and is dead in the
      // cloud anyway since the server can't read the agent's disk. Any real,
      // referenced `.md` is already captured as a snapshot above; a message
      // with no resolvable doc simply carries no documentContext. (Historical
      // messages may still hold `kind:"path"`; the web reader keeps handling
      // them for back-compat — this only stops emitting new ones.)
      try {
        const { docs, skipped, rewrittenText } = await buildMessageDocumentSnapshots(text, documentBasePath);
        content = rewrittenText;
        if (docs.length > 0) {
          metadata.documentContext = documentContextSchema.parse({ kind: "snapshot", docs });
        }
        if (skipped > 0) {
          deps.log(`doc snapshot: skipped ${skipped} unresolvable link(s)`);
        }
      } catch (err) {
        // Snapshot build failure must never block message delivery — log and
        // attach no documentContext so the message still goes out (verbatim).
        deps.log(`doc snapshot: build failed, no documentContext attached: ${(err as Error).message}`);
      }
    }

    // v1 §四 改造 4: the trigger-sender mention auto-injection that used to
    // live here was deleted to break the agent ↔ agent echo loop. Final
    // text reaches the chat for human observers only; agent-to-agent
    // wake-ups now require an explicit `first-tree-hub chat send <name>`.

    return { content, metadata: Object.keys(metadata).length > 0 ? metadata : undefined };
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

    const { content, metadata } = await prepareOutbound(text);

    await deps.sdk.sendMessage(deps.chatId, {
      format: "text",
      content,
      source: "api",
      // `purpose: "agent-final-text"` tells the server to skip the
      // group-chat `@mention required` guard and force every fan-out row
      // to `notify=false`. final text lands in chat history so human
      // observers see what the agent did, but it never wakes another
      // session — see v1 §四 改造 4 (b) bypass channel.
      purpose: "agent-final-text",
      ...(trigger ? { inReplyTo: trigger.messageId } : {}),
      ...(metadata ? { metadata } : {}),
    });
  };
}
