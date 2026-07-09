// @vitest-environment happy-dom

import type { DocComment, DocSummary, DocWithVersion } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createRef, type ReactElement } from "react";
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

import { DocCommentSidebar } from "../docs/doc-comment-sidebar.js";
import { DocPage } from "../docs/doc-page.js";
import { DocsListPage } from "../docs/docs-list-page.js";

const AUTHOR = { kind: "agent" as const, id: "agent-1", name: "liuchao-fable" };
const HUMAN = { kind: "human" as const, id: "human-1", name: "liuchao-001" };

function summary(overrides: Partial<DocSummary> = {}): DocSummary {
  return {
    id: "doc-1",
    slug: "docs-review-plan",
    title: "Docs Review Plan",
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

function docWithVersion(versionNumber = 2, overrides: Partial<DocWithVersion> = {}): DocWithVersion {
  return {
    ...summary(),
    version: {
      number: versionNumber,
      content:
        versionNumber === 1
          ? "# Docs Review Plan\n\nThe original quote needs review."
          : "# Docs Review Plan\n\nThe latest quote needs review.",
      note: versionNumber === 1 ? "original draft" : "latest pass",
      author: AUTHOR,
      createdAt: "2026-07-04T12:00:00.000Z",
    },
    ...overrides,
  };
}

function comment(overrides: Partial<DocComment> = {}): DocComment {
  return {
    id: "c-1",
    documentId: "doc-1",
    versionNumber: 2,
    parentId: null,
    author: HUMAN,
    body: "Please tighten this section.",
    anchor: { exact: "quote needs review" },
    status: "open",
    createdAt: "2026-07-04T12:30:00.000Z",
    updatedAt: "2026-07-04T12:30:00.000Z",
    ...overrides,
  };
}

function withProviders(ui: ReactElement, initialPath = "/context/docs"): ReactElement {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>
  );
}

async function waitForSettled(h: DomHarness, assertion: () => void): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 50; i++) {
    try {
      assertion();
      return;
    } catch (err) {
      lastErr = err;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await h.flush();
  }
  throw lastErr;
}

async function click(h: DomHarness, element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await h.flush();
}

async function setInputValue(h: DomHarness, element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await h.flush();
}

async function setTextareaValue(h: DomHarness, element: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await h.flush();
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}

function optionByText(text: string): HTMLButtonElement | null {
  return (
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}

function submitCommentButton(root: ParentNode): HTMLButtonElement | null {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button"));
  for (let index = buttons.length - 1; index >= 0; index--) {
    const button = buttons[index];
    if (button?.textContent?.trim() === "Comment") return button;
  }
  return null;
}

function mockDocSelection(
  root: ParentNode,
  selectedText: string,
): {
  paragraph: HTMLParagraphElement;
  removeAllRanges: ReturnType<typeof vi.fn>;
  restore: () => void;
} {
  const paragraph = Array.from(root.querySelectorAll<HTMLParagraphElement>("p")).find((item) =>
    item.textContent?.includes("latest quote"),
  );
  if (!paragraph?.firstChild) throw new Error("Expected rendered document paragraph");

  const cloneTexts = ["# Docs Review Plan\n\nThe ", " needs review."];
  const range = {
    startContainer: paragraph.firstChild,
    endContainer: paragraph.firstChild,
    startOffset: 4,
    endOffset: 16,
    cloneRange: () => ({
      setStart: vi.fn(),
      setEnd: vi.fn(),
      toString: () => cloneTexts.shift() ?? "",
    }),
    getBoundingClientRect: () => ({
      bottom: 16,
      height: 16,
      left: 12,
      right: 96,
      top: 0,
      width: 84,
      x: 12,
      y: 0,
      toJSON: () => ({}),
    }),
  };
  const removeAllRanges = vi.fn();
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges,
    toString: () => selectedText,
  };
  const spy = vi.spyOn(window, "getSelection").mockReturnValue(selection as unknown as Selection);
  return { paragraph, removeAllRanges, restore: () => spy.mockRestore() };
}

