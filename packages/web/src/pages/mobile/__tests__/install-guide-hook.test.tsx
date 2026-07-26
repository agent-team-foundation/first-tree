// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit Chrome/125 Mobile";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit Chrome/125";

let harness: DomHarness;

function setUserAgent(ua: string): void {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua);
}

/** Dispatch a synthetic beforeinstallprompt; returns the preventDefault spy. */
function fireBeforeInstallPrompt(): ReturnType<typeof vi.fn> {
  const event = new Event("beforeinstallprompt");
  const preventDefault = vi.fn();
  event.preventDefault = preventDefault;
  Object.assign(event, {
    prompt: () => Promise.resolve(),
    userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
  });
  window.dispatchEvent(event);
  return preventDefault;
}

// Fresh module per test: the capture is a module singleton, so we reset modules
// and re-import to get a clean deferredPrompt/installed state each time.
async function renderModeProbe() {
  const mod = await import("../use-install-guide.js");
  function ModeProbe() {
    const { mode } = mod.useInstallPrompt();
    return <span data-testid="mode" data-mode={mode ?? "null"} />;
  }
  harness.render(<ModeProbe />);
  return () => harness.container.querySelector('[data-testid="mode"]')?.getAttribute("data-mode") ?? null;
}

beforeEach(() => {
  harness = createDomHarness();
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  harness.cleanup();
  vi.restoreAllMocks();
});

describe("install prompt capture lifecycle", () => {
  it("captures beforeinstallprompt on Android and offers one-tap install", async () => {
    setUserAgent(ANDROID_UA);
    const readMode = await renderModeProbe();
    expect(readMode()).toBe("android-manual"); // no prompt yet

    let preventDefault: ReturnType<typeof vi.fn> | undefined;
    await harness.flush();
    act(() => {
      preventDefault = fireBeforeInstallPrompt();
    });
    await harness.flush();

    expect(preventDefault).toHaveBeenCalled();
    expect(readMode()).toBe("native");
  });

  it("ignores beforeinstallprompt off the supported platform (no preventDefault)", async () => {
    setUserAgent(DESKTOP_UA);
    const readMode = await renderModeProbe();

    let preventDefault: ReturnType<typeof vi.fn> | undefined;
    act(() => {
      preventDefault = fireBeforeInstallPrompt();
    });
    await harness.flush();

    // Desktop: we leave the browser's own install UI alone and render nothing.
    expect(preventDefault).not.toHaveBeenCalled();
    expect(readMode()).toBe("null");
  });

  it("hides promotion reactively after a menu-driven appinstalled", async () => {
    setUserAgent(ANDROID_UA);
    const readMode = await renderModeProbe();
    // Android manual path: no prompt was captured, prompt stays null.
    expect(readMode()).toBe("android-manual");

    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    await harness.flush();

    expect(readMode()).toBe("null");
  });
});
