import type { SessionEventRow } from "../api/sessions.js";

/**
 * Filter a chronologically-sorted session-event stream down to the rows the
 * chat timeline should render.
 *
 * Rules (per the "only show result after turn ends" UX):
 *   - Completed turns collapse to their forwarded result message — so any
 *     transient event (assistant_text / thinking / tool_call) older than the
 *     most recent `turn_end` marker is dropped.
 *   - `turn_end` markers are themselves never rendered (they're boundaries).
 *   - `error` events stay visible across turns so failures are not hidden.
 *   - Events on the currently-active turn (seq > lastTurnEndSeq) are kept as
 *     compact in-progress indicators.
 *
 * This function is pure: same input events → same output. It's extracted from
 * the chat-view useMemo so the turn-grouping contract has direct unit-test
 * coverage without mounting the React tree.
 */
export function filterEventsForTimeline(events: SessionEventRow[]): SessionEventRow[] {
  let lastTurnEndSeq = -1;
  for (const e of events) {
    if (e.kind === "turn_end" && e.seq > lastTurnEndSeq) lastTurnEndSeq = e.seq;
  }

  return events.filter((e) => {
    if (e.kind === "turn_end") return false;
    if (e.kind === "error") return true;
    return e.seq > lastTurnEndSeq;
  });
}
