import { describe, expect, it } from "vitest";
import { CODEX_EFFORT_OPTIONS } from "../reasoning-effort-section.js";

describe("Codex reasoning effort options", () => {
  it("orders the provider-native levels through max and ultra", () => {
    expect(CODEX_EFFORT_OPTIONS.map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("marks max and ultra as model-dependent", () => {
    expect(CODEX_EFFORT_OPTIONS.filter((option) => ["max", "ultra"].includes(option.value))).toEqual([
      { value: "max", label: "max", hint: "model-dependent" },
      { value: "ultra", label: "ultra", hint: "deepest; model-dependent" },
    ]);
  });
});
