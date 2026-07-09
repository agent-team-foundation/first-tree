// @vitest-environment happy-dom

import type { DocComment, DocSummary, DocWithVersion } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../test-utils/dom-harness.js";

const docsApiMocks = vi.hoisted(() => ({
  listDocs: vi.fn(),
  findDocBySlug: vi.fn(),
  getDoc: vi.fn(),
  setDocStatus: vi.fn(),
  listDocComments: vi.fn(),
  createDocComment: vi.fn(),
  replyDocComment: vi.fn(),
  setDocCommentStatus: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1" as string | null,
    docsEnabled: true,
    role: "member" as "admin" | "member" | null,
  },
}));

vi.mock("../../api/docs.js", () => docsApiMocks);
vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

import { DocPage } from "../docs/doc-page.js";
import { DocsListPage } from "../docs/docs-list-page.js";

const AUTHOR = { kind: "agent" as const, id: "agent-1", name: "liuchao-fable" };

function summary(overrides: Partial<DocSummary> = {}): DocSummary {
  return {
    id: "doc-1",
    slug: "chat-rename",
    title: "Chat Rename Plan",
    project: "first-tree",
    status: "in_review",
    latestVersion: 2,
    openCommentCount: 1,
    createdBy: AUTHOR,
    createdAt: "2026-07-04T10:00:00.000Z",
    updatedAt: "2026-07-04T12:00:00.000Z",
    ...overrides,
  };
}

function docWithVersion(): DocWithVersion {
  return {
    ...summary(),
    version: {
      number: 2,
      content: "# Chat Rename Plan\n\nWe rename chats by slug.",
      note: "round 2",
      author: AUTHOR,
      createdAt: "2026-07-04T12:00:00.000Z",
    },
  };
}

function comment(overrides: Partial<DocComment> = {}): DocComment {
  return {
    id: "c-1",
    documentId: "doc-1",
    versionNumber: 2,
    parentId: null,
    author: { kind: "human", id: "human-1", name: "liuchao-001" },
    body: "why rename by slug?",
    anchor: { exact: "rename chats" },
    status: "open",
    createdAt: "2026-07-04T12:30:00.000Z",
    updatedAt: "2026-07-04T12:30:00.000Z",
    ...overrides,
  };
}

function withProviders(ui: ReactElement, initialPath = "/context/docs"): ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>
  );
}

/**
 * Macrotask-aware waitFor: TanStack Query may schedule resolution across a
 * timer tick, which the harness's microtask-only flush never reaches — so
 * interleave real timeouts with flushes before asserting.
 */
async function waitForSettled(h: DomHarness, assertion: () => void): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      assertion();
      return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    await h.flush();
  }
  throw lastErr;
}

describe("DocsListPage", () => {
  let h: DomHarness;
  beforeEach(() => {
    h = createDomHarness();
    vi.clearAllMocks();
  });
  afterEach(() => h.cleanup());

  it("renders documents with status, version, and open-comment count", async () => {
    docsApiMocks.listDocs.mockResolvedValue({
      items: [summary(), summary({ id: "doc-2", slug: "other-doc", title: "Other Doc", status: "draft" })],
      nextCursor: null,
    });

    h.render(withProviders(<DocsListPage />));
    await waitForSettled(h, () => {
      expect(h.container.textContent).toContain("Chat Rename Plan");
      expect(h.container.textContent).toContain("Other Doc");
    });
    expect(h.container.textContent).toContain("In review");
    expect(h.container.textContent).toContain("v2");
    expect(h.container.textContent).toContain("liuchao-fable");
  });

  it("filters client-side via the search box", async () => {
    docsApiMocks.listDocs.mockResolvedValue({
      items: [summary(), summary({ id: "doc-2", slug: "other-doc", title: "Other Doc" })],
      nextCursor: null,
    });

    h.render(withProviders(<DocsListPage />));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Other Doc"));

    const input = h.container.querySelector<HTMLInputElement>("input[aria-label='Filter documents']");
    expect(input).not.toBeNull();
    if (!input) return;
    // React overrides the value setter on controlled inputs — go through the
    // native prototype setter so the dispatched event carries the new value.
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, "rename");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForSettled(h, () => {
      expect(h.container.textContent).toContain("Chat Rename Plan");
      expect(h.container.textContent).not.toContain("Other Doc");
    });
  });

  it("shows the empty-library hint", async () => {
    docsApiMocks.listDocs.mockResolvedValue({ items: [], nextCursor: null });
    h.render(withProviders(<DocsListPage />));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("No documents yet"));
  });
});

