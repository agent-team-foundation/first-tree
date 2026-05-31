// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
}

beforeEach(() => {
  vi.useFakeTimers();
  setHidden(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runVisibilityAwareInterval", () => {
  it("ticks immediately, pauses while hidden, resumes on visibility, and tears down cleanly", async () => {
    const { runVisibilityAwareInterval } = await import("../visibility-interval.js");
    const tick = vi.fn();

    const cleanup = runVisibilityAwareInterval(tick, 1000);
    expect(tick).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2500);
    expect(tick).toHaveBeenCalledTimes(3);

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(2500);
    expect(tick).toHaveBeenCalledTimes(3);

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(tick).toHaveBeenCalledTimes(4);

    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(5);

    cleanup();
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(5);

    document.dispatchEvent(new Event("visibilitychange"));
    expect(tick).toHaveBeenCalledTimes(5);
  });

  it("stays idle when mounted in a hidden document until the page becomes visible", async () => {
    setHidden(true);
    const { runVisibilityAwareInterval } = await import("../visibility-interval.js");
    const tick = vi.fn();

    const cleanup = runVisibilityAwareInterval(tick, 1000);
    expect(tick).not.toHaveBeenCalled();

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(tick).toHaveBeenCalledTimes(1);

    cleanup();
  });
});
