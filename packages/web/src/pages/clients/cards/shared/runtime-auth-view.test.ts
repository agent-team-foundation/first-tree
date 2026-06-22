import type { CapabilityEntry, PendingAuth } from "@first-tree/shared";
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

const browserPending = (expiresAt: string): PendingAuth => ({ method: "browser", expiresAt });
const deviceCodePending = (expiresAt: string): PendingAuth => ({
  method: "device-code",
  verificationUrl: "https://auth.openai.com/codex/device",
  userCode: "0WYJ-KDUHH",
  expiresAt,
});

describe("deriveRuntimeAuthView", () => {
  it("shows the browser-pending state while a browser login is live (PRIMARY)", () => {
    const view = deriveRuntimeAuthView(
      "codex",
      entry({ pendingAuth: browserPending("2026-06-22T12:05:00.000Z") }),
      NOW,
    );
    expect(view).toEqual({ kind: "browser-pending" });
    expect(runtimeAuthIsPending(view)).toBe(true);
  });

  it("shows the device code while a device-code login is live (FALLBACK)", () => {
    const view = deriveRuntimeAuthView(
      "codex",
      entry({ pendingAuth: deviceCodePending("2026-06-22T12:10:00.000Z") }),
      NOW,
    );
    expect(view).toEqual({
      kind: "device-code",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "0WYJ-KDUHH",
      expiresAt: "2026-06-22T12:10:00.000Z",
    });
    expect(runtimeAuthIsPending(view)).toBe(true);
  });

  it("offers Connect for an unauthenticated codex with no pending login", () => {
    expect(deriveRuntimeAuthView("codex", entry({}), NOW)).toEqual({ kind: "connectable" });
  });

  it("falls back to connectable once a pending login has expired", () => {
    expect(
      deriveRuntimeAuthView("codex", entry({ pendingAuth: browserPending("2026-06-22T11:50:00.000Z") }), NOW),
    ).toEqual({ kind: "connectable" });
    expect(
      deriveRuntimeAuthView("codex", entry({ pendingAuth: deviceCodePending("2026-06-22T11:50:00.000Z") }), NOW),
    ).toEqual({ kind: "connectable" });
  });

  it("ignores a device-code pending missing its url/code", () => {
    const view = deriveRuntimeAuthView(
      "codex",
      entry({ pendingAuth: { method: "device-code", expiresAt: "2026-06-22T12:10:00.000Z" } }),
      NOW,
    );
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

  it("still shows a pending login from any provider (display is provider-agnostic)", () => {
    const view = deriveRuntimeAuthView(
      "claude-code",
      entry({ pendingAuth: browserPending("2026-06-22T12:05:00.000Z") }),
      NOW,
    );
    expect(view.kind).toBe("browser-pending");
  });

  it("knows which providers support in-product auth", () => {
    expect(providerSupportsInProductAuth("codex")).toBe(true);
    expect(providerSupportsInProductAuth("claude-code")).toBe(false);
    expect(providerSupportsInProductAuth("claude-code-tui")).toBe(false);
  });
});
