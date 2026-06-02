// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1",
    role: "admin" as const,
    user: { id: "user-self", username: "gandy", displayName: "Gandy", avatarUrl: null },
    memberships: [],
    currentMembership: null,
    teamDisplayName: "Acme",
    logout: vi.fn(),
    selectOrganization: vi.fn(),
  },
}));

const disconnectMock = vi.hoisted(() => ({
  value: {
    rows: [],
    firstHostname: null,
  },
}));

const clientMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../hooks/use-disconnected-computers.js", () => ({
  useDisconnectedComputers: () => disconnectMock.value,
}));

vi.mock("../../api/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client.js")>();
  return { ...actual, api: { ...actual.api, get: clientMocks.get } };
});

vi.mock("../../pages/workspace/palette/command-palette.js", () => ({
  CommandPalette: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? (
      <div role="dialog" aria-label="Mock command palette">
        <span>Mock command palette</span>
        <button type="button" onClick={() => onOpenChange(false)}>
          Close palette
        </button>
      </div>
    ) : null,
}));

type MediaController = {
  query: string;
  setMatches: (matches: boolean) => void;
};

const mediaControllers: MediaController[] = [];

function installMatchMedia(matchesFor: (query: string) => boolean): void {
  mediaControllers.length = 0;
  const stateByQuery = new Map<string, boolean>();
  const listenersByQuery = new Map<string, Set<(event: MediaQueryListEvent) => void>>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => {
      if (!stateByQuery.has(query)) stateByQuery.set(query, matchesFor(query));
      const listeners = listenersByQuery.get(query) ?? new Set<(event: MediaQueryListEvent) => void>();
      listenersByQuery.set(query, listeners);
      const controller = {
        query,
        setMatches: (next: boolean) => {
          stateByQuery.set(query, next);
          const event = { matches: next, media: query } as MediaQueryListEvent;
          for (const listener of listeners) listener(event);
        },
      };
      mediaControllers.push(controller);
      return {
        get matches() {
          return stateByQuery.get(query) ?? false;
        },
        media: query,
        onchange: null,
        addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
        removeEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) =>
          listeners.delete(listener),
        addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
        removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
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

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderLayout(route: string): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const { Layout } = await import("../layout.js");
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <QueryClientProvider client={createClient()}>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<div>Workspace child</div>} />
              <Route path="context" element={<div>Context child</div>} />
              <Route path="settings" element={<div>Settings child</div>} />
            </Route>
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root };
}

async function keyDown(key: string, options: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
  });
  await flush();
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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
  installMatchMedia((query) => query.includes("80rem") || query.includes("48rem"));
  clientMocks.get.mockResolvedValue([{ id: "org-1", name: "acme", displayName: "Acme", role: "admin" }]);
  authMock.value.logout.mockClear();
  authMock.value.selectOrganization.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Layout", () => {
  it("renders wide chrome, opens the command palette by button and keyboard, and handles hover styling", async () => {
    const { container, root } = await renderLayout("/context");

    expect(container.textContent).toContain("First Tree");
    expect(container.textContent).toContain("Workspace");
    expect(container.textContent).toContain("Context child");
    expect(container.textContent).toContain("Jump to");

    const jump = container.querySelector<HTMLButtonElement>('button[aria-label="Open command palette"]');
    if (!jump) throw new Error("Jump button missing");
    await act(async () => {
      jump.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      jump.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    });
    await click(jump);
    expect(container.textContent).toContain("Mock command palette");
    await click(buttonByText(container, "Close palette"));

    await keyDown("k", { metaKey: true });
    expect(container.textContent).toContain("Mock command palette");
    await keyDown("k", { ctrlKey: true });
    expect(container.textContent).not.toContain("Mock command palette");

    await act(async () => root.unmount());
  });

  it("collapses brand and theme controls on narrow viewports and uses settings-owned layout", async () => {
    installMatchMedia(() => false);
    const { container, root } = await renderLayout("/settings");

    expect(container.textContent).not.toContain("First Tree");
    expect(container.textContent).not.toContain("Jump to");
    expect(container.textContent).toContain("Settings child");
    expect(container.querySelector('[data-testid="user-menu"]')).not.toBeNull();

    const xlController = mediaControllers.find((controller) => controller.query.includes("80rem"));
    const mdController = mediaControllers.find((controller) => controller.query.includes("48rem"));
    await act(async () => {
      mdController?.setMatches(true);
      xlController?.setMatches(false);
    });
    await flush();
    expect(container.textContent).toContain("First Tree");
    expect(container.textContent).not.toContain("Jump to");

    await act(async () => root.unmount());
  });
});
