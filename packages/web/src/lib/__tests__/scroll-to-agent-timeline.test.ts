// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { scrollToAgentTimeline } from "../scroll-to-agent-timeline.js";

beforeEach(() => {
  document.body.innerHTML = "";
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

    scrollToAgentTimeline("agent-1", "working");

    expect(firstScroll).not.toHaveBeenCalled();
    expect(latestScroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
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
