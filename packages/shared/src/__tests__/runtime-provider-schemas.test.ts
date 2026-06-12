import { describe, expect, it } from "vitest";
import {
  CAPABILITY_STATES,
  capabilityEntrySchema,
  clientCapabilitiesSchema,
  DEFAULT_RUNTIME_PROVIDER,
  RUNTIME_PROVIDERS,
  runtimeProviderSchema,
  updateClientCapabilitiesSchema,
} from "../index.js";

/**
 * Lock the public surface of the two new schemas added in 0026:
 *   - `runtimeProviderSchema` is the discriminator everything else keys off
 *     (agent rows, payload kind, capability map). A typo in the enum here
 *     would let invalid runtime ids drift into the DB.
 *   - `capabilityEntrySchema` and `clientCapabilitiesSchema` define the
 *     wire format of the `PATCH /clients/:id/capabilities` upload — pinned
 *     here so a server change can't silently relax validation.
 */
describe("runtimeProviderSchema", () => {
  it("accepts all three built-in providers", () => {
    expect(runtimeProviderSchema.parse("claude-code")).toBe("claude-code");
    expect(runtimeProviderSchema.parse("claude-code-tui")).toBe("claude-code-tui");
    expect(runtimeProviderSchema.parse("codex")).toBe("codex");
  });

  it("rejects unknown providers", () => {
    expect(() => runtimeProviderSchema.parse("gemini")).toThrow();
    expect(() => runtimeProviderSchema.parse("")).toThrow();
  });

  it("RUNTIME_PROVIDERS constants match the schema", () => {
    expect(runtimeProviderSchema.parse(RUNTIME_PROVIDERS.CLAUDE_CODE)).toBe("claude-code");
    expect(runtimeProviderSchema.parse(RUNTIME_PROVIDERS.CLAUDE_CODE_TUI)).toBe("claude-code-tui");
    expect(runtimeProviderSchema.parse(RUNTIME_PROVIDERS.CODEX)).toBe("codex");
  });

  it("DEFAULT_RUNTIME_PROVIDER is claude-code (existing rows pre-0026 have no kind)", () => {
    expect(DEFAULT_RUNTIME_PROVIDER).toBe("claude-code");
  });
});

describe("capabilityEntrySchema", () => {
  it("CAPABILITY_STATES enumerates the four documented states", () => {
    expect(Object.values(CAPABILITY_STATES).sort()).toEqual(["error", "missing", "ok", "unauthenticated"].sort());
  });

  it("accepts a fully-formed `ok` entry", () => {
    const parsed = capabilityEntrySchema.parse({
      state: "ok",
      available: true,
      authenticated: true,
      sdkVersion: "0.2.84",
      authMethod: "oauth",
      runtimeSource: "path",
      runtimePath: "/usr/local/bin/codex",
      detectedAt: new Date().toISOString(),
    });
    expect(parsed.state).toBe("ok");
    expect(parsed.sdkVersion).toBe("0.2.84");
    expect(parsed.runtimeSource).toBe("path");
    expect(parsed.runtimePath).toBe("/usr/local/bin/codex");
  });

  it("accepts `missing` with null sdkVersion + auth_method=none", () => {
    const parsed = capabilityEntrySchema.parse({
      state: "missing",
      available: false,
      authenticated: false,
      sdkVersion: null,
      authMethod: "none",
      detectedAt: new Date().toISOString(),
    });
    expect(parsed.state).toBe("missing");
    expect(parsed.sdkVersion).toBeNull();
  });

  it("rejects an invalid state value", () => {
    expect(() =>
      capabilityEntrySchema.parse({
        state: "pending",
        available: true,
        authenticated: false,
        authMethod: "none",
        detectedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it("rejects an invalid authMethod value", () => {
    expect(() =>
      capabilityEntrySchema.parse({
        state: "ok",
        available: true,
        authenticated: true,
        authMethod: "magic-link", // <- not in the enum
        detectedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
});

describe("clientCapabilitiesSchema + updateClientCapabilitiesSchema", () => {
  it("accepts a record keyed by arbitrary provider strings (forwards-compat)", () => {
    // Schema-level: the record key is `z.string()` so future providers don't
    // require a server schema bump; the *server* layer separately constrains
    // capability lookups to known RuntimeProvider keys.
    const parsed = clientCapabilitiesSchema.parse({
      "claude-code": {
        state: "ok",
        available: true,
        authenticated: true,
        sdkVersion: "0.2.84",
        authMethod: "oauth",
        detectedAt: new Date().toISOString(),
      },
      "future-provider": {
        state: "missing",
        available: false,
        authenticated: false,
        sdkVersion: null,
        authMethod: "none",
        detectedAt: new Date().toISOString(),
      },
    });
    expect(Object.keys(parsed)).toContain("future-provider");
  });

  it("updateClientCapabilitiesSchema requires top-level `capabilities` field", () => {
    expect(() => updateClientCapabilitiesSchema.parse({})).toThrow();
    expect(() => updateClientCapabilitiesSchema.parse({ capabilities: {} })).not.toThrow();
  });

  it("rejects malformed entries inside the capabilities map", () => {
    expect(() =>
      updateClientCapabilitiesSchema.parse({
        capabilities: {
          "claude-code": { state: "broken" }, // <- missing required fields, invalid state
        },
      }),
    ).toThrow();
  });
});