describe("DocPage", () => {
  let h: DomHarness;
  beforeEach(() => {
    h = createDomHarness();
    vi.clearAllMocks();
    docsApiMocks.findDocBySlug.mockResolvedValue(summary());
    docsApiMocks.getDoc.mockResolvedValue(docWithVersion());
    docsApiMocks.listDocComments.mockResolvedValue({
      items: [
        comment({ versionNumber: 1, outdated: true }),
        comment({ id: "c-2", parentId: "c-1", body: "audit trail reasons", anchor: null, versionNumber: 1 }),
      ],
    });
  });
  afterEach(() => h.cleanup());

  function renderDocPage(): void {
    h.render(
      withProviders(
        <Routes>
          <Route path="/context/docs/:slug" element={<DocPage />} />
        </Routes>,
        "/context/docs/chat-rename",
      ),
    );
  }

  it("renders the document content, metadata, and comment threads", async () => {
    renderDocPage();
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Chat Rename Plan"));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("We rename chats by slug.")); // markdown body
    expect(h.container.textContent).toContain("In review");
    expect(h.container.textContent).toContain("why rename by slug?");
    expect(h.container.textContent).toContain("audit trail reasons"); // threaded reply
    expect(h.container.textContent).toContain("1 open");
    // Cross-version comment shows its origin version and the outdated marker
    // (the anchor no longer locates in the latest version).
    expect(h.container.textContent).toContain("on v1");
    expect(h.container.textContent).toContain("outdated");
    // Approve shortcut shows while in review.
    const buttons = Array.from(h.container.querySelectorAll("button"));
    expect(buttons.some((b) => b.textContent?.includes("Approve"))).toBe(true);
  });

  it("resolves a thread from the sidebar", async () => {
    docsApiMocks.setDocCommentStatus.mockResolvedValue(comment({ status: "resolved" }));
    renderDocPage();
    await waitForSettled(h, () => expect(h.container.textContent).toContain("why rename by slug?"));

    const resolveButton = h.container.querySelector<HTMLButtonElement>("button[aria-label='Resolve thread']");
    expect(resolveButton).not.toBeNull();
    resolveButton?.click();
    await waitForSettled(h, () => expect(docsApiMocks.setDocCommentStatus).toHaveBeenCalledWith("c-1", "resolved"));
  });

  it("approves an in-review document from the header", async () => {
    docsApiMocks.setDocStatus.mockResolvedValue(summary({ status: "approved" }));
    renderDocPage();
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Chat Rename Plan"));

    const approve = Array.from(h.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Approve"));
    expect(approve).toBeDefined();
    approve?.click();
    await waitForSettled(h, () => expect(docsApiMocks.setDocStatus).toHaveBeenCalledWith("doc-1", "approved"));
  });

  it("shows a helpful miss state for an unknown slug", async () => {
    docsApiMocks.findDocBySlug.mockResolvedValue(null);
    renderDocPage();
    await waitForSettled(h, () => expect(h.container.textContent).toContain('No document with slug "chat-rename"'));
  });

  it("redirects when docs feature is disabled", async () => {
    authMock.value.docsEnabled = false;
    renderDocPage();
    await waitForSettled(h, () => {
      // Navigate replaces the page; content should not show the doc title.
      expect(h.container.textContent ?? "").not.toContain("Chat Rename Plan");
    });
    authMock.value.docsEnabled = true;
  });

  it("captures a text selection and posts a comment through the composer", async () => {
    docsApiMocks.createDocComment.mockResolvedValue(comment({ id: "c-new", body: "needs a title" }));
    renderDocPage();
    await waitForSettled(h, () => expect(h.container.textContent).toContain("We rename chats by slug."));

    const wrap = h.container.querySelector<HTMLDivElement>("div[style*='position: relative']")
      ?? h.container.querySelector<HTMLDivElement>("div.flex > div");
    expect(wrap).not.toBeNull();
    if (!wrap) return;

    // Seed a real Range inside the markdown content so captureSelection can run.
    const textNode = Array.from(wrap.querySelectorAll("*"))
      .map((el) => el.firstChild)
      .find((n): n is Text => n?.nodeType === Node.TEXT_NODE && (n.textContent?.includes("rename") ?? false));
    if (textNode && textNode.textContent) {
      const range = document.createRange();
      const start = Math.max(0, textNode.textContent.indexOf("rename"));
      range.setStart(textNode, start);
      range.setEnd(textNode, Math.min(textNode.textContent.length, start + 6));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    wrap.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await waitForSettled(h, () => {
      const commentBtn = Array.from(h.container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Comment"),
      );
      expect(commentBtn).toBeDefined();
    });

    const openComposer = Array.from(h.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Comment"),
    );
    openComposer?.click();
    await waitForSettled(h, () => expect(h.container.querySelector("textarea")).not.toBeNull());

    const textarea = h.container.querySelector<HTMLTextAreaElement>("textarea");
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setValue?.call(textarea, "needs a title");
    textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    await h.flush();

    const submit = Array.from(h.container.querySelectorAll("button")).find(
      (b) => b.textContent === "Comment" && !(b as HTMLButtonElement).disabled,
    );
    submit?.click();
    await waitForSettled(h, () => expect(docsApiMocks.createDocComment).toHaveBeenCalled());
  });

  it("reopens a resolved thread, toggles resolved list, replies, and scrolls to quote", async () => {
    docsApiMocks.listDocComments.mockResolvedValue({
      items: [
        comment({ status: "resolved" }),
        comment({ id: "c-2", parentId: "c-1", body: "audit trail reasons", anchor: null, status: "resolved" }),
        comment({
          id: "c-3",
          body: "still open",
          status: "open",
          anchor: { exact: "rename chats" },
        }),
      ],
    });
    docsApiMocks.setDocCommentStatus.mockResolvedValue(comment({ status: "open" }));
    docsApiMocks.replyDocComment.mockResolvedValue(
      comment({ id: "c-4", parentId: "c-3", body: "thanks", anchor: null }),
    );

    renderDocPage();
    await waitForSettled(h, () => expect(h.container.textContent).toContain("still open"));

    const showResolved = Array.from(h.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("resolved"),
    );
    expect(showResolved).toBeDefined();
    showResolved?.click();
    await waitForSettled(h, () => expect(h.container.textContent).toContain("why rename by slug?"));

    const reopen = h.container.querySelector<HTMLButtonElement>("button[aria-label='Reopen thread']");
    expect(reopen).not.toBeNull();
    reopen?.click();
    await waitForSettled(h, () => expect(docsApiMocks.setDocCommentStatus).toHaveBeenCalledWith("c-1", "open"));

    const replyToggle = Array.from(h.container.querySelectorAll("button")).find((b) => b.textContent === "Reply");
    expect(replyToggle).toBeDefined();
    replyToggle?.click();
    await waitForSettled(h, () => expect(h.container.querySelector("textarea")).not.toBeNull());

    const textarea = h.container.querySelector<HTMLTextAreaElement>("textarea");
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setValue?.call(textarea, "thanks for the note");
    textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    await h.flush();

    const submit = Array.from(h.container.querySelectorAll("button")).find(
      (b) => b.textContent === "Reply" && !(b as HTMLButtonElement).disabled,
    );
    submit?.click();
    await waitForSettled(h, () =>
      expect(docsApiMocks.replyDocComment).toHaveBeenCalledWith("c-3", "thanks for the note"),
    );

    // Quote locator: click the anchor chip so scrollToQuote runs.
    const quote = Array.from(h.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("rename chats"),
    );
    quote?.click();
    await h.flush();
  });
});
