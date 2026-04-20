import { describe, expect, it } from "vitest";
import { resolveAgentState } from "../agent-state.js";

describe("resolveAgentState", () => {
  it("forces 'offline' when clientId is null, regardless of runtime state", () => {
    expect(resolveAgentState("working", null)).toBe("offline");
    expect(resolveAgentState("idle", null)).toBe("offline");
    expect(resolveAgentState("blocked", null)).toBe("offline");
    expect(resolveAgentState("error", null)).toBe("offline");
    expect(resolveAgentState(null, null)).toBe("offline");
  });

  it("passes through each known runtime state when a client is bound", () => {
    expect(resolveAgentState("idle", "c1")).toBe("idle");
    expect(resolveAgentState("working", "c1")).toBe("working");
    expect(resolveAgentState("blocked", "c1")).toBe("blocked");
    expect(resolveAgentState("error", "c1")).toBe("error");
  });

  it("falls back to 'offline' for null or unrecognized runtime states even with a client", () => {
    expect(resolveAgentState(null, "c1")).toBe("offline");
    expect(resolveAgentState("zombie", "c1")).toBe("offline");
    expect(resolveAgentState("", "c1")).toBe("offline");
  });
});
