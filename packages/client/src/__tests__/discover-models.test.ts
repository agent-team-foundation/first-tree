import { describe, expect, it } from "vitest";
import {
  parseCursorModelsOutput,
  parseKimiConfigModels,
  resolveKimiConfigPath,
} from "../runtime/capabilities/discover-models.js";

describe("parseCursorModelsOutput", () => {
  it("parses id/label rows and marks the default", () => {
    const parsed = parseCursorModelsOutput(`Available models

auto - Auto (default)
gpt-5.2 - GPT-5.2
composer-2.5 - Composer 2.5
`);
    expect(parsed.defaultModelId).toBe("auto");
    expect(parsed.models).toEqual([
      { id: "auto", label: "Auto", isDefault: true, hint: "default" },
      { id: "gpt-5.2", label: "GPT-5.2" },
      { id: "composer-2.5", label: "Composer 2.5" },
    ]);
  });
});

describe("resolveKimiConfigPath", () => {
  it("defaults to ~/.kimi-code/config.toml", () => {
    expect(resolveKimiConfigPath({}, "/home/user")).toBe("/home/user/.kimi-code/config.toml");
  });

  it("honors KIMI_CODE_HOME relocation", () => {
    expect(resolveKimiConfigPath({ KIMI_CODE_HOME: "/opt/kimi" }, "/home/user")).toBe("/opt/kimi/config.toml");
  });

  it("trims KIMI_CODE_HOME and ignores empty", () => {
    expect(resolveKimiConfigPath({ KIMI_CODE_HOME: "  /custom/kimi  " }, "/home/user")).toBe(
      "/custom/kimi/config.toml",
    );
    expect(resolveKimiConfigPath({ KIMI_CODE_HOME: "   " }, "/home/user")).toBe("/home/user/.kimi-code/config.toml");
  });
});

describe("parseKimiConfigModels", () => {
  it('reads default_model and quoted [models."."] sections', () => {
    const parsed = parseKimiConfigModels(`
default_model = "kimi-code/k3"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
display_name = "K2.7 Coding"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
display_name = "K3"
`);
    expect(parsed.defaultModelId).toBe("kimi-code/k3");
    expect(parsed.models).toEqual([
      { id: "kimi-code/kimi-for-coding", label: "K2.7 Coding" },
      { id: "kimi-code/k3", label: "K3", isDefault: true, hint: "default" },
    ]);
  });

  it("accepts bare model aliases and marks default_model", () => {
    const parsed = parseKimiConfigModels(`
default_model = "gemini-3-pro-preview"

[models.gemini-3-pro-preview]
provider = "openai"
model = "gemini-3-pro-preview"
display_name = "Gemini 3 Pro"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
display_name = "K3"
`);
    expect(parsed.defaultModelId).toBe("gemini-3-pro-preview");
    expect(parsed.models).toEqual(
      expect.arrayContaining([
        { id: "gemini-3-pro-preview", label: "Gemini 3 Pro", isDefault: true, hint: "default" },
        { id: "kimi-code/k3", label: "K3" },
      ]),
    );
    expect(parsed.models).toHaveLength(2);
  });
});
