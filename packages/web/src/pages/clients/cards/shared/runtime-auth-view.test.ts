import type { CapabilityEntry } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { deriveRuntimeAuthView, providerSupportsInProductAuth, runtimeAuthIsPending } from "./runtime-auth-view.js";

const NOW = Date.parse("2026-06-22T12:00:00.000Z");

const entry = (over: Partial<CapabilityEntry>): CapabilityEntry => ({
  state: "unauthenticated",
  available: true,
  authenticated: false,
  authMethod: "none",
  detectedAt: "2026-06-22T12:00:00.000Z",
  ...over,
});

const pending = (expiresAt: string) => ({
  verificationUrl: "https://auth.openai.com/codex/device",
  userCode: "0WYJ-KDUHH",
  expiresAt,
});

describe("deriveRuntimeAuthView", () => {
  it("shows the device code while a pending login is live", () => {
    const view = deriveRuntimeAuthView("codex", entry({ pendingDeviceAuth: pending("2026-06-22T12:10:00.000Z") }), NOW);
    expect(view).toEqual({
      kind: "device-code",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "0WYJ-KDUHH",
      expiresAt: "2026-06-22T12:10:00.000Z",
    });
    expect(runtimeAuthIsPending(view)).toBe(true);
  });

  it("offers Connect for an unauthenticated codex with no pending code", () => {
    expect(deriveRuntimeAuthView("codex", entry({}), NOW)).toEqual({ kind: "connectable" });
  });

  it("falls back to connectable once the device code has expired", () => {
    const view = deriveRuntimeAuthView("codex", entry({ pendingDeviceAuth: pending("2026-06-22T11:50:00.000Z") }), NOW);
    expect(view).toEqual({ kind: "connectable" });
  });

  it("offers nothing for a provider without in-product auth (claude-code)", () => {
    expect(deriveRuntimeAuthView("claude-code", entry({}), NOW)).toEqual({ kind: "none" });
  });

  it("offers nothing when ok / missing / null", () => {
    expect(deriveRuntimeAuthView("codex", entry({ state: "ok", authenticated: true }), NOW)).toEqual({ kind: "none" });
    expect(deriveRuntimeAuthView("codex", entry({ state: "missing", available: false }), NOW)).toEqual({
      kind: "none",
    });
    expect(deriveRuntimeAuthView("codex", null, NOW)).toEqual({ kind: "none" });
  });

  it("still shows a pending code from a claude-code provider (display is provider-agnostic)", () => {
    const view = deriveRuntimeAuthView(
      "claude-code",
      entry({ pendingDeviceAuth: pending("2026-06-22T12:10:00.000Z") }),
      NOW,
    );
    expect(view.kind).toBe("device-code");
  });

  it("knows which providers support in-product auth", () => {
    expect(providerSupportsInProductAuth("codex")).toBe(true);
    expect(providerSupportsInProductAuth("claude-code")).toBe(false);
    expect(providerSupportsInProductAuth("claude-code-tui")).toBe(false);
  });
});
