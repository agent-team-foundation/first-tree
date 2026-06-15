// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docAttachmentRefQueryKey } from "../../pages/workspace/center/chat-view.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ATT_ID = "00000000-0000-4000-8000-000000000001";

const attachmentsMocks = vi.hoisted(() => ({
  fetchAttachmentText: vi.fn(),
  sha256Hex: vi.fn(),
  downloadAttachment: vi.fn(),
}));
const chatsMocks = vi.hoisted(() => ({
  listChatMessages: vi.fn(),
}));

vi.mock("../../api/attachments.js", () => attachmentsMocks);
vi.mock("../../api/chats.js", () => chatsMocks);

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

const docRef = {
  attachmentId: ATT_ID,
  kind: "document" as const,
  mimeType: "text/markdown",
  filename: "plan.md",
  size: 28,
  sha256: "a".repeat(64),
  source: { path: "docs/plan.md" },
};

beforeEach(() => {
  vi.resetModules();
  setupDom();
  document.body.innerHTML = "";
  latestSearch = "";
  root = null;
  container = null;
  attachmentsMocks.fetchAttachmentText.mockReset();
  attachmentsMocks.fetchAttachmentText.mockResolvedValue({
    text: "# Plan\nSee [details](details.md).",
    mimeType: "text/markdown",
    sizeBytes: 30,
  });
  attachmentsMocks.sha256Hex.mockReset();
  attachmentsMocks.sha256Hex.mockResolvedValue("a".repeat(64));
  chatsMocks.listChatMessages.mockReset();
  chatsMocks.listChatMessages.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

describe("DocPreviewDrawer", () => {
  it("fetches + renders the attachment from a seeded ref, closes, and resizes", async () => {
    const { DocPreviewDrawer } = await import("../doc-preview-drawer.js");
    const route = `/?docChat=chat-1&docMsg=msg-1&docAttachment=${ATT_ID}`;
    const dom = await renderAt(route, <DocPreviewDrawer />, (client) => {
      client.setQueryData(docAttachmentRefQueryKey(ATT_ID), docRef);
    });

    expect(attachmentsMocks.fetchAttachmentText).toHaveBeenCalledWith(ATT_ID);
    expect(dom.textContent).toContain("Plan");

    const resize = dom.querySelector<HTMLButtonElement>('button[aria-label="Resize document preview"]');
    await act(async () => {
      resize?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      resize?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(localStorage.getItem("first-tree:doc-preview-drawer:width:v1")).toBeTruthy();

    await click(dom.querySelector('button[aria-label="Close document preview"]'));
    expect(latestSearch).not.toContain("docAttachment=");
  });

  it("shows an integrity warning when the fetched bytes do not match ref.sha256", async () => {
    attachmentsMocks.sha256Hex.mockResolvedValue("b".repeat(64));
    const { DocPreviewDrawer } = await import("../doc-preview-drawer.js");
    const route = `/?docChat=chat-1&docMsg=msg-1&docAttachment=${ATT_ID}`;
    const dom = await renderAt(route, <DocPreviewDrawer />, (client) => {
      client.setQueryData(docAttachmentRefQueryKey(ATT_ID), docRef);
    });
    await flush();
    expect(dom.textContent).toContain("Integrity check failed");
  });

  it("shows a download fallback when the doc exceeds the preview render cap", async () => {
    attachmentsMocks.fetchAttachmentText.mockResolvedValue({
      text: "x",
      mimeType: "text/markdown",
      sizeBytes: 2 * 1024 * 1024,
    });
    const { DocPreviewDrawer } = await import("../doc-preview-drawer.js");
    const route = `/?docChat=chat-1&docMsg=msg-1&docAttachment=${ATT_ID}`;
    const dom = await renderAt(route, <DocPreviewDrawer />, (client) => {
      client.setQueryData(docAttachmentRefQueryKey(ATT_ID), docRef);
    });
    await flush();
    expect(dom.textContent).toContain("too large to preview");
    // The over-cap fallback is an authenticated download button (not a dead
    // page-relative `/api/v1/...` anchor that would 401/404). Clicking it routes
    // through the authed `downloadAttachment` helper.
    const downloadButton = [...dom.querySelectorAll("button")].find((b) => b.textContent === "Download to view");
    expect(downloadButton).toBeTruthy();
    await click(downloadButton ?? null);
    expect(attachmentsMocks.downloadAttachment).toHaveBeenCalledWith(ATT_ID, docRef.filename);
  });

  it("recovers the ref from the messages window after a cold reload", async () => {
    chatsMocks.listChatMessages.mockResolvedValue({
      items: [{ id: "msg-1", metadata: { attachments: [docRef] } }],
      nextCursor: null,
    });
    const { DocPreviewDrawer } = await import("../doc-preview-drawer.js");
    const route = `/?docChat=chat-1&docMsg=msg-1&docAttachment=${ATT_ID}`;
    const dom = await renderAt(route, <DocPreviewDrawer />);
    await flush();

    expect(chatsMocks.listChatMessages).toHaveBeenCalledWith("chat-1", { limit: 50 });
    expect(attachmentsMocks.fetchAttachmentText).toHaveBeenCalledWith(ATT_ID);
    expect(dom.textContent).toContain("Plan");
  });

  it("renders a fetch error inline rather than throwing", async () => {
    attachmentsMocks.fetchAttachmentText.mockRejectedValueOnce(new Error("Unable to load"));
    const { DocPreviewDrawer } = await import("../doc-preview-drawer.js");
    const route = `/?docChat=chat-1&docMsg=msg-1&docAttachment=${ATT_ID}`;
    const dom = await renderAt(route, <DocPreviewDrawer />, (client) => {
      client.setQueryData(docAttachmentRefQueryKey(ATT_ID), docRef);
    });
    await flush();
    expect(dom.textContent).toContain("Unable to load");
  });

  it("uses mobile focus handling and escape close", async () => {
    setupDom(true);
    const previous = document.createElement("button");
    previous.textContent = "previous";
    document.body.appendChild(previous);
    previous.focus();
    const { DocPreviewDrawer } = await import("../doc-preview-drawer.js");
    const dom = await renderAt(
      `/?docChat=chat-1&docMsg=msg-1&docAttachment=${ATT_ID}`,
      <DocPreviewDrawer />,
      (client) => {
        client.setQueryData(docAttachmentRefQueryKey(ATT_ID), docRef);
      },
    );
    await flush();

    expect(dom.querySelector('[aria-modal="true"]')).toBeTruthy();
    await act(async () => {
      dom.querySelector("aside")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(latestSearch).not.toContain("docAttachment=");
  });
});
