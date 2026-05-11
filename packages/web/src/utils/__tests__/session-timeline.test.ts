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

  it("dedupes tool_call events by toolUseId — keeps the highest-seq emit", () => {
    // Client emits a `pending` row when tool_use starts, then a final ok/error
    // row when the tool_result arrives — both share a toolUseId. The active
    // turn should only render the later row.
    const events: SessionEventRow[] = [
      ev(1, "tool_call", { payload: { toolUseId: "tu-1", name: "Bash", args: {}, status: "pending" } }),
      ev(2, "tool_call", {
        payload: {
          toolUseId: "tu-1",
          name: "Bash",
          args: {},
          status: "ok",
          durationMs: 120,
          resultPreview: "hello",
        },
      }),
    ];
    const out = filterEventsForTimeline(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.seq).toBe(2);
  });

  it("dedupes across multiple concurrent tool calls (seq pending ≠ seq final)", () => {
    // Real-world shape: two tool_use blocks in the same assistant message
    // emit two pending rows back-to-back, followed by two final rows.
    const events: SessionEventRow[] = [
      ev(10, "tool_call", { payload: { toolUseId: "a1", name: "Bash", args: {}, status: "pending" } }),
      ev(11, "tool_call", { payload: { toolUseId: "a2", name: "Read", args: {}, status: "pending" } }),
      ev(12, "tool_call", { payload: { toolUseId: "a1", name: "Bash", args: {}, status: "ok" } }),
      ev(13, "tool_call", { payload: { toolUseId: "a2", name: "Read", args: {}, status: "ok" } }),
    ];
    const out = filterEventsForTimeline(events);
    expect(out.map((e) => e.seq)).toEqual([12, 13]);
  });

  it("keeps a standalone pending tool_call (no final yet — tool still executing)", () => {
    // During the live window between tool_use and tool_result, only the
    // pending row exists; the UI must render it so the user sees "using
    // Bash…" pulse.
    const events: SessionEventRow[] = [
      ev(5, "tool_call", { payload: { toolUseId: "tu-live", name: "Bash", args: {}, status: "pending" } }),
    ];
    const out = filterEventsForTimeline(events);
    expect(out).toEqual(events);
  });
});
