// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness } from "../../../../test-utils/dom-harness.js";
import {
  docAttachmentRefQueryKey,
  docMessageAttachmentRefsQueryKey,
  failedDocMentionsFromMetadata,
  failedDocReasonTooltip,
  formatClockTime,
  formatTokenCount,
  isInlineImageContent,
  loadHideAgentFinalText,
  loadSidebarOpen,
  ReadReceipt,
  saveHideAgentFinalText,
  saveSidebarOpen,
} from "../chat-view.js";

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

describe("chat-view exported helpers", () => {
  beforeEach(() => {
    const storage = createStorage();
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds stable query keys", () => {
    expect(docAttachmentRefQueryKey("att-1")).toEqual(["chat-doc-attachment-ref", "att-1"]);
    expect(docMessageAttachmentRefsQueryKey("msg-1")).toEqual(["chat-doc-message-attachment-refs", "msg-1"]);
  });

  it("parses snapshot failedMentions metadata into a map", () => {
    expect(failedDocMentionsFromMetadata(undefined)).toBeUndefined();
    expect(failedDocMentionsFromMetadata({})).toBeUndefined();
    expect(
      failedDocMentionsFromMetadata({
        documentContext: { kind: "live", basePath: "/x" },
      }),
    ).toBeUndefined();
    expect(
      failedDocMentionsFromMetadata({
        documentContext: {
          kind: "snapshot",
          failedMentions: [],
        },
      }),
    ).toBeUndefined();

    const map = failedDocMentionsFromMetadata({
      documentContext: {
        kind: "snapshot",
        failedMentions: [
          { raw: "docs/a.md", reason: "missing" },
          { raw: "docs/b.md", reason: "too-large" },
        ],
      },
    });
    expect(map?.get("docs/a.md")).toBe("missing");
    expect(map?.get("docs/b.md")).toBe("too-large");
    expect(map?.size).toBe(2);
  });

  it("maps every failed-doc reason to tooltip copy", () => {
    expect(failedDocReasonTooltip("missing")).toContain("不存在");
    expect(failedDocReasonTooltip("out-of-fence")).toContain("工作区");
    expect(failedDocReasonTooltip("hidden-segment")).toContain("受限");
    expect(failedDocReasonTooltip("too-large")).toContain("大小");
    expect(failedDocReasonTooltip("budget-exceeded")).toContain("过多");
    expect(failedDocReasonTooltip("unreadable")).toContain("读取");
  });

  it("formats token counts and clock times", () => {
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
    const clock = formatClockTime("2026-05-28T11:55:00.000Z");
    expect(clock).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}/);
  });

  it("detects inline image file content shapes", () => {
    expect(isInlineImageContent(null)).toBe(false);
    expect(isInlineImageContent("x")).toBe(false);
    expect(isInlineImageContent({ data: "abc", mimeType: "image/png" })).toBe(true);
    expect(isInlineImageContent({ data: "abc", mimeType: "application/pdf" })).toBe(false);
    expect(isInlineImageContent({ mimeType: "image/png" })).toBe(false);
  });

  it("persists sidebar and hide-final-text preferences", () => {
    expect(loadSidebarOpen()).toBeNull();
    saveSidebarOpen(true);
    expect(loadSidebarOpen()).toBe(true);
    saveSidebarOpen(false);
    expect(loadSidebarOpen()).toBe(false);

    expect(loadHideAgentFinalText()).toBe(false);
    saveHideAgentFinalText(true);
    expect(loadHideAgentFinalText()).toBe(true);
    saveHideAgentFinalText(false);
    expect(loadHideAgentFinalText()).toBe(false);
  });

  it("swallows localStorage failures", () => {
    const broken: Storage = {
      get length() {
        return 0;
      },
      clear: () => undefined,
      getItem: () => {
        throw new Error("blocked");
      },
      key: () => null,
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    Object.defineProperty(window, "localStorage", { configurable: true, value: broken });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: broken });
    expect(loadSidebarOpen()).toBeNull();
    expect(() => saveSidebarOpen(true)).not.toThrow();
    expect(loadHideAgentFinalText()).toBe(false);
    expect(() => saveHideAgentFinalText(true)).not.toThrow();
  });

  it("renders ReadReceipt for acked/delivered/sent and skips non-self messages", () => {
    const h = createDomHarness();
    const base = {
      id: "m1",
      chatId: "c1",
      senderId: "me",
      format: "text" as const,
      content: "hi",
      metadata: {},
      inReplyTo: null,
      source: "web" as const,
      createdAt: "2026-05-28T12:00:00.000Z",
    };
    h.render(
      <>
        <ReadReceipt msg={{ ...base, deliveryStatus: "acked" }} myAgentId="me" />
        <ReadReceipt msg={{ ...base, deliveryStatus: "delivered" }} myAgentId="me" />
        <ReadReceipt msg={{ ...base }} myAgentId="me" />
        <ReadReceipt msg={{ ...base, senderId: "other" }} myAgentId="me" />
        <ReadReceipt msg={{ ...base }} myAgentId={null} />
      </>,
    );
    expect(h.container.textContent).toContain("read");
    expect(h.container.textContent).toContain("sent");
    h.cleanup();
  });
});
