// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docAttachmentRefQueryKey, docMessageAttachmentRefsQueryKey } from "../../pages/workspace/center/chat-view.js";

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

const SIBLING_ID = "00000000-0000-4000-8000-000000000002";
// `details.md` relative to the current doc's `docs/plan.md` resolves to
// `docs/details.md` — the sibling's source.path.
const siblingRef = {
  attachmentId: SIBLING_ID,
  kind: "document" as const,
  mimeType: "text/markdown",
  filename: "details.md",
  size: 10,
  sha256: "c".repeat(64),
  source: { path: "docs/details.md" },
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

  // R4 follow-up (codex-assistant #2): a cold deep-link whose `docMsg` is OLDER
  // than the recovery window (message not returned by listChatMessages) misses
  // recovery. It must still fetch (capability-authed by attachmentId) and render,
  // flagged "unverified" — NOT sit at a silent blank drawer. Would render blank
  // before the fix (enabled gate stayed false forever on a recovery miss).
  it("fetches unverified instead of going blank when the ref can't be recovered", async () => {
    chatsMocks.listChatMessages.mockResolvedValue({ items: [], nextCursor: null });
    const { DocPreviewDrawer } = await import("../doc-preview-drawer.js");
    const route = `/?docChat=chat-1&docMsg=msg-out-of-window&docAttachment=${ATT_ID}`;
    const dom = await renderAt(route, <DocPreviewDrawer />);
    await flush();

    expect(chatsMocks.listChatMessages).toHaveBeenCalledWith("chat-1", { limit: 50 });
    expect(attachmentsMocks.fetchAttachmentText).toHaveBeenCalledWith(ATT_ID);
    expect(attachmentsMocks.sha256Hex).not.toHaveBeenCalled();
    expect(dom.textContent).toContain("Plan");
    expect(dom.textContent).toContain("This preview was not checksum verified");
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

  // R1: a relative in-doc link to a sibling doc in the SAME message resolves on
  // the seeded (normal click) path — the click handler seeds the full per-message
  // ref list, so the drawer maps `details.md` → the sibling attachment without
  // fetching the messages window. Would no-op before the fix (recovery is
  // disabled when a seeded ref exists, so the sibling map was empty).
  it("resolves a same-message sibling link on the seeded path (no recovery fetch)", async () => {
    const { DocPreviewDrawer } = await import("../doc-preview-drawer.js");
    const route = `/?docChat=chat-1&docMsg=msg-1&docAttachment=${ATT_ID}`;
    const dom = await renderAt(route, <DocPreviewDrawer />, (client) => {
      client.setQueryData(docAttachmentRefQueryKey(ATT_ID), docRef);
      client.setQueryData(docAttachmentRefQueryKey(SIBLING_ID), siblingRef);
      // Seed the FULL per-message ref list — the seeded enumeration path.
      client.setQueryData(docMessageAttachmentRefsQueryKey("msg-1"), [docRef, siblingRef]);
    });
    await flush();

    // Recovery is disabled on the seeded path — the messages window is never read.
    expect(chatsMocks.listChatMessages).not.toHaveBeenCalled();

    const siblingLink = [...dom.querySelectorAll("a")].find((a) => a.textContent === "details");
    expect(siblingLink).toBeTruthy();
    await click(siblingLink ?? null);
    expect(latestSearch).toContain(`docAttachment=${SIBLING_ID}`);
  });

  // R2: on a cold deep-link (no seeded ref) the fetch must WAIT for the ref to
  // be recovered, then verify the bytes against the recovered ref's sha256.
  // Here the recovered ref's sha256 mismatches the fetched bytes, so the
  // integrity warning can only appear if verification ran against the recovered
  // ref — proving the fetch did not race ahead of recovery. Would not warn
  // before the fix (fetch ran with an undefined ref → verification skipped, and
  // the attachmentId-only key never recomputed when the ref later resolved).
  it("verifies bytes against the recovered ref on a cold deep-link", async () => {
    chatsMocks.listChatMessages.mockResolvedValue({
      items: [{ id: "msg-1", metadata: { attachments: [docRef] } }],
      nextCursor: null,
    });
    // Fetched bytes hash to something other than docRef.sha256 ("aaaa...").
    attachmentsMocks.sha256Hex.mockResolvedValue("d".repeat(64));
    const { DocPreviewDrawer } = await import("../doc-preview-drawer.js");
    const route = `/?docChat=chat-1&docMsg=msg-1&docAttachment=${ATT_ID}`;
    const dom = await renderAt(route, <DocPreviewDrawer />);
    await flush();

    expect(chatsMocks.listChatMessages).toHaveBeenCalledWith("chat-1", { limit: 50 });
    // Verification ran against the recovered ref (the fetch waited for it).
    expect(attachmentsMocks.sha256Hex).toHaveBeenCalled();
    expect(dom.textContent).toContain("Integrity check failed");
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
