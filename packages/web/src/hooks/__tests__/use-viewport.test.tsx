// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceViewport } from "../use-viewport.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const matches = new Map<string, boolean>();
const listeners = new Map<string, Set<() => void>>();

function renderProbe(): void {
  function Probe() {
    return <div>{useWorkspaceViewport()}</div>;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Probe />);
  });
}

function setMedia(query: string, next: boolean): void {
  matches.set(query, next);
  act(() => {
    for (const listener of listeners.get(query) ?? []) listener();
  });
}

beforeEach(() => {
  matches.clear();
  listeners.clear();
  document.body.innerHTML = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      get matches() {
        return matches.get(query) ?? false;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => {
        const set = listeners.get(query) ?? new Set<() => void>();
        set.add(listener);
        listeners.set(query, set);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.get(query)?.delete(listener);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })),
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("useWorkspaceViewport", () => {
  it("tracks xl, md, and narrow viewport breakpoints", () => {
    matches.set("(min-width: 80rem)", true);
    matches.set("(min-width: 48rem)", true);

    renderProbe();
    expect(container?.textContent).toBe("xl");

    setMedia("(min-width: 80rem)", false);
    expect(container?.textContent).toBe("md");

    setMedia("(min-width: 48rem)", false);
    expect(container?.textContent).toBe("narrow");

    setMedia("(min-width: 80rem)", true);
    expect(container?.textContent).toBe("xl");
  });
});
