// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canAutoShow,
  detectPlatform,
  hasShownThisSession,
  type InstallGuideState,
  isStandalone,
  MAX_AUTO_SHOWS,
  markInstalled,
  markShownThisSession,
  readInstallGuideState,
  recordAutoShow,
} from "../install-guide-state.js";

const eligibleInput = {
  state: { autoShowCount: 0, installed: false } satisfies InstallGuideState,
  standalone: false,
  platform: "ios" as const,
  hasContent: true,
  shownThisSession: false,
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("detectPlatform", () => {
  it("detects Android", () => {
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/125")).toBe("android");
  });
  it("detects iOS iPhone", () => {
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari")).toBe("ios");
  });
  it("returns other for desktop", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125")).toBe("other");
  });
});

describe("persisted state", () => {
  it("defaults to a fresh device when unset", () => {
    expect(readInstallGuideState()).toEqual({ autoShowCount: 0, installed: false });
  });
  it("counts each auto-show (the cap key, not dismissals)", () => {
    recordAutoShow();
    recordAutoShow();
    expect(readInstallGuideState().autoShowCount).toBe(2);
  });
  it("marks installed", () => {
    markInstalled();
    expect(readInstallGuideState().installed).toBe(true);
  });
  it("survives a corrupt value", () => {
    localStorage.setItem("first-tree:install-guide", "{not json");
    expect(readInstallGuideState()).toEqual({ autoShowCount: 0, installed: false });
  });
  it("tracks per-session shown flag", () => {
    expect(hasShownThisSession()).toBe(false);
    markShownThisSession();
    expect(hasShownThisSession()).toBe(true);
  });
});

describe("isStandalone", () => {
  it("is true under display-mode: standalone", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    expect(isStandalone()).toBe(true);
  });
  it("is true when navigator.standalone (iOS)", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
    expect(isStandalone()).toBe(true);
    Reflect.deleteProperty(window.navigator, "standalone");
  });
  it("is false in a normal browser tab", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    expect(isStandalone()).toBe(false);
  });
});

describe("canAutoShow", () => {
  it("allows a fresh, engaged, non-installed mobile user", () => {
    expect(canAutoShow(eligibleInput)).toBe(true);
  });
  it("blocks when already installed (standalone)", () => {
    expect(canAutoShow({ ...eligibleInput, standalone: true })).toBe(false);
  });
  it("blocks when the installed flag is set", () => {
    expect(canAutoShow({ ...eligibleInput, state: { autoShowCount: 0, installed: true } })).toBe(false);
  });
  it("blocks on desktop/other platforms", () => {
    expect(canAutoShow({ ...eligibleInput, platform: "other" })).toBe(false);
  });
  it("blocks once the lifetime auto-show cap is reached", () => {
    expect(canAutoShow({ ...eligibleInput, state: { autoShowCount: MAX_AUTO_SHOWS, installed: false } })).toBe(false);
  });
  it("allows the second show after a single prior show", () => {
    expect(canAutoShow({ ...eligibleInput, state: { autoShowCount: 1, installed: false } })).toBe(true);
  });
  it("blocks a second show within the same session", () => {
    expect(canAutoShow({ ...eligibleInput, shownThisSession: true })).toBe(false);
  });
  it("blocks over an empty feed", () => {
    expect(canAutoShow({ ...eligibleInput, hasContent: false })).toBe(false);
  });
});
