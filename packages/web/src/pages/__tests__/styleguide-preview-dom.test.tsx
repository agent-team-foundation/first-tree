// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToastProvider } from "../../components/ui/toast.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderDom(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ToastProvider>{element}</ToastProvider>);
  });
  await flush();
  return { container, root };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected clickable element");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function keydown(element: Element | null, key: string): Promise<void> {
  if (!element) throw new Error(`Expected key target for ${key}`);
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement | null {
  return [...root.querySelectorAll("button")].find((button) => button.textContent?.trim() === text) ?? null;
}

function buttonContaining(root: ParentNode, text: string): HTMLButtonElement | null {
  return [...root.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
  localStorage.clear();
  window.history.replaceState(null, "", "/preview/styleguide");
});

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

describe("StyleguidePreviewPage", () => {
  it("renders interactive styleguide controls and preview feedback", async () => {
    const { StyleguidePreviewPage } = await import("../styleguide-preview.js");
    const { container, root } = await renderDom(<StyleguidePreviewPage />);

    expect(container.textContent).toContain("First Tree · Design System");

    await click(buttonByText(container, "Activity 3"));
    expect(container.textContent).toContain("Activity");
    await click(buttonByText(container, "Settings"));
    expect(document.body.querySelector('[aria-label="unsaved changes"]')).not.toBeNull();
    await click(buttonByText(container, "Overview"));
    expect(container.textContent).toContain("Overview");

    await click(buttonByText(container, "Open popover"));
    expect(document.body.textContent).toContain("Anchored popover panel");
    await click(buttonByText(document.body, "Close"));
    expect(document.body.textContent).not.toContain("Anchored popover panel");

    await click(buttonByText(container, "Show toast"));
    expect(document.body.textContent).toContain("Changes saved");
    await click(buttonByText(document.body, "Undo"));
    expect(document.body.textContent).not.toContain("Changes saved");

    await click(buttonByText(container, "Dark mode"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
    await click(buttonByText(container, "Light mode"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");

    const model = container.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
    await click(model);
    await keydown(document.body.querySelector('[role="listbox"][aria-label="Model"]'), "End");
    await click(buttonContaining(document.body, "claude-haiku-4-5"));
    expect(model?.textContent).toContain("claude-haiku-4-5");

    const delegate = container.querySelector<HTMLButtonElement>('button[aria-label="Delegate"]');
    await click(delegate);
    await click(buttonContaining(document.body, "Cleo (@cleo)"));
    expect(delegate?.textContent).toContain("Cleo (@cleo)");

    await click(delegate);
    await keydown(document.body.querySelector('input[role="combobox"]'), "Escape");

    await act(async () => root.unmount());
  });

  it("honors a theme query override on mount", async () => {
    window.history.replaceState(null, "", "/preview/styleguide?theme=dark");
    const { StyleguidePreviewPage } = await import("../styleguide-preview.js");
    const { root } = await renderDom(<StyleguidePreviewPage />);

    expect(document.documentElement.classList.contains("dark")).toBe(true);

    await act(async () => root.unmount());
  });
});
