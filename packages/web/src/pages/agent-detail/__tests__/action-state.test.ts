import { describe, expect, it } from "vitest";
import { isBindableClient } from "../action-state.js";

describe("agent detail action state", () => {
  it("uses the same connected-client rule for bindability and row state", () => {
    expect(isBindableClient({ status: "connected" })).toBe(true);
    expect(isBindableClient({ status: "disconnected" })).toBe(false);
    expect(isBindableClient({ status: "retired" })).toBe(false);
  });
});
