import { describe, expect, it } from "vitest";
import { CODEX_MODEL_IDS, CODEX_MODEL_OPTIONS } from "../model-section.js";

describe("Codex model options", () => {
  it("exposes every enum-style model id exactly once", () => {
    expect(CODEX_MODEL_OPTIONS.map((option) => option.value)).toEqual(Object.values(CODEX_MODEL_IDS));
  });

  it("includes only the concrete GPT-5.6 Codex models", () => {
    expect(Object.values(CODEX_MODEL_IDS).filter((model) => model.startsWith("gpt-5.6"))).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });
});
