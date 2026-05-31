// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type MatchMediaRecord = {
  listeners: Set<(event: MediaQueryListEvent) => void>;
  media: string;
  setMatches: (matches: boolean) => void;
};

const mediaRecords: MatchMediaRecord[] = [];

function installMatchMedia(initialMatches: boolean): void {
  mediaRecords.length = 0;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => {
      let matches = initialMatches;
      const record: MatchMediaRecord = {
        listeners: new Set(),
        media: query,
        setMatches: (next) => {
          matches = next;
          const event = { matches: next, media: query } as MediaQueryListEvent;
          for (const listener of record.listeners) listener(event);
        },
      };
      mediaRecords.push(record);
      return {
        get matches() {
          return matches;
        },
        media: query,
        onchange: null,
        addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
          record.listeners.add(listener);
        },
        removeEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
          record.listeners.delete(listener);
        },
        addListener: (listener: (event: MediaQueryListEvent) => void) => {
          record.listeners.add(listener);
        },
        removeListener: (listener: (event: MediaQueryListEvent) => void) => {
          record.listeners.delete(listener);
        },
        dispatchEvent: () => false,
      };
    },
  });
}

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await flush();
  return { container, root };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected an element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function setValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
  const storage = createStorage();
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  installMatchMedia(true);
});

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
  vi.restoreAllMocks();
});

describe("team preview page", () => {
  it("renders desktop rows and exercises role, filter, search, usage, theme, and delegate controls", async () => {
    const { TeamPreviewPage } = await import("../team-preview.js");
    const { myDelegateCandidates, PREVIEW_AGENTS, PREVIEW_HUMANS } = await import("../team-preview-mock.js");

    expect(myDelegateCandidates().map((agent) => agent.uuid)).toEqual(["a-research", "a-scout", "a-sandbox"]);
    expect(PREVIEW_AGENTS.some((agent) => agent.clientHost === null)).toBe(true);
    expect(PREVIEW_HUMANS.some((human) => human.delegate === null)).toBe(true);

    const { container, root } = await renderDom(<TeamPreviewPage />);
    expect(container.textContent).toContain("Agent teammates");
    expect(container.textContent).toContain("Human teammates");
    expect(container.textContent).toContain("Marketing Writer");
    expect(container.textContent).not.toContain("Ava's private drafting helper");
    expect(container.textContent).toContain("Add a description");

    await click(buttonByText(container, "Admin"));
    expect(container.textContent).toContain("Invite link");
    expect(container.textContent).toContain("Ava's private drafting helper");
    await click(container.querySelector('button[aria-label="Actions for Ava Chen"]'));
    expect(container.textContent).toContain("Remove from org");

    await click(buttonByText(container, "Mine"));
    expect(container.textContent).toContain("Scout");
    expect(container.textContent).not.toContain("Kael");

    await click(buttonByText(container, "All"));
    await click(buttonByText(container, "7d"));
    expect(container.textContent).toContain("4.5M");

    const search = container.querySelector<HTMLInputElement>('input[placeholder="Search name or @handle"]');
    if (!search) throw new Error("Search input missing");
    await setValue(search, "lin");
    expect(container.textContent).toContain("Lin Zhao");
    expect(container.textContent).not.toContain("Gandy Xiong");

    await setValue(search, "");
    await click(buttonByText(container, "theme"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    await click(buttonByText(container, "Scout"));
    expect(document.body.textContent).toContain("None");
    expect(document.body.textContent).toContain("Research");
    await click(buttonByText(document.body, "None"));
    expect(container.textContent).toContain("Set delegate");

    await act(async () => root.unmount());
  });

  it("renders compact rows and responds to media-query changes", async () => {
    installMatchMedia(false);
    const { TeamPreviewPage } = await import("../team-preview.js");

    const { container, root } = await renderDom(<TeamPreviewPage />);
    expect(container.textContent).toContain("Usage");
    expect(container.textContent).toContain("Delegate: Scout");
    expect(container.textContent).toContain("You · claude-code");
    expect(container.textContent).not.toContain("WorkspaceContextTeamSettings");

    await act(async () => {
      mediaRecords.at(-1)?.setMatches(true);
    });
    await flush();
    expect(container.textContent).toContain("Workspace");
    expect(container.textContent).toContain("Context");

    await act(async () => root.unmount());
  });
});
