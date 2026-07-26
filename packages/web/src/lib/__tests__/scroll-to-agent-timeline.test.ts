// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollToAgentTimeline } from "../scroll-to-agent-timeline.js";

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("scrollToAgentTimeline", () => {
  it("scrolls to the latest matching timeline anchor for actionable states", () => {
    const first = document.createElement("div");
    const latest = document.createElement("div");
    first.setAttribute("data-working-agent", "agent-1");
    latest.setAttribute("data-working-agent", "agent-1");
    document.body.append(first, latest);
    const firstScroll = vi.fn();
    const latestScroll = vi.fn();
    first.scrollIntoView = firstScroll;
    latest.scrollIntoView = latestScroll;

    expect(scrollToAgentTimeline("agent-1", "working")).toBe(true);

    expect(firstScroll).not.toHaveBeenCalled();
    expect(latestScroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(latest.getAttribute("data-timeline-jump-highlight")).toBe("true");

    vi.advanceTimersByTime(1600);
    expect(latest.hasAttribute("data-timeline-jump-highlight")).toBe(false);
  });

  it("moves focus to keyboard-activated evidence without making it a permanent tab stop", () => {
    const target = document.createElement("div");
    target.setAttribute("data-working-agent", "agent-1");
    target.scrollIntoView = vi.fn();
    document.body.append(target);

    expect(scrollToAgentTimeline("agent-1", "working", { focus: true })).toBe(true);

    expect(document.activeElement).toBe(target);
    expect(target.tabIndex).toBe(-1);
    expect(target.getAttribute("data-timeline-jump-focus")).toBe("true");
    vi.advanceTimersByTime(1600);
    expect(target.hasAttribute("data-timeline-jump-highlight")).toBe(false);
    expect(target.getAttribute("data-timeline-jump-focus")).toBe("true");
    target.blur();
    expect(target.hasAttribute("tabindex")).toBe(false);
    expect(target.hasAttribute("data-timeline-jump-focus")).toBe(false);
  });

  it("uses instant scrolling when the user prefers reduced motion", () => {
    const target = document.createElement("div");
    target.setAttribute("data-working-agent", "agent-1");
    target.scrollIntoView = vi.fn();
    document.body.append(target);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );

    expect(scrollToAgentTimeline("agent-1", "working")).toBe(true);

    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
    vi.unstubAllGlobals();
  });

  it("handles errors, provider reasons, inert states, and missing anchors", () => {
    const error = document.createElement("div");
    error.setAttribute("data-error-agent", "agent-1");
    const reason = document.createElement("div");
    reason.setAttribute("data-status-reason-agent", "agent-1");
    document.body.append(error, reason);
    error.scrollIntoView = vi.fn();
    reason.scrollIntoView = vi.fn();

    expect(scrollToAgentTimeline("agent-1", "failed")).toBe(true);
    expect(scrollToAgentTimeline("agent-1", "reason")).toBe(true);
    expect(scrollToAgentTimeline("agent-1", "ready")).toBe(false);
    expect(scrollToAgentTimeline("missing", "working")).toBe(false);

    expect(error.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(reason.scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
