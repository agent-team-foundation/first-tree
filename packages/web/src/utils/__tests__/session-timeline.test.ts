import { describe, expect, it } from "vitest";
import type { SessionEventRow } from "../../api/sessions.js";
import { filterEventsForTimeline } from "../session-timeline.js";

/** Factory — keeps the fixtures short and focused on what each case actually asserts. */
function ev(seq: number, kind: SessionEventRow["kind"], overrides: Partial<SessionEventRow> = {}): SessionEventRow {
  return {
    id: `id-${seq}`,
    agentId: "agent-1",
    chatId: "chat-1",
    seq,
    kind,
    payload: overrides.payload ?? {},
    createdAt: overrides.createdAt ?? new Date(2026, 0, 1, 0, 0, seq).toISOString(),
  };
}

describe("filterEventsForTimeline", () => {
  it("returns all in-progress events when no turn has ended yet", () => {
    const events = [ev(1, "thinking"), ev(2, "tool_call"), ev(3, "assistant_text")];
    const out = filterEventsForTimeline(events);
    expect(out.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("never renders the turn_end marker itself", () => {
    const events = [ev(1, "thinking"), ev(2, "turn_end")];
    const out = filterEventsForTimeline(events);
    expect(out.every((e) => e.kind !== "turn_end")).toBe(true);
  });

  it("hides transient events belonging to a completed turn", () => {
    // Turn 1: thinking + tool_call + assistant_text + turn_end
    // After turn_end, those rows collapse — only the result chat message
    // (which lives in the messages stream, not events) remains.
    const events = [ev(1, "thinking"), ev(2, "tool_call"), ev(3, "assistant_text"), ev(4, "turn_end")];
    expect(filterEventsForTimeline(events)).toEqual([]);
  });

  it("keeps transient events on the CURRENTLY-ACTIVE turn while hiding earlier finished turns", () => {
    const events = [
      // Finished turn 1
      ev(1, "thinking"),
      ev(2, "tool_call"),
      ev(3, "turn_end"),
      // Active turn 2 (no turn_end yet)
      ev(4, "thinking"),
      ev(5, "assistant_text"),
      ev(6, "tool_call"),
    ];
    const out = filterEventsForTimeline(events);
    expect(out.map((e) => e.seq)).toEqual([4, 5, 6]);
  });

  it("keeps errors visible across turns (they must never be hidden)", () => {
    const events = [
      ev(1, "error", { payload: { source: "sdk", message: "boom" } }),
      ev(2, "tool_call"),
      ev(3, "turn_end"),
      // Error from a COMPLETED turn — still visible.
      // No events for the active turn.
    ];
    const out = filterEventsForTimeline(events);
    expect(out.map((e) => ({ seq: e.seq, kind: e.kind }))).toEqual([{ seq: 1, kind: "error" }]);
  });

  it("handles multiple completed turns — only the latest turn_end matters", () => {
    const events = [
      // Turn 1
      ev(1, "tool_call"),
      ev(2, "turn_end"),
      // Turn 2
      ev(3, "assistant_text"),
      ev(4, "turn_end"),
      // Active turn 3
      ev(5, "thinking"),
      ev(6, "tool_call"),
    ];
    const out = filterEventsForTimeline(events);
    expect(out.map((e) => e.seq)).toEqual([5, 6]);
  });

  it("is idempotent: filtering twice yields the same result", () => {
    const events = [ev(1, "thinking"), ev(2, "tool_call"), ev(3, "turn_end"), ev(4, "assistant_text")];
    const once = filterEventsForTimeline(events);
    const twice = filterEventsForTimeline(once);
    expect(twice).toEqual(once);
  });

  it("returns an empty array for empty input", () => {
    expect(filterEventsForTimeline([])).toEqual([]);
  });
});