describe("DocsListPage extra DOM coverage", () => {
  let h: DomHarness;

  beforeEach(() => {
    h = createDomHarness();
    vi.clearAllMocks();
    authMock.value = { organizationId: "org-1", docsEnabled: true, role: "member" };
  });

  afterEach(() => h.cleanup());

  it("redirects to Context without fetching when docs are disabled", async () => {
    authMock.value = { organizationId: "org-1", docsEnabled: false, role: "member" };

    h.render(
      withProviders(
        <Routes>
          <Route path="/context/docs" element={<DocsListPage />} />
          <Route path="/context" element={<div>Context target</div>} />
        </Routes>,
      ),
    );

    await waitForSettled(h, () => expect(h.container.textContent).toContain("Context target"));
    expect(docsApiMocks.listDocs).not.toHaveBeenCalled();
  });

  it("sends the selected status filter to the docs API", async () => {
    docsApiMocks.listDocs.mockResolvedValue({
      items: [summary({ id: "doc-approved", slug: "approved-plan", title: "Approved Plan", status: "approved" })],
      nextCursor: null,
    });

    h.render(withProviders(<DocsListPage />));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Approved Plan"));

    await click(h, h.container.querySelector('button[aria-label="Status filter"]'));
    await waitForSettled(h, () => expect(optionByText("Approved")).not.toBeNull());
    await click(h, optionByText("Approved"));

    await waitForSettled(h, () =>
      expect(docsApiMocks.listDocs).toHaveBeenCalledWith({ status: "approved", limit: 200 }),
    );
  });

  it("shows the client-side no-match state after filtering loaded documents", async () => {
    docsApiMocks.listDocs.mockResolvedValue({
      items: [summary({ title: "Visible Plan", slug: "visible-plan" })],
      nextCursor: null,
    });

    h.render(withProviders(<DocsListPage />));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Visible Plan"));

    const input = h.container.querySelector<HTMLInputElement>('input[aria-label="Filter documents"]');
    expect(input).not.toBeNull();
    if (!input) return;
    await setInputValue(h, input, "missing");

    await waitForSettled(h, () => {
      expect(h.container.textContent).toContain("No documents match the filter.");
      expect(h.container.textContent).not.toContain("Visible Plan");
    });
  });

  it("surfaces list API errors", async () => {
    docsApiMocks.listDocs.mockRejectedValue(new Error("docs service unavailable"));

    h.render(withProviders(<DocsListPage />));

    await waitForSettled(h, () => expect(h.container.textContent).toContain("docs service unavailable"));
  });
});

describe("DocPage extra DOM coverage", () => {
  let h: DomHarness;

  beforeEach(() => {
    h = createDomHarness();
    vi.clearAllMocks();
    authMock.value = { organizationId: "org-1", docsEnabled: true, role: "member" };
    docsApiMocks.findDocBySlug.mockResolvedValue(summary());
    docsApiMocks.getDoc.mockImplementation((_docId: string, version?: number) =>
      Promise.resolve(docWithVersion(version ?? 2)),
    );
    docsApiMocks.listDocComments.mockResolvedValue({ items: [] });
  });

  afterEach(() => h.cleanup());

  function renderDocPage(): void {
    h.render(
      withProviders(
        <Routes>
          <Route path="/context/docs/:slug" element={<DocPage />} />
          <Route path="/context" element={<div>Context target</div>} />
        </Routes>,
        "/context/docs/docs-review-plan",
      ),
    );
  }

  it("redirects to Context without fetching when docs are disabled", async () => {
    authMock.value = { organizationId: "org-1", docsEnabled: false, role: "member" };

    renderDocPage();

    await waitForSettled(h, () => expect(h.container.textContent).toContain("Context target"));
    expect(docsApiMocks.findDocBySlug).not.toHaveBeenCalled();
  });

  it("loads an older version and shows the old-version note", async () => {
    renderDocPage();
    await waitForSettled(h, () => expect(h.container.textContent).toContain("The latest quote needs review."));

    await click(h, h.container.querySelector('button[aria-label="Version"]'));
    await waitForSettled(h, () => expect(optionByText("v1")).not.toBeNull());
    await click(h, optionByText("v1"));

    await waitForSettled(h, () => {
      expect(docsApiMocks.getDoc).toHaveBeenCalledWith("doc-1", 1);
      expect(h.container.textContent).toContain("Viewing v1");
      expect(h.container.textContent).toContain("Note: original draft");
      expect(h.container.textContent).toContain("The original quote needs review.");
    });
  });

  it("creates an anchored comment from selected document text", async () => {
    docsApiMocks.createDocComment.mockResolvedValue(comment({ body: "Please clarify this." }));
    renderDocPage();
    await waitForSettled(h, () => expect(h.container.textContent).toContain("The latest quote needs review."));
    const selection = mockDocSelection(h.container, "latest quote");

    await act(async () => {
      selection.paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });
    await h.flush();
    await click(h, submitCommentButton(h.container));
    const textarea = h.container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    if (!textarea) return;

    await setTextareaValue(h, textarea, "  Please clarify this.  ");
    await click(h, submitCommentButton(h.container));

    await waitForSettled(h, () => expect(docsApiMocks.createDocComment).toHaveBeenCalledTimes(1));
    expect(docsApiMocks.createDocComment).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({
        body: "Please clarify this.",
        versionNumber: 2,
        anchor: expect.objectContaining({ exact: "latest quote" }),
      }),
    );
    await waitForSettled(h, () => expect(h.container.querySelector("textarea")).toBeNull());
    expect(selection.removeAllRanges).toHaveBeenCalled();
    selection.restore();
  });

  it("falls back to document-level comments when the selection cannot be anchored", async () => {
    docsApiMocks.createDocComment.mockResolvedValue(comment({ body: "Fallback note." }));
    renderDocPage();
    await waitForSettled(h, () => expect(h.container.textContent).toContain("The latest quote needs review."));
    const selection = mockDocSelection(h.container, "rendered only");

    await act(async () => {
      selection.paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });
    await h.flush();
    await click(h, submitCommentButton(h.container));
    await waitForSettled(h, () => {
      expect(h.container.textContent).toContain("This selection spans formatting");
    });
    const textarea = h.container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    if (!textarea) return;

    await setTextareaValue(h, textarea, "Fallback note.");
    await click(h, submitCommentButton(h.container));

    await waitForSettled(h, () => expect(docsApiMocks.createDocComment).toHaveBeenCalledTimes(1));
    expect(docsApiMocks.createDocComment).toHaveBeenCalledWith("doc-1", {
      body: "> rendered only\n\nFallback note.",
      versionNumber: 2,
    });
    expect(selection.removeAllRanges).toHaveBeenCalled();
    selection.restore();
  });

  it("cancels an open selection composer without posting a comment", async () => {
    renderDocPage();
    await waitForSettled(h, () => expect(h.container.textContent).toContain("The latest quote needs review."));
    const selection = mockDocSelection(h.container, "latest quote");

    await act(async () => {
      selection.paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });
    await h.flush();
    await click(h, submitCommentButton(h.container));
    const textarea = h.container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    if (!textarea) return;
    await setTextareaValue(h, textarea, "Never posted");

    await click(h, buttonByText(h.container, "Cancel"));

    expect(h.container.querySelector("textarea")).toBeNull();
    expect(docsApiMocks.createDocComment).not.toHaveBeenCalled();
    selection.restore();
  });
});

