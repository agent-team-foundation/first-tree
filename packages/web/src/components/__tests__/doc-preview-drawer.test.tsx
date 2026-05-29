// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docSnapshotQueryKey } from "../../pages/workspace/center/chat-view.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const meDocsMocks = vi.hoisted(() => ({
  getMeDoc: vi.fn(),
}));

vi.mock("../../api/me-docs.js", () => meDocsMocks);
vi.mock("../../lib/use-agent-name-map.js", () => ({
  useAgentSlugToIdMap: () => (slug: string | null | undefined) => (slug === "kael" ? "agent-owner" : null),
}));

let root: Root | null = null;
let container: HTMLElement | null = null;
let queryClient: QueryClient;
let latestSearch = "";

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

function setupDom(mobile = false): void {
  const storage = createStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mobile ? 390 : 1400 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: mobile && query.includes("47.999rem"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

function LocationProbe() {
  const location = useLocation();
  latestSearch = location.search;
  return null;
}

async function renderAt(
  route: string,
  element: ReactElement,
  seed?: (client: QueryClient) => void,
): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  seed?.(queryClient);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[route]}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route
              path="/"
              element={
                <>
                  <LocationProbe />
                  {element}
                </>
              }
            />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error("missing clickable");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  vi.resetModules();
  setupDom();
  document.body.innerHTML = "";
  latestSearch = "";
  root = null;
  container = null;
  meDocsMocks.getMeDoc.mockReset();
  meDocsMocks.getMeDoc.mockResolvedValue({
    path: "docs/guide.md",
    content: "# Guide\nSee [next](next.md).",
    ref: { path: "docs/guide.md" },
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

describe("DocPreviewDrawer", () => {
  it("renders inline snapshots, follows markdown links, closes, and resizes", async () => {
    const { DocPreviewDrawer } = await import("../doc-preview-drawer.js");
    const route = "/?docChat=chat-1&docAgent=agent-1&docPath=docs%2Fplan.md&docMsg=msg-1";
    const dom = await renderAt(route, <DocPreviewDrawer />, (client) => {
      client.setQueryData(docSnapshotQueryKey("chat-1", "msg-1", "docs/plan.md"), {
        path: "docs/plan.md",
        content: "# Plan\nSee [details](details.md).",
        sha256: "sha",
        size: 28,
      });
    });

    expect(dom.textContent).toContain("Plan");
    expect(meDocsMocks.getMeDoc).not.toHaveBeenCalled();

    const resize = dom.querySelector<HTMLButtonElement>('button[aria-label="Resize document preview"]');
    await act(async () => {
      resize?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      resize?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(localStorage.getItem("first-tree:doc-preview-drawer:width:v1")).toBeTruthy();

    await click(dom.querySelector<HTMLAnchorElement>('a[href="details.md"]'));
    expect(latestSearch).toContain("docPath=docs%2Fdetails.md");

    await click(dom.querySelector('button[aria-label="Close document preview"]'));
    expect(latestSearch).not.toContain("docPath=");
  });

  it("loads fallback previews for cross-agent paths and renders API errors", async () => {
    const { DocPreviewDrawer } = await import("../doc-preview-drawer.js");
    const dom = await renderAt(
      "/?docChat=chat-1&docAgent=sender&docPath=kael%2Fchat-1%2Fdocs%2Fguide.md",
      <DocPreviewDrawer />,
    );

    await flush();
    expect(meDocsMocks.getMeDoc).toHaveBeenCalledWith("chat-1", {
      agentId: "agent-owner",
      basePath: undefined,
      path: "docs/guide.md",
    });
    expect(dom.textContent).toContain("Guide");

    await act(async () => root?.unmount());
    meDocsMocks.getMeDoc.mockRejectedValueOnce(new Error("Unable to load"));
    const errored = await renderAt("/?docChat=chat-1&docAgent=sender&docPath=docs%2Fmissing.md", <DocPreviewDrawer />);
    await flush();
    expect(errored.textContent).toContain("Unable to load");
  });

  it("uses mobile focus handling and escape close", async () => {
    setupDom(true);
    const previous = document.createElement("button");
    previous.textContent = "previous";
    document.body.appendChild(previous);
    previous.focus();
    const { DocPreviewDrawer } = await import("../doc-preview-drawer.js");
    const dom = await renderAt("/?docChat=chat-1&docAgent=agent-1&docPath=docs%2Fguide.md", <DocPreviewDrawer />);
    await flush();

    expect(dom.querySelector('[aria-modal="true"]')).toBeTruthy();
    await act(async () => {
      dom.querySelector("aside")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(latestSearch).not.toContain("docPath=");
  });
});
