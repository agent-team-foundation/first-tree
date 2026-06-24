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

  it("resumes on window focus when visibilitychange is missed (app-switch return)", async () => {
    const { runVisibilityAwareInterval } = await import("../visibility-interval.js");
    const tick = vi.fn();

    const cleanup = runVisibilityAwareInterval(tick, 1000);
    expect(tick).toHaveBeenCalledTimes(1);

    // Tab goes hidden → pause (this event does fire).
    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(1);

    // User returns from a terminal: the window regains focus but the matching
    // `visibilitychange` → visible never arrives. `focus` must resume the poll
    // and re-tick immediately — this is the onboarding stuck-on-"connecting" fix.
    setHidden(false);
    window.dispatchEvent(new Event("focus"));
    expect(tick).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(3);

    cleanup();
  });

  it("ignores focus while already running (no double tick, no stacked interval)", async () => {
    const { runVisibilityAwareInterval } = await import("../visibility-interval.js");
    const tick = vi.fn();

    const cleanup = runVisibilityAwareInterval(tick, 1000);
    expect(tick).toHaveBeenCalledTimes(1);

    // Refocus while visible + running is a no-op (handle guard).
    window.dispatchEvent(new Event("focus"));
    expect(tick).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2); // single interval, not stacked

    cleanup();
  });

  it("does not resume on focus while the page is still hidden", async () => {
    const { runVisibilityAwareInterval } = await import("../visibility-interval.js");
    const tick = vi.fn();

    const cleanup = runVisibilityAwareInterval(tick, 1000);
    expect(tick).toHaveBeenCalledTimes(1);

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(tick).toHaveBeenCalledTimes(1);

    // A focus event while still hidden must not start the poll.
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("removes focus/pageshow listeners on teardown", async () => {
    const { runVisibilityAwareInterval } = await import("../visibility-interval.js");
    const tick = vi.fn();

    const cleanup = runVisibilityAwareInterval(tick, 1000);
    expect(tick).toHaveBeenCalledTimes(1);
    cleanup();

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
