// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Select } from "../select.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
  { value: "alpha", label: "Alpha" },
  { value: "bravo", label: "Bravo", disabled: true },
  { value: "charlie", label: "Charlie", hint: "fast" },
] as const;

describe("Select behavior", () => {
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
    document.body.querySelectorAll('[role="listbox"]').forEach((listbox) => {
      listbox.parentElement?.remove();
    });
  });

  function renderSelect(props: Partial<ComponentProps<typeof Select>> = {}): {
    readonly onChange: ReturnType<typeof vi.fn>;
  } {
    const onChange = vi.fn();

    act(() => {
      root.render(<Select aria-label="Runtime" value="alpha" onChange={onChange} options={[...OPTIONS]} {...props} />);
    });

    return { onChange };
  }

  function trigger(): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Runtime"]');
    if (!button) throw new Error("select trigger was not rendered");
    return button;
  }

  function openSelect(): void {
    act(() => {
      trigger().click();
    });
  }

  function listbox(): HTMLElement {
    const list = document.querySelector<HTMLElement>('[role="listbox"]');
    if (!list) throw new Error("select listbox was not rendered");
    return list;
  }

  function option(label: string): HTMLButtonElement {
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (button) => button.textContent?.includes(label) ?? false,
    );
    if (!item) throw new Error(`select option was not rendered: ${label}`);
    return item;
  }

  function keydown(target: Element, key: string): void {
    act(() => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  }

  function input(element: HTMLInputElement, value: string): void {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(element, value);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    });
  }

  it("filters searchable options, reports empty results, and commits the active option from the input", () => {
    const { onChange } = renderSelect({ searchable: true });
    openSelect();

    const search = document.querySelector<HTMLInputElement>('[role="combobox"]');
    if (!search) throw new Error("search input was not rendered");

    input(search, "char");

    expect(listbox().textContent).toContain("Charlie");
    expect(listbox().textContent).not.toContain("Alpha");

    keydown(search, "Enter");
    expect(onChange).toHaveBeenCalledWith("charlie");
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    openSelect();
    const nextSearch = document.querySelector<HTMLInputElement>('[role="combobox"]');
    if (!nextSearch) throw new Error("search input was not rendered after reopen");
    input(nextSearch, "missing");

    expect(document.body.textContent).toContain("No matches");
    keydown(nextSearch, "Enter");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("skips disabled options during keyboard and pointer navigation", () => {
    const { onChange } = renderSelect();
    openSelect();

    keydown(listbox(), "ArrowDown");
    keydown(listbox(), "Enter");
    expect(onChange).toHaveBeenCalledWith("charlie");

    openSelect();
    act(() => {
      option("Bravo").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      option("Bravo").click();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it("opens from the keyboard, supports type-ahead, and closes on Escape, Tab, or outside pointer", () => {
    const { onChange } = renderSelect({ value: "missing", placeholder: "Pick" });

    expect(trigger().textContent).toContain("Pick");
    keydown(trigger(), " ");
    expect(listbox()).not.toBeNull();

    keydown(listbox(), "c");
    keydown(listbox(), "Enter");
    expect(onChange).toHaveBeenCalledWith("charlie");

    keydown(trigger(), "Enter");
    keydown(listbox(), "Escape");
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    keydown(trigger(), "ArrowDown");
    keydown(listbox(), "Tab");
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    keydown(trigger(), "ArrowUp");
    act(() => {
      document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });

    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});
