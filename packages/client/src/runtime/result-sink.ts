import { type AttachmentRef, documentContextSchema } from "@first-tree/shared";
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
 * another session). Under the chat-send-only contract (see the generated
 * briefing's `## Communication` decision guide), the agent-facing model
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
   * Resolve the organization id the doc captures upload under. Uploads are
   * org-scoped (`POST /orgs/:orgId/attachments`); the chat lives in exactly one
   * org, so the sink resolves it from the chat (cached). Returning `null` (org
   * unresolvable) disables doc capture for the turn — the message still goes
   * out, mentions just stay plain text. Returned via a callback so the lookup
   * (and its cache) lives with the runtime, not the sink.
   */
  getOrgId?: () => Promise<string | null>;
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
    // Doc capture needs both the resolvable self-fence AND an org to upload the
    // bytes under. With either missing we skip capture entirely — the message
    // still goes out, doc mentions just stay plain text.
    const orgId = selfFence ? await deps.getOrgId?.() : null;
    if (selfFence && orgId) {
      // Capture referenced docs as generic attachment refs: upload the bytes to
      // the org blob store, store an `AttachmentRef` in `metadata.attachments[]`,
      // and rewrite each resolved mention into `[display](attachment:<id>)`.
      // Web fetches the bytes on demand from `GET /attachments/:id`. Bytes never
      // travel in the message (cloud-friendly; the server can't read the agent's
      // disk). See proposal §5.
      try {
        // Enable cross-agent resolution only when the runtime supplied the
        // shared common root + this agent's slug; otherwise fall back to the
        // self-only path (e.g. legacy callers / tests).
        const fence =
          deps.workspacesRoot && deps.selfSlug
            ? { workspacesRoot: deps.workspacesRoot, chatId: deps.chatId, selfSlug: deps.selfSlug }
            : undefined;
        const { refs, skipped, rewrittenText, failedMentions } = await buildMessageDocumentSnapshots(
          text,
          selfFence,
          { uploader: deps.sdk, orgId },
          fence,
        );
        // The rewritten body's `attachment:<id>` links only make sense paired
        // with their refs. `buildMessageDocumentSnapshots` only rewrites spans
        // whose upload succeeded, so `rewrittenText` and `refs` are always
        // consistent here.
        if (refs.length > 0) {
          const attachments: AttachmentRef[] = refs;
          metadata.attachments = attachments;
        }
        // failedMentions enables the inert-chip UI on web: attach the
        // documentContext snapshot roster only when ≥1 failure is present (the
        // schema rejects an empty roster).
        if (failedMentions.length > 0) {
          metadata.documentContext = documentContextSchema.parse({ kind: "snapshot", failedMentions });
        }
        content = rewrittenText;
        if (skipped > 0) {
          deps.log(`doc capture: skipped ${skipped} unresolvable / failed link(s)`);
        }
      } catch (err) {
        // Capture failure must never block message delivery — log and attach no
        // attachment metadata so the message still goes out (verbatim).
        deps.log(`doc capture: build failed, no attachments attached: ${(err as Error).message}`);
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
