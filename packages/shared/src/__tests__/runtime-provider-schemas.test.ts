import { describe, expect, it } from "vitest";
import {
  CAPABILITY_STATES,
  capabilityEntrySchema,
  clientCapabilitiesSchema,
  DEFAULT_RUNTIME_PROVIDER,
  isRuntimeProviderEnabled,
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
  it("accepts all built-in providers", () => {
    expect(runtimeProviderSchema.parse("claude-code")).toBe("claude-code");
    expect(runtimeProviderSchema.parse("claude-code-tui")).toBe("claude-code-tui");
    expect(runtimeProviderSchema.parse("codex")).toBe("codex");
    expect(runtimeProviderSchema.parse("cursor")).toBe("cursor");
    expect(runtimeProviderSchema.parse("kimi-code")).toBe("kimi-code");
  });

  it("rejects unknown providers", () => {
    expect(() => runtimeProviderSchema.parse("gemini")).toThrow();
    expect(() => runtimeProviderSchema.parse("")).toThrow();
  });

  it("RUNTIME_PROVIDERS constants match the schema", () => {
    expect(runtimeProviderSchema.parse(RUNTIME_PROVIDERS.CLAUDE_CODE)).toBe("claude-code");
    expect(runtimeProviderSchema.parse(RUNTIME_PROVIDERS.CLAUDE_CODE_TUI)).toBe("claude-code-tui");
    expect(runtimeProviderSchema.parse(RUNTIME_PROVIDERS.CODEX)).toBe("codex");
    expect(runtimeProviderSchema.parse(RUNTIME_PROVIDERS.CURSOR)).toBe("cursor");
    expect(runtimeProviderSchema.parse(RUNTIME_PROVIDERS.KIMI_CODE)).toBe("kimi-code");
  });

  it("DEFAULT_RUNTIME_PROVIDER is claude-code (existing rows pre-0026 have no kind)", () => {
    expect(DEFAULT_RUNTIME_PROVIDER).toBe("claude-code");
  });

  it("marks temporarily disabled providers as unavailable for selection", () => {
    expect(isRuntimeProviderEnabled("claude-code")).toBe(true);
    expect(isRuntimeProviderEnabled("codex")).toBe(true);
    expect(isRuntimeProviderEnabled("cursor")).toBe(true);
    expect(isRuntimeProviderEnabled("kimi-code")).toBe(true);
    expect(isRuntimeProviderEnabled("claude-code-tui")).toBe(false);
    expect(isRuntimeProviderEnabled("future-provider")).toBe(true);
  });
});

describe("capabilityEntrySchema", () => {
  it("CAPABILITY_STATES enumerates the three documented states", () => {
    expect(Object.values(CAPABILITY_STATES).sort()).toEqual(["error", "missing", "ok"].sort());
  });

  it("accepts a fully-formed `ok` entry", () => {
    const parsed = capabilityEntrySchema.parse({
      state: "ok",
      available: true,
      sdkVersion: "0.2.84",
      runtimeSource: "path",
      runtimePath: "/usr/local/bin/codex",
      detectedAt: new Date().toISOString(),
    });
    expect(parsed.state).toBe("ok");
    expect(parsed.sdkVersion).toBe("0.2.84");
    expect(parsed.runtimeSource).toBe("path");
    expect(parsed.runtimePath).toBe("/usr/local/bin/codex");
  });

  it("accepts `missing` with null sdkVersion", () => {
    const parsed = capabilityEntrySchema.parse({
      state: "missing",
      available: false,
      sdkVersion: null,
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
        detectedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
  // Dropped "rejects an invalid authMethod value": authMethod was removed from
  // the capability schema (detection is install-only, no auth probe).
});

describe("capabilityEntrySchema — cross-version wire compat (rolling upgrade)", () => {
  it("coerces a legacy `unauthenticated` state from an older daemon to `ok` (not rejected)", () => {
    // Reject-on-one-bad-entry would drop a client's whole snapshot; an old
    // daemon's `unauthenticated` (installed-but-logged-out, available:true) must
    // be accepted and normalized to the canonical install-only `ok`.
    const parsed = capabilityEntrySchema.parse({
      state: "unauthenticated",
      available: true,
      authenticated: false,
      authMethod: "none",
      detectedAt: new Date().toISOString(),
    });
    expect(parsed.state).toBe("ok");
  });

  it("accepts (and keeps) the deprecated `authenticated` / `authMethod` an older server requires", () => {
    const parsed = capabilityEntrySchema.parse({
      state: "ok",
      available: true,
      authenticated: true,
      authMethod: "oauth",
      detectedAt: new Date().toISOString(),
    });
    expect(parsed.authenticated).toBe(true);
    expect(parsed.authMethod).toBe("oauth");
  });

  it("accepts a new-shape entry that omits the deprecated auth fields", () => {
    const parsed = capabilityEntrySchema.parse({
      state: "ok",
      available: true,
      detectedAt: new Date().toISOString(),
    });
    expect(parsed.authenticated).toBeUndefined();
    expect(parsed.authMethod).toBeUndefined();
  });

  it("a legacy `unauthenticated` entry does not poison the rest of the snapshot", () => {
    const parsed = clientCapabilitiesSchema.parse({
      "claude-code": { state: "ok", available: true, detectedAt: new Date().toISOString() },
      codex: {
        state: "unauthenticated",
        available: true,
        authenticated: false,
        authMethod: "none",
        detectedAt: new Date().toISOString(),
      },
    });
    // Both entries survive; the legacy one is normalized to `ok`.
    expect(parsed["claude-code"]?.state).toBe("ok");
    expect(parsed.codex?.state).toBe("ok");
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
        sdkVersion: "0.2.84",
        detectedAt: new Date().toISOString(),
      },
      "future-provider": {
        state: "missing",
        available: false,
        sdkVersion: null,
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
