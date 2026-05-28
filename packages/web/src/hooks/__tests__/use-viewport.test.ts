import { beforeEach, describe, expect, it, vi } from "vitest";

type EffectCleanup = undefined | (() => void);

const reactState = vi.hoisted(() => ({
  cleanup: undefined as EffectCleanup,
  setValues: [] as unknown[],
}));

vi.mock("react", () => ({
  useEffect: (effect: () => EffectCleanup) => {
    reactState.cleanup = effect();
  },
  useState: (initial: unknown) => {
    const value = typeof initial === "function" ? initial() : initial;
    return [
      value,
      (next: unknown) => {
        reactState.setValues.push(typeof next === "function" ? next(value) : next);
      },
    ];
  },
}));

function stubViewport(xl: boolean, md: boolean) {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: query.includes("80rem") ? xl : md,
      addEventListener,
      removeEventListener,
    }),
  });
  return { addEventListener, removeEventListener };
}

describe("useWorkspaceViewport", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    reactState.cleanup = undefined;
    reactState.setValues = [];
  });

  it("falls back to xl when no browser window exists", async () => {
    const { useWorkspaceViewport } = await import("../use-viewport.js");

    expect(useWorkspaceViewport()).toBe("xl");
    expect(reactState.cleanup).toBeUndefined();
  });

  it("reads xl, md, and narrow breakpoints and unregisters listeners", async () => {
    let listeners = stubViewport(true, true);
    let { useWorkspaceViewport } = await import("../use-viewport.js");
    expect(useWorkspaceViewport()).toBe("xl");
    expect(listeners.addEventListener).toHaveBeenCalledTimes(2);
    expect(typeof reactState.cleanup).toBe("function");
    reactState.cleanup?.();
    expect(listeners.removeEventListener).toHaveBeenCalledTimes(2);

    vi.resetModules();
    reactState.cleanup = undefined;
    listeners = stubViewport(false, true);
    ({ useWorkspaceViewport } = await import("../use-viewport.js"));
    expect(useWorkspaceViewport()).toBe("md");

    vi.resetModules();
    reactState.cleanup = undefined;
    listeners = stubViewport(false, false);
    ({ useWorkspaceViewport } = await import("../use-viewport.js"));
    expect(useWorkspaceViewport()).toBe("narrow");
  });
});
