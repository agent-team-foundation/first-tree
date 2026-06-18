import { AGENT_FINAL_TEXT_METADATA_KEY } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { selectVisibleMessages } from "../agent-final-text-filter.js";

const FINAL = { [AGENT_FINAL_TEXT_METADATA_KEY]: true };
const mk = (id: string, metadata: Record<string, unknown> = {}) => ({ id, metadata });

/**
 * `selectVisibleMessages` is the single visible-message set the chat timeline
 * and its read-state projections (pill / high-water / divider / scroll anchor)
 * share. These cases pin the two failure modes raised in review: a hidden
 * newest row driving an un-clearable pill, and a saved anchor pointing at a
 * hidden row.
 */
describe("selectVisibleMessages", () => {
  it("returns the same array (identity) when the hide toggle is off", () => {
    const msgs = [mk("a"), mk("b", FINAL), mk("c")];
    expect(selectVisibleMessages(msgs, false)).toBe(msgs);
  });

  it("drops final-text rows when hiding — including the NEWEST row (no phantom pill)", () => {
    const msgs = [mk("a"), mk("b"), mk("final-newest", FINAL)];
    const visible = selectVisibleMessages(msgs, true);
    expect(visible.map((m) => m.id)).toEqual(["a", "b"]);
    // The hidden newest row is absent, so pill/high-water computed over this
    // set cannot count a row with no DOM node.
    expect(visible.some((m) => m.id === "final-newest")).toBe(false);
  });

  it("a saved scroll anchor pointing at a hidden row does not resolve in the visible set", () => {
    const msgs = [mk("a"), mk("hidden-anchor", FINAL), mk("c")];
    const visible = selectVisibleMessages(msgs, true);
    // bottomVisibleResolution does findIndex(...) === -1 → graceful fallback.
    expect(visible.findIndex((m) => m.id === "hidden-anchor")).toBe(-1);
  });

  it("keeps human / normal-agent rows untouched when hiding", () => {
    const msgs = [mk("human", { mentions: ["x"] }), mk("agent-send")];
    expect(selectVisibleMessages(msgs, true).map((m) => m.id)).toEqual(["human", "agent-send"]);
  });
});
