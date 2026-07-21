import { describe, expect, it } from "vitest";
import { anchorKey, isJumpable } from "../use-mounted-anchors.js";

// `useMountedAnchors` itself is a DOM/MutationObserver hook (not exercisable in
// the node vitest env), but the gate every jump affordance keys off is the pure
// `isJumpable` — that's what these cover, so the "clickable iff mounted anchor"
// contract can't silently regress to a no-op.

describe("anchorKey", () => {
  it("joins main and agentId with a colon", () => {
    expect(anchorKey("working", "a1")).toBe("working:a1");
    expect(anchorKey("failed", "a3")).toBe("failed:a3");
    expect(anchorKey("reason", "a4")).toBe("reason:a4");
  });
});

describe("isJumpable — jump affordance gates on a mounted anchor", () => {
  const mounted = new Set([
    anchorKey("working", "atlas"),
    anchorKey("failed", "cypher"),
    anchorKey("reason", "beacon"),
  ]);

  it("true when this agent's anchor for that status is mounted", () => {
    expect(isJumpable(mounted, "working", "atlas")).toBe(true);
    expect(isJumpable(mounted, "failed", "cypher")).toBe(true);
    expect(isJumpable(mounted, "reason", "beacon")).toBe(true);
  });

  it("false when the anchor isn't mounted — so nothing becomes a clickable no-op", () => {
    expect(isJumpable(mounted, "working", "cypher")).toBe(false); // right agent, wrong status
    expect(isJumpable(mounted, "failed", "atlas")).toBe(false); // wrong status for this agent
    expect(isJumpable(mounted, "working", "delta")).toBe(false); // not loaded
    expect(isJumpable(new Set(), "working", "atlas")).toBe(false); // nothing mounted yet
  });
});
