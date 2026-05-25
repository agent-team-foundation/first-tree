import type { SessionEventRow } from "../api/sessions.js";

/**
 * Filter a session-event stream down to the rows the chat timeline should
 * render. Input order is irrelevant — the function looks at seq numbers and
 * the downstream renderer sorts by timestamp anyway.
 *
 * Rules (per the "only show result after turn ends" UX):
 *   - Completed turns collapse to their forwarded result message — so any
 *     transient event (assistant_text / thinking / tool_call) older than the
 *     most recent `turn_end` marker is dropped.
 *   - `turn_end` markers are themselves never rendered (they're boundaries).
 *   - `error` events stay visible across turns so failures are not hidden.
 *   - Events on the currently-active turn (seq > lastTurnEndSeq) are kept as
 *     compact in-progress indicators.
 *   - A single tool call produces two `tool_call` rows (pending on start,
 *     final ok/error on finish). Dedupe by toolUseId — keep the highest-seq
 *     emit so the final status supersedes the earlier pending.
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

  const turnFiltered = events.filter((e) => {
    if (e.kind === "turn_end") return false;
    if (e.kind === "context_tree_usage") return false;
    if (e.kind === "error") return true;
    return e.seq > lastTurnEndSeq;
  });

  // Build toolUseId → highest-seq map, then drop earlier pending rows.
  const latestByToolUseId = new Map<string, number>();
  for (const e of turnFiltered) {
    if (e.kind !== "tool_call") continue;
    const id = toolUseId(e.payload);
    if (!id) continue;
    const prev = latestByToolUseId.get(id) ?? -1;
    if (e.seq > prev) latestByToolUseId.set(id, e.seq);
  }

  return turnFiltered.filter((e) => {
    if (e.kind !== "tool_call") return true;
    const id = toolUseId(e.payload);
    if (!id) return true;
    return latestByToolUseId.get(id) === e.seq;
  });
}

function toolUseId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const id = (payload as { toolUseId?: unknown }).toolUseId;
  return typeof id === "string" ? id : undefined;
}
