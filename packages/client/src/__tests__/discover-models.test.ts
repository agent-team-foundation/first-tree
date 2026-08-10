import { describe, expect, it } from "vitest";
import {
  discoverProviderModels,
  parseCursorModelsOutput,
  parseKimiConfigModels,
  resolveKimiConfigPath,
} from "../providers/discover-models.js";

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

describe("discoverProviderModels — grok", () => {
  const modelStateMeta = {
    defaultAuthMethodId: "cached_token",
    agentVersion: "0.2.117",
    modelState: {
      currentModelId: "grok-4",
      availableModels: [
        { modelId: "grok-4", name: "Grok 4", description: "" },
        { modelId: "grok-3-mini", name: "Grok 3 Mini", description: "" },
      ],
    },
  };

  const resolvedOk = { ok: true as const, binary: "/fake/bin/grok", version: "0.2.117" };

  it("returns the provider-cli catalog parsed from the initialize _meta.modelState", async () => {
    const catalog = await discoverProviderModels("grok", {
      now: () => new Date("2026-07-31T00:00:00Z"),
      resolveGrokBinary: () => resolvedOk,
      fetchGrokModelMeta: async () => ({ ok: true as const, meta: modelStateMeta }),
    });
    expect(catalog).toEqual({
      provider: "grok",
      models: [
        { id: "grok-4", label: "Grok 4", isDefault: true, hint: "default" },
        { id: "grok-3-mini", label: "Grok 3 Mini" },
      ],
      defaultModelId: "grok-4",
      fetchedAt: "2026-07-31T00:00:00.000Z",
      source: "provider-cli",
      error: null,
    });
  });

  it("degrades to unavailable when the binary is missing", async () => {
    const catalog = await discoverProviderModels("grok", {
      resolveGrokBinary: () => ({ ok: false as const, error: "grok binary not found on this host", transient: false }),
    });
    expect(catalog.source).toBe("unavailable");
    expect(catalog.models).toEqual([]);
    expect(catalog.error).toContain("not found");
  });

  it("degrades to unavailable when the launch-verified version gate rejects the binary", async () => {
    let spawned = false;
    const catalog = await discoverProviderModels("grok", {
      resolveGrokBinary: () => ({
        ok: false as const,
        error: "resolved grok failed validation: grok 0.1.0 is outside the supported range >=0.2.117 <0.3.0",
        transient: false,
      }),
      fetchGrokModelMeta: async () => {
        spawned = true;
        return { ok: true as const, meta: modelStateMeta };
      },
    });
    expect(catalog.source).toBe("unavailable");
    expect(catalog.error).toContain("supported range");
    // The gated binary must never be spawned for discovery.
    expect(spawned).toBe(false);
  });

  it("degrades to unavailable when the initialize handshake fails", async () => {
    const catalog = await discoverProviderModels("grok", {
      resolveGrokBinary: () => resolvedOk,
      fetchGrokModelMeta: async () => ({ ok: false as const, error: "grok ACP model discovery timed out" }),
    });
    expect(catalog.source).toBe("unavailable");
    expect(catalog.error).toContain("timed out");
  });

  it("degrades to unavailable when the response carries no model state", async () => {
    const catalog = await discoverProviderModels("grok", {
      resolveGrokBinary: () => resolvedOk,
      fetchGrokModelMeta: async () => ({ ok: true as const, meta: null }),
    });
    expect(catalog.source).toBe("unavailable");
    expect(catalog.error).toContain("no model state");
  });
});
