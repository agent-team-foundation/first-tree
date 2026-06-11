import { documentContextSchema } from "@first-tree/shared";
import type { FirstTreeHubSDK } from "../sdk.js";
import { buildMessageDocumentSnapshots, type SelfFence } from "./doc-snapshots.js";
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
 * reply kept the conversation alive forever. Final-text writes land in chat
 * history as a silent `agent-final-text` row (visible to humans, never wakes
 * another session). Under the chat-send-only contract (see the top-level
 * `first-tree` skill — its SKILL.md "Communication Principles" decision
 * table and `references/agent-communication.md`), the agent-facing model
 * treats the output stream and `chat send` as separate channels: `chat
 * send` is the reach path; this mirror is transitional system behavior,
 * never a delivery commitment. The future direction is two fully
 * decoupled channels with no mirror at all — retiring this forward (so
 * non-empty final output stops landing in chat history) is the runtime-
 * side follow-up that closes the transitional state, tracked at
 * first-tree#941.
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
   * Resolved self-fence for snapshot capture. `agentHome` is the wide
   * containment boundary for absolute paths — covers the predeclared source
   * repo, the agent's on-demand `worktrees/<task>/` checkouts, and anything
   * else the agent writes inside its home. `singleRepoLocalPath` (optional)
   * enables relative-path promotion so `docs/foo.md` and the absolute form
   * `<agentHome>/<localPath>/docs/foo.md` share one canonical key. Absent →
   * no snapshotting (legacy / test path).
   *
   * Returned via a callback (not a static field) because the agent's git-repo
   * config can refresh mid-session; the runtime exposes the latest payload via
   * its config cache.
   */
  getSelfFence?: () => Promise<SelfFence | null>;
  /**
   * Shared `workspaces/` common root (parent of every `<agentSlug>/<chatId>`).
   * Set alongside `selfSlug` to enable cross-agent doc snapshots: an absolute
   * `.md` path that realpaths into ANOTHER agent's workspace under this root
   * (same chat) is snapshotted with a global `<ownerSlug>/<chatId>/<rel>` key.
   * Absent → self-only behaviour (pre-existing).
   */
  workspacesRoot?: string;
  /** This agent's own dir name under `workspacesRoot` (excluded from cross). */
  selfSlug?: string;
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
    const selfFence = await deps.getSelfFence?.();
    if (selfFence) {
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
        // Enable cross-agent resolution only when the runtime supplied the
        // shared common root + this agent's slug; otherwise fall back to the
        // self-only path (e.g. legacy callers / tests).
        const fence =
          deps.workspacesRoot && deps.selfSlug
            ? { workspacesRoot: deps.workspacesRoot, chatId: deps.chatId, selfSlug: deps.selfSlug }
            : undefined;
        const { docs, skipped, rewrittenText, failedMentions } = await buildMessageDocumentSnapshots(
          text,
          selfFence,
          fence,
        );
        // Validate BEFORE committing the rewritten body: `rewrittenText`
        // contains explicit `[display](key)` links that only make sense paired
        // with their snapshots. If schema validation throws, the catch must
        // leave `content` as the ORIGINAL text — otherwise we'd ship explicit
        // links with no matching snapshot (dead links), breaking the
        // "rewritten ⇔ snapshotted" invariant (codex review finding).
        //
        // failedMentions enables the inert-chip UI on web: with ZERO
        // snapshots but ≥1 failure we still attach the documentContext so the
        // chat-view can render disabled chips + reason tooltips. Schema's
        // refinement rejects empty docs + empty failedMentions, so we only
        // attach when at least one is populated.
        if (docs.length > 0 || failedMentions.length > 0) {
          const payload: { kind: "snapshot"; docs: typeof docs; failedMentions?: typeof failedMentions } = {
            kind: "snapshot",
            docs,
          };
          if (failedMentions.length > 0) payload.failedMentions = failedMentions;
          metadata.documentContext = documentContextSchema.parse(payload);
        }
        content = rewrittenText;
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
    // wake-ups now require an explicit `<binName> chat send <name>`.

    return { content, metadata: Object.keys(metadata).length > 0 ? metadata : undefined };
  }

  return async function forwardResult(text: string): Promise<void> {
    // Silent-turn protocol: an empty / whitespace-only output is the agent's
    // explicit signal that it has nothing new for the recipient. Skip
    // delivery and free the turn. The runtime does NOT evaluate content
    // length or "meaningfulness" — that's the agent's semantic decision.
    // Under the chat-send-only contract the matching prompt guidance lives
    // in the `# Working in First Tree` intro block built by
    // `runtime/agent-briefing.ts` and in SKILL.md's
    // "Don't fire a courtesy chat send" section — both phrase the brake on
    // the *send* side, not the output side; this guard remains a runtime
    // safety belt for a literally-empty turn.
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
