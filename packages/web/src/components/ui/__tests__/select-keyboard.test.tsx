// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { Select } from "../select.js";

describe("Select keyboard navigation", () => {
  let h: DomHarness;
  beforeEach(() => {
    h = createDomHarness();
  });
  afterEach(() => h.cleanup());

  it("opens via keyboard, moves with arrows, typeahead, Home/End, commits with Enter, closes Esc", async () => {
    const onChange = vi.fn();
    h.render(
      <Select
        aria-label="Pick fruit"
        value="apple"
        onChange={onChange}
        options={[
          { value: "apple", label: "Apple" },
          { value: "banana", label: "Banana" },
          { value: "cherry", label: "Cherry", disabled: true },
          { value: "date", label: "Date" },
        ]}
      />,
    );

    const trigger = h.container.querySelector<HTMLButtonElement>('button[aria-label="Pick fruit"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await h.flush();
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
    await act(async () => {
      listbox?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      listbox?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      listbox?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      listbox?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      listbox?.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    });
    await h.flush();

    await act(async () => {
      listbox?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await h.flush();
    expect(onChange).toHaveBeenCalled();

    await act(async () => {
      trigger?.click();
    });
    await h.flush();
    const openList = document.querySelector<HTMLElement>('[role="listbox"]');
    await act(async () => {
      openList?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await h.flush();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("supports searchable mode and option click", async () => {
    const onChange = vi.fn();
    h.render(
      <Select
        aria-label="Search fruit"
        value=""
        onChange={onChange}
        searchable
        options={[
          { value: "apple", label: "Apple" },
          { value: "apricot", label: "Apricot" },
          { value: "banana", label: "Banana" },
        ]}
      />,
    );
    const trigger = h.container.querySelector<HTMLButtonElement>('button[aria-label="Search fruit"]');
    await act(async () => {
      trigger?.click();
    });
    await h.flush();

    const input = document.querySelector<HTMLInputElement>('input[type="text"], input:not([type])');
    if (input) {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "ap");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await h.flush();
    }

    const option = Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
      el.textContent?.includes("Apricot"),
    );
    await act(async () => {
      option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await h.flush();
    expect(onChange).toHaveBeenCalledWith("apricot");
  });
});
