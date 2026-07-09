// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../../test-utils/dom-harness.js";
import { SidebarResizeHandle } from "../resize-handle.js";

describe("SidebarResizeHandle", () => {
  let h: DomHarness;
  beforeEach(() => {
    h = createDomHarness();
  });
  afterEach(() => h.cleanup());

  it("drags with mouse, commits on mouseup, ignores non-primary button", async () => {
    const onWidthChange = vi.fn();
    const onCommit = vi.fn();
    const onReset = vi.fn();
    h.render(
      <SidebarResizeHandle
        width={320}
        min={240}
        max={480}
        onWidthChange={onWidthChange}
        onCommit={onCommit}
        onReset={onReset}
      />,
    );

    const handle = h.container.querySelector<HTMLButtonElement>("button[aria-label='Resize chat details']");
    expect(handle).not.toBeNull();

    await act(async () => {
      handle?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2, clientX: 100 }));
    });
    expect(onWidthChange).not.toHaveBeenCalled();

    await act(async () => {
      handle?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 100 }));
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 80 }));
      window.dispatchEvent(new MouseEvent("mouseup", { clientX: 80 }));
    });
    await h.flush();
    // dragging left widens: startWidth + (startX - clientX) = 320 + 20
    expect(onWidthChange).toHaveBeenCalledWith(340);
    expect(onCommit).toHaveBeenCalledWith(340);
  });

  it("nudges with keyboard arrows and resets on double-click", async () => {
    const onWidthChange = vi.fn();
    const onCommit = vi.fn();
    const onReset = vi.fn();
    h.render(
      <SidebarResizeHandle
        width={300}
        min={240}
        max={480}
        onWidthChange={onWidthChange}
        onCommit={onCommit}
        onReset={onReset}
      />,
    );
    const handle = h.container.querySelector<HTMLButtonElement>("button[aria-label='Resize chat details']");

    await act(async () => {
      handle?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(onWidthChange).toHaveBeenCalledWith(316);
    expect(onCommit).toHaveBeenCalledWith(316);

    onWidthChange.mockClear();
    onCommit.mockClear();
    await act(async () => {
      handle?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onWidthChange).toHaveBeenCalledWith(284);
    expect(onCommit).toHaveBeenCalledWith(284);

    await act(async () => {
      handle?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onReset).toHaveBeenCalled();
  });
});
