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
 * The sink remains the single hook every built-in handler calls at turn end; it
 * only clears the turn trigger and never writes to chat. Replacing this hook
 * with a dedicated turn-end API (and retiring `currentTrigger` with it) is a
 * follow-up — not this cleanup.
 */

export type Trigger = { messageId: string; senderId: string };

export type ResultSinkDeps = {
  /** Called by the sink to clear the trigger before returning, so a
   *  concurrently-arriving inject() can set a fresh trigger without this
   *  reply consuming it. */
  clearTrigger: () => void;
  log: (msg: string) => void;
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
