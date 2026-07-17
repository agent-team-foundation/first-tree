import { describe, expect, it } from "vitest";
import { parseCursorModelsOutput, parseKimiConfigModels } from "../runtime/capabilities/discover-models.js";

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

describe("parseKimiConfigModels", () => {
  it("reads default_model and [models.\".\"] sections", () => {
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
});
