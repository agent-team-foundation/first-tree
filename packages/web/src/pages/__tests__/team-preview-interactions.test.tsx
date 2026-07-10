// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamPreviewPage } from "../team-preview.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement;

function installBrowserMocks(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderPage(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<TeamPreviewPage />);
  });
  await flush();
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

function buttonByLabel(label: RegExp): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    label.test(candidate.getAttribute("aria-label") ?? ""),
  );
  if (!button) throw new Error(`Missing labelled button: ${label}`);
  return button;
}

function pageText(): string {
  return document.body.textContent ?? "";
}

describe("TeamPreviewPage interactions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.className = "";
    installBrowserMocks(true);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    document.body.innerHTML = "";
    document.documentElement.className = "";
    vi.restoreAllMocks();
  });

  it("drives role, filter, usage, theme, row action, and delegate controls", async () => {
    await renderPage();

    expect(pageText()).toContain("Team");
    expect(pageText()).not.toContain("Invite link");

    await click(buttonByText("Admin"));
    expect(pageText()).toContain("Invite link");
    expect(pageText()).toContain("Ava's Helper");

    await click(buttonByText("Mine"));
    expect(pageText()).not.toContain("Nova");
    expect(pageText()).toContain("Scout");

    await click(buttonByText("7d"));
    expect(buttonByText("7d").getAttribute("aria-pressed")).toBe("true");

    await click(buttonByLabel(/Actions for Scout/));
    expect(pageText()).toContain("Delete");
    await click(buttonByText("Delete"));
    expect(pageText()).not.toContain("Delete");

    await click(buttonByText("Scout"));
    await click(buttonByText("Sandbox"));
    expect(pageText()).toContain("Sandbox");

    await click(buttonByText("theme"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
