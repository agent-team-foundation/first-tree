import { describe, expect, it, vi } from "vitest";

/**
 * When doc capture throws, result-sink must send the ORIGINAL body — never the
 * rewritten explicit-link text — and attach no attachment metadata, so it can't
 * ship `attachment:<id>` links with no matching ref (dead links). Keeps the
 * "rewritten ⇔ has-ref" invariant atomic.
 *
 * We force the failure by mocking the capture builder to throw.
 */
vi.mock("../runtime/doc-snapshots.js", () => ({
  buildMessageDocumentSnapshots: vi.fn(async () => {
    throw new Error("capture exploded");
  }),
}));

import { createResultSink } from "../runtime/result-sink.js";
import type { FirstTreeHubSDK } from "../sdk.js";

describe("createResultSink — capture failure preserves the original body", () => {
  it("sends the ORIGINAL text and no attachment metadata when capture throws", async () => {
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
      getSelfFence: vi.fn().mockResolvedValue({ agentHome: "/ws/coder/chat-1" }),
      getOrgId: vi.fn().mockResolvedValue("org-1"),
      workspacesRoot: "/ws",
      selfSlug: "coder",
    });

    await sink("see design.md please");

    const [, body] = sendMessage.mock.calls[0] ?? [];
    const sent = body as { content?: string; metadata?: { attachments?: unknown; documentContext?: unknown } };
    // Body restored to the original — NOT a rewritten explicit-link form.
    expect(sent.content).toBe("see design.md please");
    expect(sent.metadata?.attachments).toBeUndefined();
    expect(sent.metadata?.documentContext).toBeUndefined();
  });
});
