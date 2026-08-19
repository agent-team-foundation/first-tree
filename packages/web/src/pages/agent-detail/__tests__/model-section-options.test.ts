import { describe, expect, it } from "vitest";
import {
  AMP_MODE_OPTIONS,
  CODEX_MODEL_IDS,
  CODEX_MODEL_OPTIONS,
  MODEL_HELP_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
} from "../model-section.js";

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

describe("Amp mode options", () => {
  it("exposes Amp CLI/SDK capability presets, not model ids", () => {
    expect(AMP_MODE_OPTIONS.map((option) => option.value)).toEqual(["low", "medium", "high", "ultra"]);
  });
});

describe("DeepSeek model options", () => {
  it("uses free-form model entry with deepseek-v4-flash default guidance", () => {
    expect(MODEL_OPTIONS_BY_PROVIDER["deepseek-harness"]).toEqual([]);
    expect(MODEL_HELP_BY_PROVIDER["deepseek-harness"]).toContain("deepseek-v4-flash");
    expect(MODEL_HELP_BY_PROVIDER["deepseek-harness"]).toContain("exact DeepSeek model id");
  });
});
