// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Select } from "../select.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Regression guard for the Select-inside-modal-Dialog bug.
 *
 * The Select panel is portaled to `document.body`. A Radix modal `Dialog`
 * (and `Popover`) set `pointer-events: none` on the body and only re-enable it
 * inside their own content — which the portaled panel is NOT. Without an
 * explicit `pointer-events: auto` on the panel, the options inherit `none` and
 * become unclickable: the dropdown opens but you cannot pick another option.
 *
 * happy-dom does not model layout or inherited `pointer-events`, so it cannot
 * reproduce the click failure itself (the real fix was verified in a browser).
 * What it CAN pin cheaply is that the panel always carries the inline
 * `pointer-events: auto` that overrides the inherited `none`. If a future
 * refactor drops that style, this test fails before the bug ships again.
 */
describe("Select portal — pointer-events escape hatch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function getTrigger(): HTMLButtonElement {
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Pick one"]');
    if (!trigger) throw new Error("trigger not rendered");
    return trigger;
  }

  it("renders the open panel with pointer-events:auto so it stays clickable inside a modal", () => {
    act(() => {
      root.render(
        <Select
          aria-label="Pick one"
          value="a"
          onChange={() => undefined}
          options={[
            { value: "a", label: "Alpha" },
            { value: "b", label: "Bravo" },
          ]}
        />,
      );
    });

    act(() => {
      getTrigger().click();
    });

    // The panel is portaled to document.body, outside the React root container.
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
    expect(listbox, "listbox should render once the panel is open").not.toBeNull();
    const panel = listbox?.parentElement;
    expect(panel, "panel wraps the listbox").not.toBeNull();
    expect(panel?.style.pointerEvents).toBe("auto");
  });
});
