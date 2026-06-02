import type { AgentMainStatus } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { type AgentStatusView, sessionStateToMain, viewOf } from "../agent-status-view.js";

const ALL: AgentMainStatus[] = ["offline", "failed", "working", "paused", "ready"];

describe("viewOf — §9.1 visual vocabulary", () => {
  it("working = green solid dot with the working pulse", () => {
    const v = viewOf("working");
    expect(v.colorVar).toBe("var(--state-working)");
    expect(v.shape).toBe("dot");
    expect(v.pulse).toBe("working");
    expect(v.animationClass).toBe("agent-status-pulse--working");
  });

  it("failed = red solid dot, static", () => {
    const v = viewOf("failed");
    expect(v.colorVar).toBe("var(--state-error)");
    expect(v.shape).toBe("dot");
    expect(v.pulse).toBeNull();
    expect(v.animationClass).toBeNull();
  });

  it("paused = pause glyph, static (distinct shape from offline)", () => {
    const v = viewOf("paused");
    expect(v.shape).toBe("pause");
    expect(v.pulse).toBeNull();
  });

  it("ready = blue (idle/present) solid dot, static", () => {
    const v = viewOf("ready");
    expect(v.colorVar).toBe("var(--state-idle)");
    expect(v.shape).toBe("dot");
    expect(v.pulse).toBeNull();
  });

  it("offline = hollow ring, static (distinct shape from paused)", () => {
    const v = viewOf("offline");
    expect(v.colorVar).toBe("var(--state-offline)");
    expect(v.shape).toBe("hollow");
    expect(v.pulse).toBeNull();
  });

  it("paused and offline are visually distinguishable (shape, not just color)", () => {
    expect(viewOf("paused").shape).not.toBe(viewOf("offline").shape);
  });

  it("every status yields a non-empty label and a token color", () => {
    for (const main of ALL) {
      const v: AgentStatusView = viewOf(main);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.colorVar.startsWith("var(--")).toBe(true);
      // A pulse kind always pairs with an animation class, and vice-versa.
      expect(v.pulse === null).toBe(v.animationClass === null);
    }
  });
});

describe("sessionStateToMain — F3 bridge (session C vocabulary → composite main)", () => {
  it("active is NOT 'working' — an active session is engaged, not live-working", () => {
    // `working` must come from live activity (D), which this mapping can't see;
    // mirrors deriveMainStatus(engagement=active) → ready.
    expect(sessionStateToMain("active")).toBe("ready");
  });

  it("maps the remaining session states to their composite main", () => {
    expect(sessionStateToMain("suspended")).toBe("paused");
    expect(sessionStateToMain("errored")).toBe("failed");
    expect(sessionStateToMain("evicted")).toBe("offline");
  });

  it("treats no-session / null / undefined as ready (not Offline — the F3 regression)", () => {
    expect(sessionStateToMain(null)).toBe("ready");
    expect(sessionStateToMain(undefined)).toBe("ready");
    expect(sessionStateToMain("none")).toBe("ready");
  });

  it("every mapped value is a real composite main (round-trips through viewOf)", () => {
    for (const state of ["active", "suspended", "errored", "evicted", "none", null] as const) {
      const main = sessionStateToMain(state);
      expect(ALL).toContain(main);
      expect(viewOf(main).label.length).toBeGreaterThan(0);
    }
  });
});
