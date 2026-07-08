import { describe, expect, it } from "vitest";
import { createCodexHandler } from "../handlers/codex/index.js";
import type { SessionContext, SessionMessage } from "../runtime/handler.js";

const trialMetadata = {
  landingCampaignTrial: true,
  campaign: "production-scan",
  skillSetId: "production-scan",
  skillSetVersion: "2026.07.02.1",
  repo: {
    url: "https://github.com/acme/backend",
    canonicalKey: "github.com/acme/backend",
  },
};

function message(): SessionMessage {
  return {
    id: "m1",
    chatId: "chat-1",
    senderId: "human-1",
    format: "text",
    content: "start",
    metadata: {},
  };
}

function context(metadata: Record<string, unknown>): SessionContext {
  return {
    agent: {
      agentId: "agent-1",
      inboxId: "inbox_agent-1",
      displayName: "Trial Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata,
    },
  } as unknown as SessionContext;
}

describe("codex handler engine selection", () => {
  it("fails closed instead of running landing campaign trials on the SDK engine", async () => {
    const handler = createCodexHandler({
      workspaceRoot: "/tmp/first-tree-codex-test",
      runtimeProvider: "codex",
      codexHandlerEngine: "sdk",
    });

    expect(() => handler.start(message(), context(trialMetadata))).toThrow(
      /require the app-server workspace-only runtime/,
    );
  });
});
