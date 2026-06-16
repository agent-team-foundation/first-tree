import type { FirstTreeHubSDK } from "@first-tree/client";
import { describe, expect, it, vi } from "vitest";

/**
 * Mirror of the result-sink dead-link guard for the `chat send` path: when doc
 * capture throws, `captureOutboundDocs` must return the ORIGINAL content and no
 * attachment metadata (its catch already does this — pinned here so a future
 * refactor can't regress it into shipping rewritten attachment links without
 * the matching refs).
 *
 * Force the failure by mocking the capture builder to throw.
 */
vi.mock("@first-tree/client", () => ({
  buildMessageDocumentSnapshots: vi.fn(async () => {
    throw new Error("capture exploded");
  }),
}));

import { captureOutboundDocs } from "../core/doc-capture.js";

const CHAT_ID = "11111111-1111-4111-8111-111111111111";

function stubSdk(): FirstTreeHubSDK {
  return {
    serverUrl: "http://test",
    async getChatDetail() {
      return { id: CHAT_ID, organizationId: "org-1", participants: [] };
    },
    async uploadAttachment() {
      return { id: "x", mimeType: "text/markdown", filename: "x.md", sizeBytes: 1 };
    },
  } as unknown as FirstTreeHubSDK;
}

describe("captureOutboundDocs — failure preserves the original body", () => {
  it("returns the original content and no attachment metadata when capture throws", async () => {
    const out = await captureOutboundDocs(
      "see design.md please",
      { sdk: stubSdk(), chatId: CHAT_ID },
      { FIRST_TREE_DOC_BASE: "/ws/coder/chat-1" },
    );
    expect(out.content).toBe("see design.md please");
    expect(out.attachments).toBeUndefined();
    expect(out.documentContext).toBeUndefined();
  });
});
