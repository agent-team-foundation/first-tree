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
    switchingOrg: null,
    setSwitchingOrg: vi.fn(),
    logout: vi.fn(),
    selectOrganization: vi.fn(),
  },
}));

const disconnectMock = vi.hoisted(() => ({
  value: {
    rows: [] as Array<{ clientId: string }>,
    firstHostname: null as string | null,
  },
}));

const versionMock = vi.hoisted(() => ({
  value: false,
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

vi.mock("../../hooks/use-version-check.js", () => ({
  useNewVersionAvailable: () => versionMock.value,
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
              <Route path="quickstart" element={<div>Quickstart child</div>} />
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
  disconnectMock.value = { rows: [], firstHostname: null };
  versionMock.value = false;
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
    expect(container.textContent).not.toContain("Jump to…");
    // Team anchor sits in the brand cluster at wide widths.
    expect(container.querySelector('[data-testid="team-switcher"]')).not.toBeNull();

    const jump = container.querySelector<HTMLButtonElement>('button[aria-label="Jump to… (⌘K)"]');
    if (!jump) throw new Error("Jump button missing");
    expect(jump.getAttribute("aria-keyshortcuts")).toBe("Meta+K Control+K");
    expect(jump.getAttribute("title")).toBe("Jump to… (⌘K / Ctrl+K)");
    expect(jump.textContent).toContain("Search");
    expect(jump.textContent).toContain("⌘K");
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

  it("renders /quickstart in the full-bleed workspace outlet, not the 960 admin canvas", async () => {
    // The landing-campaign trial renders the real WorkspaceBody at /quickstart;
    // it needs the same bare, full-height outlet as `/` so its three-pane
    // `flex flex-1` shell fills the viewport — NOT the centered 960 canvas the
    // admin routes (Context / Team / Agent Detail) use.
    const quickstart = await renderLayout("/quickstart");
    expect(quickstart.container.textContent).toContain("Quickstart child");
    expect(quickstart.container.querySelector('[style*="960"]')).toBeNull();
    await act(async () => quickstart.root.unmount());

    // Control: an admin route DOES get wrapped in the 960 content canvas.
    const context = await renderLayout("/context");
    expect(context.container.querySelector('[style*="960"]')).not.toBeNull();
    await act(async () => context.root.unmount());
  });

  it("renders trial chrome on /quickstart: no nav tabs / switcher / palette, one conversion CTA", async () => {
    const trial = await renderLayout("/quickstart");
    // Escape hatches are gone: nav tabs, team switcher, and the ⌘K palette entry.
    expect(trial.container.textContent).not.toContain("Context");
    expect(trial.container.textContent).not.toContain("Settings");
    expect(trial.container.textContent).not.toContain("Workspace");
    expect(trial.container.querySelector('[data-testid="team-switcher"]')).toBeNull();
    expect(trial.container.querySelector('button[aria-label="Jump to… (⌘K)"]')).toBeNull();
    // The one intentional way out: a "Set up First Tree" CTA → /onboarding.
    expect(trial.container.textContent).toContain("Set up First Tree");
    const cta = [...trial.container.querySelectorAll("a")].find((a) => /Set up First Tree/.test(a.textContent ?? ""));
    expect(cta?.getAttribute("href")).toBe("/onboarding");
    // The trial child still renders (full-bleed outlet, no 960 canvas).
    expect(trial.container.textContent).toContain("Quickstart child");
    await act(async () => trial.root.unmount());

    // Control: an ordinary route keeps the full chrome and shows no CTA.
    const context = await renderLayout("/context");
    expect(context.container.textContent).toContain("Context");
    expect(context.container.querySelector('[data-testid="team-switcher"]')).not.toBeNull();
    expect(context.container.querySelector('button[aria-label="Jump to… (⌘K)"]')).not.toBeNull();
    expect(context.container.textContent).not.toContain("Set up First Tree");
    await act(async () => context.root.unmount());
  });

  it("keeps status chips in the right controls before the compact command palette entry", async () => {
    disconnectMock.value = {
      firstHostname: "Yue-MacPro.local",
      rows: [{ clientId: "client-1" }],
    };
    versionMock.value = true;
    const { container, root } = await renderLayout("/context");

    const commandButton = container.querySelector<HTMLButtonElement>('button[aria-label="Jump to… (⌘K)"]');
    if (!commandButton?.parentElement) throw new Error("Command palette button missing");

    const controlsText = commandButton.parentElement.textContent ?? "";
    expect(controlsText).toContain("Computer disconnected");
    expect(controlsText).toContain("Update available");
    expect(controlsText).not.toContain("Yue-MacPro");
    expect(controlsText).not.toContain("Jump to…");
    expect(controlsText.indexOf("Computer disconnected")).toBeLessThan(controlsText.indexOf("⌘K"));
    expect(controlsText.indexOf("Update available")).toBeLessThan(controlsText.indexOf("⌘K"));

    await act(async () => root.unmount());
  });

  it("collapses brand and theme controls on narrow viewports and uses settings-owned layout", async () => {
    installMatchMedia(() => false);
    const { container, root } = await renderLayout("/settings");

    expect(container.textContent).not.toContain("First Tree");
    expect(container.textContent).not.toContain("Jump to");
    expect(container.textContent).toContain("Settings child");
    expect(container.querySelector('[data-testid="user-menu"]')).not.toBeNull();
    // The brand drops on narrow, but the team anchor must NOT — it stays
    // reachable in its own leading column (§7).
    expect(container.querySelector('[data-testid="team-switcher"]')).not.toBeNull();

    const xlController = mediaControllers.find((controller) => controller.query.includes("80rem"));
    const mdController = mediaControllers.find((controller) => controller.query.includes("48rem"));
    await act(async () => {
      mdController?.setMatches(true);
      xlController?.setMatches(false);
    });
    await flush();
    expect(container.textContent).toContain("First Tree");
    expect(container.querySelector('button[aria-label="Jump to… (⌘K)"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Search");

    await act(async () => root.unmount());
  });

  it("uses compact status controls at md so text chips do not crowd the centered nav", async () => {
    installMatchMedia((query) => query.includes("48rem"));
    disconnectMock.value = {
      firstHostname: "Yue-MacPro.local",
      rows: [{ clientId: "client-1" }],
    };
    versionMock.value = true;
    const { container, root } = await renderLayout("/context");

    expect(container.textContent).toContain("First Tree");
    expect(container.textContent).not.toContain("Computer disconnected");
    expect(container.textContent).not.toContain("Update available");
    expect(
      container.querySelector('button[aria-label="Yue-MacPro.local is disconnected. Click to manage."]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="A new version is available. Click to refresh."]'),
    ).not.toBeNull();
    expect(container.querySelector('button[aria-label="Jump to… (⌘K)"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Search");

    await act(async () => root.unmount());
  });

  it("keeps compact status affordances on narrow viewports without showing full chip copy", async () => {
    installMatchMedia(() => false);
    disconnectMock.value = {
      firstHostname: "Yue-MacPro.local",
      rows: [{ clientId: "client-1" }],
    };
    versionMock.value = true;
    const { container, root } = await renderLayout("/context");

    expect(container.textContent).not.toContain("First Tree");
    expect(container.textContent).not.toContain("Computer disconnected");
    expect(container.textContent).not.toContain("Update available");
    expect(
      container.querySelector('button[aria-label="Yue-MacPro.local is disconnected. Click to manage."]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="A new version is available. Click to refresh."]'),
    ).not.toBeNull();
    expect(container.querySelector('button[aria-label="Jump to… (⌘K)"]')).toBeNull();
    expect(container.querySelector('[data-testid="user-menu"]')).not.toBeNull();

    await act(async () => root.unmount());
  });
});
