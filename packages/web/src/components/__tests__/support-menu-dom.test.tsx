// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SupportMenu } from "../support-menu.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  return container;
}

async function dispatch(target: EventTarget, event: Event): Promise<void> {
  await act(async () => {
    target.dispatchEvent(event);
  });
}

function trigger(rootNode: ParentNode): HTMLButtonElement {
  const button = rootNode.querySelector<HTMLButtonElement>('button[aria-label="Help and community"]');
  if (!button) throw new Error("Missing support menu trigger");
  return button;
}

beforeEach(() => {
  document.body.innerHTML = "";
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

describe("SupportMenu", () => {
  it("opens the community menu, toggles hover color, and closes on Escape", async () => {
    const dom = await render(<SupportMenu />);
    const button = trigger(dom);

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="menu"]')).toBeNull();

    await dispatch(button, new MouseEvent("mouseover", { bubbles: true }));
    expect(button.style.color).toBe("var(--fg)");
    await dispatch(button, new MouseEvent("mouseout", { bubbles: true }));
    expect(button.style.color).toBe("var(--fg-3)");

    await dispatch(button, new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("Need help?");
    expect(document.body.textContent).toContain("WeChat group");
    expect(document.body.textContent).toContain("Discord");

    await dispatch(window, new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("keeps inside clicks open and closes on outside mousedown", async () => {
    const dom = await render(<SupportMenu />);
    const button = trigger(dom);
    await dispatch(button, new MouseEvent("click", { bubbles: true, cancelable: true }));
    const menu = document.querySelector('[role="menu"]');
    if (!menu) throw new Error("Missing support menu panel");

    await dispatch(menu, new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    await dispatch(document.body, new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
