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
  state: "ok",
  available: true,
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

  it("offers nothing for an installed codex with no pending login (detection is install-only)", () => {
    // The connectable-by-logged-out path was removed with the Connect button:
    // detection no longer carries an "unauthenticated" state, so an ok entry
    // with no live pending login derives `none`.
    expect(deriveRuntimeAuthView("codex", entry({}), NOW)).toEqual({ kind: "none" });
  });

  // Dropped "surfaces a prior login failure on the connectable view": the
  // connectable-by-state branch is gone, so `lastAuthError` no longer surfaces
  // here (it returns `none`). Revived with the future in-chat auth entry point.

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

  it("falls back to none once a pending login has expired (no connectable-by-state path)", () => {
    expect(
      deriveRuntimeAuthView("codex", entry({ pendingAuth: browserPending("2026-06-22T11:50:00.000Z") }), NOW),
    ).toEqual({ kind: "none" });
  });

  it("offers nothing for an installed claude-code with no pending login (cc/codex parity)", () => {
    expect(deriveRuntimeAuthView("claude-code", entry({}), NOW)).toEqual({ kind: "none" });
  });

  it("offers nothing for a provider without in-product auth (claude-code-tui)", () => {
    expect(deriveRuntimeAuthView("claude-code-tui", entry({}), NOW)).toEqual({ kind: "none" });
  });

  it("offers nothing when ok / missing / null", () => {
    expect(deriveRuntimeAuthView("codex", entry({ state: "ok" }), NOW)).toEqual({ kind: "none" });
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

  it("forceConnectable revives the Connect affordance on an installed credential failure (state ok)", () => {
    // The real in-chat case: a runtime credential error leaves the entry `state:
    // "ok"` (installed) with a `lastAuthError`. forceConnectable must surface the
    // connectable view carrying that error.
    const view = deriveRuntimeAuthView(
      "claude-code",
      entry({ lastAuthError: { reason: "timeout", at: "2026-06-22T11:55:00.000Z" } }),
      NOW,
      true,
    );
    expect(view).toEqual({
      kind: "connectable",
      lastError: { reason: "timeout", at: "2026-06-22T11:55:00.000Z" },
    });
  });

  it("forceConnectable still offers Connect when state is absent (not yet probed)", () => {
    // An entry whose `state` key is missing (older daemon) is treated like `ok`:
    // forceConnectable is honoured.
    const view = deriveRuntimeAuthView(
      "codex",
      { available: true, detectedAt: "2026-06-22T12:00:00.000Z" } as CapabilityEntry,
      NOW,
      true,
    );
    expect(view).toEqual({ kind: "connectable", lastError: undefined });
  });

  it("forceConnectable offers NOTHING when the runtime is not installed (missing + lastAuthError)", () => {
    // The daemon now stamps `lastAuthError` on ANY login failure, including when
    // the binary is gone (`state: "missing"`). A Connect there only re-fails
    // forever, so forceConnectable must withhold the affordance → none.
    const view = deriveRuntimeAuthView(
      "claude-code",
      entry({
        state: "missing",
        available: false,
        lastAuthError: { reason: "spawn-error", at: "2026-06-22T11:55:00.000Z" },
      }),
      NOW,
      true,
    );
    expect(view).toEqual({ kind: "none" });
  });

  it("forceConnectable offers NOTHING when the probe errored (state error + lastAuthError)", () => {
    const view = deriveRuntimeAuthView(
      "codex",
      entry({
        state: "error",
        available: false,
        lastAuthError: { reason: "spawn-error", at: "2026-06-22T11:55:00.000Z" },
      }),
      NOW,
      true,
    );
    expect(view).toEqual({ kind: "none" });
  });

  it("forceConnectable keeps the browser-pending state for an in-flight login regardless of state", () => {
    // The pending branch is evaluated before the state guard, so a live pending
    // login still wins (a missing entry with a live pending marker is the daemon
    // having just launched the login).
    const view = deriveRuntimeAuthView(
      "claude-code",
      entry({ state: "missing", available: false, pendingAuth: browserPending("2026-06-22T12:05:00.000Z") }),
      NOW,
      true,
    );
    expect(view.kind).toBe("browser-pending");
  });

  it("knows which providers support in-product auth", () => {
    expect(providerSupportsInProductAuth("codex")).toBe(true);
    expect(providerSupportsInProductAuth("claude-code")).toBe(true);
    expect(providerSupportsInProductAuth("cursor")).toBe(true);
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
