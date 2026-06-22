import type { FirstTreeHubSDK } from "../sdk.js";
import type { SelfFence } from "./doc-snapshots.js";
import type { AgentIdentity } from "./handler.js";

/**
 * Turn-completion sink the runtime calls when a handler finishes a turn.
 *
 * **The final-text mirror is RETIRED** (yuezengwu 2026-06-22 decision; closes
 * first-tree#941). Historically this sink turned a handler's non-empty final
 * text into a silent `agent-final-text` chat row for human observers. That
 * mirror is gone: an agent's final text is its output / reasoning stream, NOT a
 * chat message, so it is no longer delivered to chat at all. Reaching a teammate
 * is always an explicit `chat send` (agent or human) or `chat ask` (a human
 * decision); there is no implicit final-text delivery to fall back on.
 *
 * The sink is kept as the single hook every handler (Claude Code today,
 * Gemini / Cursor / custom tomorrow) calls at turn end; it now only clears the
 * turn trigger and never writes to chat. The enrichment deps in
 * `ResultSinkDeps` (sdk / self-fence / org / doc-snapshot inputs) are inert
 * now — they are retained to keep the wiring stable and are cleaned up
 * together with the turn-trigger machinery in a follow-up.
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
  return async function forwardResult(text: string): Promise<void> {
    // The final-text mirror is retired: an agent's final output is NOT delivered
    // to chat. We still clear the turn trigger so a concurrently-arriving
    // inject() can set a fresh one, then return without writing anything.
    deps.clearTrigger();
    deps.log(
      text.trim().length === 0
        ? "silent turn: agent produced empty output"
        : "final text not forwarded — agent-final-text delivery is retired",
    );
  };
}
