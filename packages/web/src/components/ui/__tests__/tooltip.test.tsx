// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { Tooltip } from "../tooltip.js";

/**
 * Tooltip is the styled, faster replacement for the native `title` attribute.
 * The hover path is timer-gated (and exercised in real use); these tests cover
 * the deterministic, non-timer behavior: the keyboard path (focus shows the
 * label immediately, blur/Esc hide it), the empty-label pass-through, and that
 * cloning the trigger preserves its own handlers.
 */
describe("Tooltip", () => {
  let h: DomHarness;
  beforeEach(() => {
    h = createDomHarness();
  });
  afterEach(() => h.cleanup());

  const tip = () => document.body.querySelector('[role="tooltip"]');

  it("shows the label on focus and hides it on blur", async () => {
    h.render(
      <Tooltip label="Show conversations">
        <button type="button" aria-label="Show conversations">
          icon
        </button>
      </Tooltip>,
    );
    const button = h.container.querySelector("button");
    expect(button).not.toBeNull();
    expect(tip()).toBeNull();

    await act(async () => button?.focus());
    expect(tip()?.textContent).toBe("Show conversations");

    await act(async () => button?.blur());
    expect(tip()).toBeNull();
  });

  it("hides on Escape while open", async () => {
    h.render(
      <Tooltip label="Add participant">
        <button type="button" aria-label="Add participant">
          icon
        </button>
      </Tooltip>,
    );
    const button = h.container.querySelector("button");
    await act(async () => button?.focus());
    expect(tip()).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(tip()).toBeNull();
  });

  it("renders the trigger untouched when label is empty", () => {
    h.render(
      <Tooltip label={undefined}>
        <button type="button" aria-label="Save">
          icon
        </button>
      </Tooltip>,
    );
    expect(h.container.querySelector('button[aria-label="Save"]')).not.toBeNull();
    expect(tip()).toBeNull();
  });

  it("preserves the trigger's own onClick and onFocus", async () => {
    const onClick = vi.fn();
    const onFocus = vi.fn();
    h.render(
      <Tooltip label="Save">
        <button type="button" aria-label="Save" onClick={onClick} onFocus={onFocus}>
          icon
        </button>
      </Tooltip>,
    );
    const button = h.container.querySelector("button");
    await act(async () => button?.focus());
    await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
    // The tooltip still appeared, so cloning didn't drop our handlers either.
    expect(tip()?.textContent).toBe("Save");
  });
});
