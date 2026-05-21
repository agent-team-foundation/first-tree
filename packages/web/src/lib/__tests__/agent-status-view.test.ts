import type { AgentMainStatus } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { type AgentStatusView, viewOf } from "../agent-status-view.js";

const ALL: AgentMainStatus[] = ["offline", "failed", "needs_you", "working", "paused", "ready"];

describe("viewOf — §9.1 visual vocabulary", () => {
  it("working = blue solid dot with the working pulse", () => {
    const v = viewOf("working");
    expect(v.colorVar).toBe("var(--state-working)");
    expect(v.shape).toBe("dot");
    expect(v.pulse).toBe("working");
    expect(v.animationClass).toBe("agent-status-pulse--working");
  });

  it("needs_you = amber solid dot with the calm pulse", () => {
    const v = viewOf("needs_you");
    expect(v.colorVar).toBe("var(--state-blocked)");
    expect(v.shape).toBe("dot");
    expect(v.pulse).toBe("needs-you");
    expect(v.animationClass).toBe("agent-status-pulse--needs-you");
  });

  it("failed = red triangle, static", () => {
    const v = viewOf("failed");
    expect(v.colorVar).toBe("var(--state-error)");
    expect(v.shape).toBe("triangle");
    expect(v.pulse).toBeNull();
    expect(v.animationClass).toBeNull();
  });

  it("paused = pause glyph, static (distinct shape from offline)", () => {
    const v = viewOf("paused");
    expect(v.shape).toBe("pause");
    expect(v.pulse).toBeNull();
  });

  it("ready = green solid dot, static", () => {
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
