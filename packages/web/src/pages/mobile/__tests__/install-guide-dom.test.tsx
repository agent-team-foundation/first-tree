// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { InstallGuideSheet } from "../install-guide-sheet.js";

let harness: DomHarness;

beforeEach(() => {
  harness = createDomHarness();
});

afterEach(() => {
  harness.cleanup();
});

function findButton(label: string): HTMLButtonElement | null {
  return (
    [...harness.container.querySelectorAll("button")].find((button) => button.textContent?.includes(label)) ?? null
  );
}

describe("InstallGuideSheet", () => {
  it("shows the value proposition and native one-tap CTA", () => {
    const onInstall = vi.fn();
    const onClose = vi.fn();
    harness.render(<InstallGuideSheet mode="native" onInstall={onInstall} onClose={onClose} />);

    const sheet = harness.container.querySelector('[data-mobile-install-sheet="true"]');
    expect(sheet?.textContent).toContain("Add First Tree to your home screen");
    expect(sheet?.textContent).toContain("Opens instantly");
    // Native mode is one-tap, not a step list.
    expect(sheet?.textContent).not.toContain("Share button");

    findButton("Add to Home Screen")?.click();
    expect(onInstall).toHaveBeenCalledTimes(1);
    findButton("Maybe later")?.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("teaches the iOS share steps and never calls install", () => {
    const onInstall = vi.fn();
    const onClose = vi.fn();
    harness.render(<InstallGuideSheet mode="ios" onInstall={onInstall} onClose={onClose} />);

    const sheet = harness.container.querySelector('[data-mobile-install-sheet="true"]');
    expect(sheet?.textContent).toContain("Share button below");
    expect(sheet?.textContent).toContain('Add to Home Screen"');
    expect(harness.container.querySelector("ol")).not.toBeNull();

    findButton("Got it")?.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("teaches the Android menu steps in the manual fallback", () => {
    harness.render(<InstallGuideSheet mode="android-manual" onInstall={vi.fn()} onClose={vi.fn()} />);
    const sheet = harness.container.querySelector('[data-mobile-install-sheet="true"]');
    expect(sheet?.textContent).toContain("browser menu");
    expect(sheet?.textContent).toContain("Install app");
  });

  it("dismisses on scrim click and Escape", () => {
    const onClose = vi.fn();
    harness.render(<InstallGuideSheet mode="ios" onInstall={vi.fn()} onClose={onClose} />);

    const scrim = harness.container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
    scrim?.click();
    expect(onClose).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
