import { describe, expect, it } from "vitest";
import { CODEX_MODEL_IDS, CODEX_MODEL_OPTIONS } from "../model-section.js";

describe("Codex model options", () => {
  it("exposes every enum-style model id exactly once", () => {
    expect(CODEX_MODEL_OPTIONS.map((option) => option.value)).toEqual(Object.values(CODEX_MODEL_IDS));
  });

  it("includes the complete GPT-5.6 model family", () => {
    expect(CODEX_MODEL_IDS).toMatchObject({
      GPT_5_6: "gpt-5.6",
      GPT_5_6_SOL: "gpt-5.6-sol",
      GPT_5_6_TERRA: "gpt-5.6-terra",
      GPT_5_6_LUNA: "gpt-5.6-luna",
    });
  });
});