describe("DocCommentSidebar extra DOM coverage", () => {
  let h: DomHarness;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView;

  beforeEach(() => {
    h = createDomHarness();
    vi.clearAllMocks();
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    h.cleanup();
  });

  function renderSidebar(comments: DocComment[], contentText = "The quote needs review in this paragraph.") {
    const content = document.createElement("div");
    content.innerHTML = `<p>${contentText}</p>`;
    document.body.appendChild(content);
    const ref = createRef<HTMLDivElement>();
    ref.current = content;
    const onChanged = vi.fn();

    h.render(
      withProviders(
        <DocCommentSidebar comments={comments} currentVersion={2} contentRef={ref} onChanged={onChanged} />,
      ),
    );

    return { onChanged };
  }

  it("keeps resolved threads hidden until toggled, locates their quote, and reopens them", async () => {
    docsApiMocks.setDocCommentStatus.mockResolvedValue(comment({ status: "open" }));
    renderSidebar([comment({ status: "resolved" })]);

    expect(h.container.textContent).toContain("No open comments");
    expect(h.container.textContent).not.toContain("Please tighten this section.");

    await click(h, buttonByText(h.container, "Show 1 resolved"));
    expect(h.container.textContent).toContain("Please tighten this section.");

    await click(h, h.container.querySelector('button[title="Locate in document"]'));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });

    await click(h, h.container.querySelector('button[aria-label="Reopen thread"]'));
    await waitForSettled(h, () => expect(docsApiMocks.setDocCommentStatus).toHaveBeenCalledWith("c-1", "open"));
  });

  it("trims replies, disables blank submits, and notifies after a successful reply", async () => {
    const { onChanged } = renderSidebar([comment()]);
    docsApiMocks.replyDocComment.mockResolvedValue(comment({ id: "reply-1", parentId: "c-1", body: "Looks good" }));

    await click(h, buttonByText(h.container, "Reply"));
    const textarea = h.container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    if (!textarea) return;

    let submit = buttonByText(h.container, "Reply");
    expect(submit?.disabled).toBe(true);

    await setTextareaValue(h, textarea, "  Looks good  ");
    submit = buttonByText(h.container, "Reply");
    expect(submit?.disabled).toBe(false);
    await click(h, submit);

    await waitForSettled(h, () => expect(docsApiMocks.replyDocComment).toHaveBeenCalledWith("c-1", "Looks good"));
    await waitForSettled(h, () => expect(onChanged).toHaveBeenCalled());
    expect(h.container.querySelector("textarea")).toBeNull();
  });
});
