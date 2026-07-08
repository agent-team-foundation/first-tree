import type { FirstTreeHubSDK } from "@first-tree/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildSnapshotsMock = vi.hoisted(() => vi.fn());

vi.mock("@first-tree/client", () => ({
  buildMessageDocumentSnapshots: buildSnapshotsMock,
}));

import { captureOutboundDocs } from "../core/doc-capture.js";

function sdkWithOrg(organizationId: unknown): FirstTreeHubSDK {
  return {
    serverUrl: "https://hub.example",
    async getChatDetail() {
      return { id: "chat-1", organizationId, participants: [] };
    },
  } as unknown as FirstTreeHubSDK;
}

describe("captureOutboundDocs mocked branch edges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSnapshotsMock.mockResolvedValue({
      refs: [],
      rewrittenText: "rewritten",
      failedMentions: [],
    });
  });

  it("passes through when the chat has no organization id", async () => {
    const out = await captureOutboundDocs(
      "see docs/a.md",
      { sdk: sdkWithOrg(""), chatId: "chat-1" },
      { FIRST_TREE_DOC_AGENT_HOME: "/agent-home" },
    );

    expect(out).toEqual({ content: "see docs/a.md" });
    expect(buildSnapshotsMock).not.toHaveBeenCalled();
  });

  it("passes a workspace fence only when both workspace root and self slug are present", async () => {
    await captureOutboundDocs(
      "see docs/a.md",
      { sdk: sdkWithOrg("org-1"), chatId: "chat-1" },
      {
        FIRST_TREE_DOC_AGENT_HOME: "/agent-home",
        FIRST_TREE_WORKSPACES_ROOT: "/workspaces",
      },
    );
    expect(buildSnapshotsMock).toHaveBeenLastCalledWith(
      "see docs/a.md",
      { agentHome: "/agent-home" },
      expect.objectContaining({ orgId: "org-1" }),
      undefined,
    );

    await captureOutboundDocs(
      "see docs/a.md",
      { sdk: sdkWithOrg("org-1"), chatId: "chat-1" },
      {
        FIRST_TREE_DOC_AGENT_HOME: "/agent-home",
        FIRST_TREE_WORKSPACES_ROOT: "/workspaces",
        FIRST_TREE_AGENT_SLUG: "nova",
      },
    );
    expect(buildSnapshotsMock).toHaveBeenLastCalledWith(
      "see docs/a.md",
      { agentHome: "/agent-home" },
      expect.objectContaining({ orgId: "org-1" }),
      { workspacesRoot: "/workspaces", chatId: "chat-1", selfSlug: "nova" },
    );
  });

  it("returns failed mentions as documentContext metadata", async () => {
    buildSnapshotsMock.mockResolvedValueOnce({
      refs: [],
      rewrittenText: "rewritten body",
      failedMentions: [{ raw: "missing.md", reason: "missing" }],
    });

    const out = await captureOutboundDocs(
      "see missing.md",
      { sdk: sdkWithOrg("org-1"), chatId: "chat-1" },
      { FIRST_TREE_DOC_AGENT_HOME: "/agent-home" },
    );

    expect(out).toMatchObject({
      content: "rewritten body",
      documentContext: {
        kind: "snapshot",
        failedMentions: [{ raw: "missing.md", reason: "missing" }],
      },
    });
  });
});
