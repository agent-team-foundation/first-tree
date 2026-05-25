import { describe, expect, it, vi } from "vitest";

/**
 * Mirror of the result-sink dead-link guard for the `chat send` path: when
 * snapshot validation throws, `captureOutboundDocs` must return the ORIGINAL
 * content and no documentContext (its catch already does this — pinned here so
 * a future refactor can't regress it into shipping rewritten links without
 * snapshots).
 *
 * Force the failure by mocking the snapshot builder to return a doc that fails
 * the shared schema (`sha256` not 64 hex).
 */
vi.mock("@first-tree/client", () => ({
  buildMessageDocumentSnapshots: vi.fn(async () => ({
    docs: [{ path: "design.md", sha256: "not-64-hex", size: 1, content: "x" }],
    skipped: 0,
    rewrittenText: "see [design.md](design.md) please",
  })),
}));

import { captureOutboundDocs } from "../core/doc-capture.js";

describe("captureOutboundDocs — failure preserves the original body", () => {
  it("returns the original content and no documentContext when validation throws", async () => {
    const out = await captureOutboundDocs("see design.md please", { FIRST_TREE_DOC_BASE: "/ws/coder/chat-1" });
    expect(out.content).toBe("see design.md please");
    expect(out.documentContext).toBeUndefined();
  });
});
