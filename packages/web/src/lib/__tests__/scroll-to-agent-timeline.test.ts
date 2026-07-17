// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollToAgentTimeline } from "../scroll-to-agent-timeline.js";

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useFakeTimers();
});

afterEach(() => vi.useRealTimers());

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

    scrollToAgentTimeline("agent-1", "working");

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

    scrollToAgentTimeline("agent-1", "working", { focus: true });

    expect(document.activeElement).toBe(target);
    expect(target.tabIndex).toBe(-1);
    target.blur();
    expect(target.hasAttribute("tabindex")).toBe(false);
  });

  it("handles errors, inert states, and missing anchors", () => {
    const error = document.createElement("div");
    error.setAttribute("data-error-agent", "agent-1");
    document.body.append(error);
    error.scrollIntoView = vi.fn();

    scrollToAgentTimeline("agent-1", "failed");
    scrollToAgentTimeline("agent-1", "ready");
    scrollToAgentTimeline("missing", "working");

    expect(error.scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
