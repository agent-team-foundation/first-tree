import { describe, expect, it, vi } from "vitest";

/**
 * Regression for the codex review finding: when snapshot validation throws,
 * result-sink must send the ORIGINAL body — never the rewritten explicit-link
 * text — so it can't ship `[display](key)` links with no matching snapshot
 * (dead links). Keeps the "rewritten ⇔ snapshotted" invariant atomic.
 *
 * We force the failure by mocking the snapshot builder to return a doc that
 * fails the shared schema (`sha256` not 64 hex), which makes
 * `documentContextSchema.parse` throw inside result-sink.
 */
vi.mock("../runtime/doc-snapshots.js", () => ({
  buildMessageDocumentSnapshots: vi.fn(async () => ({
    docs: [{ path: "design.md", sha256: "not-64-hex", size: 1, content: "x" }],
    skipped: 0,
    rewrittenText: "see [design.md](design.md) please",
  })),
}));

import { createResultSink } from "../runtime/result-sink.js";
import type { FirstTreeHubSDK } from "../sdk.js";

describe("createResultSink — capture/parse failure preserves the original body", () => {
  it("sends the ORIGINAL text and no documentContext when snapshot validation throws", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sdk = { serverUrl: "http://test", sendMessage } as unknown as FirstTreeHubSDK;
    const sink = createResultSink({
      sdk,
      agent: {
        agentId: "me",
        inboxId: "inbox",
        displayName: "me",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-1",
      getTrigger: () => null,
      clearTrigger: () => {},
      log: () => {},
      getDocumentBasePath: vi.fn().mockResolvedValue("/ws/coder/chat-1"),
      workspacesRoot: "/ws",
      selfSlug: "coder",
    });

    await sink("see design.md please");

    const [, body] = sendMessage.mock.calls[0] ?? [];
    const sent = body as { content?: string; metadata?: { documentContext?: unknown } };
    // Body restored to the original — NOT the rewritten explicit-link form.
    expect(sent.content).toBe("see design.md please");
    expect(sent.metadata?.documentContext).toBeUndefined();
  });
});
