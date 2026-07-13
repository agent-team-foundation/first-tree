// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { isIosStandalone, useIosStandaloneRootScrollGuard } from "../use-ios-standalone-root-scroll-guard.js";

function GuardProbe({ resetKey = "route-1" }: { resetKey?: string }) {
  useIosStandaloneRootScrollGuard(resetKey);
  return <div>guard</div>;
}

describe("iOS standalone root scroll guard", () => {
  let harness: DomHarness;
  let scrollX = 0;
  let scrollY = 0;
  let nextAnimationFrame = 1;
  let animationFrames: Map<number, FrameRequestCallback>;
  let visualViewportListeners: Map<string, Set<EventListenerOrEventListenerObject>>;
  let visualViewport: {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  };

  const flushAnimationFrames = () => {
    const pending = [...animationFrames.values()];
    animationFrames.clear();
    act(() => {
      for (const callback of pending) callback(performance.now());
    });
  };

  beforeEach(() => {
    harness = createDomHarness();
    animationFrames = new Map();
    visualViewportListeners = new Map();
    scrollX = 0;
    scrollY = 0;
    nextAnimationFrame = 1;

    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X)",
    });
    Object.defineProperty(window.navigator, "platform", { configurable: true, value: "iPhone" });
    Object.defineProperty(window.navigator, "standalone", { configurable: true, value: true });
    Object.defineProperty(window, "scrollX", { configurable: true, get: () => scrollX });
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        const id = nextAnimationFrame++;
        animationFrames.set(id, callback);
        return id;
      }),
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: vi.fn((id: number) => animationFrames.delete(id)),
    });
    Object.defineProperty(window, "scrollTo", {
      configurable: true,
      value: vi.fn(() => {
        scrollX = 0;
        scrollY = 0;
      }),
    });

    visualViewport = {
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        const listeners = visualViewportListeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
        listeners.add(listener);
        visualViewportListeners.set(type, listeners);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        visualViewportListeners.get(type)?.delete(listener);
      }),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visualViewport });
  });

  afterEach(() => {
    harness.cleanup();
    document.documentElement.classList.remove("ios-standalone-root-scroll-guard");
    vi.restoreAllMocks();
  });

  it("detects the iOS home-screen display mode", () => {
    expect(isIosStandalone()).toBe(true);

    Object.defineProperty(window.navigator, "standalone", { configurable: true, value: false });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    expect(isIosStandalone()).toBe(false);
  });

  it("clamps root scrolling after keyboard and viewport signals, then cleans up", async () => {
    scrollY = 38;
    harness.render(<GuardProbe />);
    await harness.flush();

    expect(document.documentElement.classList).toContain("ios-standalone-root-scroll-guard");
    flushAnimationFrames();
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);

    scrollY = 24;
    document.dispatchEvent(new FocusEvent("focusout"));
    flushAnimationFrames();
    expect(window.scrollTo).toHaveBeenCalledTimes(2);

    scrollY = 12;
    act(() => {
      for (const listener of visualViewportListeners.get("resize") ?? []) {
        if (typeof listener === "function") listener(new Event("resize"));
        else listener.handleEvent(new Event("resize"));
      }
    });
    flushAnimationFrames();
    expect(window.scrollTo).toHaveBeenCalledTimes(3);

    scrollY = 6;
    harness.render(<GuardProbe resetKey="route-2" />);
    await harness.flush();
    flushAnimationFrames();
    expect(window.scrollTo).toHaveBeenCalledTimes(4);

    harness.cleanup();
    expect(document.documentElement.classList).not.toContain("ios-standalone-root-scroll-guard");
    expect(visualViewport.removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(visualViewport.removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));

    harness = createDomHarness();
  });

  it("does not mount the guard outside iOS standalone mode", async () => {
    Object.defineProperty(window.navigator, "standalone", { configurable: true, value: false });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });

    scrollY = 20;
    harness.render(<GuardProbe />);
    await harness.flush();
    flushAnimationFrames();

    expect(document.documentElement.classList).not.toContain("ios-standalone-root-scroll-guard");
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});
