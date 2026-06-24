import type { CapabilityEntry, PendingAuth } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  deriveRuntimeAuthView,
  providerAuthHandledInProduct,
  providerSupportsInProductAuth,
  runtimeAuthIsPending,
} from "./runtime-auth-view.js";

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

  it("carries the browser auth URL into the browser-pending view (no-auto-open fallback link)", () => {
    const view = deriveRuntimeAuthView(
      "codex",
      entry({ pendingAuth: { method: "browser", expiresAt: "2026-06-22T12:05:00.000Z", authUrl: "https://x/auth" } }),
      NOW,
    );
    expect(view).toEqual({ kind: "browser-pending", authUrl: "https://x/auth" });
  });

  it("offers Connect for an unauthenticated codex with no pending login", () => {
    expect(deriveRuntimeAuthView("codex", entry({}), NOW)).toEqual({ kind: "connectable" });
  });

  it("surfaces a prior login failure on the connectable view (so the card can say 'retry')", () => {
    const lastAuthError = {
      reason: "exit-nonzero",
      message: "account not authorized",
      at: "2026-06-22T11:59:00.000Z",
    } as const;
    expect(deriveRuntimeAuthView("codex", entry({ lastAuthError }), NOW)).toEqual({
      kind: "connectable",
      lastError: lastAuthError,
    });
  });

  it("a live pending login wins over a recorded failure (a fresh attempt is running)", () => {
    const view = deriveRuntimeAuthView(
      "codex",
      entry({
        pendingAuth: browserPending("2026-06-22T12:05:00.000Z"),
        lastAuthError: { reason: "timeout", at: "2026-06-22T11:50:00.000Z" },
      }),
      NOW,
    );
    expect(view.kind).toBe("browser-pending");
  });

  it("falls back to connectable once a pending login has expired", () => {
    expect(
      deriveRuntimeAuthView("codex", entry({ pendingAuth: browserPending("2026-06-22T11:50:00.000Z") }), NOW),
    ).toEqual({ kind: "connectable" });
  });

  it("offers Connect for an unauthenticated claude-code (cc/codex parity)", () => {
    expect(deriveRuntimeAuthView("claude-code", entry({}), NOW)).toEqual({ kind: "connectable" });
  });

  it("offers nothing for a provider without in-product auth (claude-code-tui)", () => {
    expect(deriveRuntimeAuthView("claude-code-tui", entry({}), NOW)).toEqual({ kind: "none" });
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
    expect(providerSupportsInProductAuth("claude-code")).toBe(true);
    expect(providerSupportsInProductAuth("claude-code-tui")).toBe(false);
  });

  it("treats claude-code-tui's auth as in-product (shared Claude keychain) — no manual login hint", () => {
    // tui has no Connect of its own, but its credentials come from the Claude
    // Code login, so it must not show a manual "Run `claude auth login`" hint.
    expect(providerAuthHandledInProduct("claude-code-tui")).toBe(true);
    expect(providerAuthHandledInProduct("codex")).toBe(true);
    expect(providerAuthHandledInProduct("claude-code")).toBe(true);
  });
});
