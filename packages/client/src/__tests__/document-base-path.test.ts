import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { documentBasePathFromRuntimeConfig } from "../runtime/session-manager.js";

function payload(gitRepos: AgentRuntimeConfigPayload["gitRepos"]): AgentRuntimeConfigPayload {
  return { kind: "claude-code", prompt: { append: "" }, model: "", mcpServers: [], env: [], gitRepos };
}

const PER_CHAT = "/data/workspaces/agent/chat-123";

describe("documentBasePathFromRuntimeConfig", () => {
  it("returns the per-chat workspace root when there are zero repos", () => {
    expect(documentBasePathFromRuntimeConfig(payload([]), PER_CHAT)).toBe(PER_CHAT);
  });

  it("returns the per-chat workspace root when there are multiple repos", () => {
    const result = documentBasePathFromRuntimeConfig(
      payload([{ url: "https://github.com/a/one.git" }, { url: "https://github.com/a/two.git" }]),
      PER_CHAT,
    );
    expect(result).toBe(PER_CHAT);
  });

  it("returns an ABSOLUTE repo worktree path (perChatRoot + derived localPath) for a single repo", () => {
    // Regression: the old code returned a bare relative localPath
    // ("first-tree"), which the runtime resolved against its own
    // process.cwd() (the launch dir, not the per-chat workspace) and failed to
    // find any doc — leaving single-repo cloud preview dead.
    expect(documentBasePathFromRuntimeConfig(payload([{ url: "https://github.com/a/first-tree.git" }]), PER_CHAT)).toBe(
      `${PER_CHAT}/first-tree`,
    );
  });

  it("honours an explicit localPath for a single repo", () => {
    expect(
      documentBasePathFromRuntimeConfig(payload([{ url: "https://x/y.git", localPath: "nested/repo" }]), PER_CHAT),
    ).toBe(`${PER_CHAT}/nested/repo`);
  });

  it("falls back to the per-chat root when a single repo's localPath is blank", () => {
    expect(documentBasePathFromRuntimeConfig(payload([{ url: "", localPath: "   " }]), PER_CHAT)).toBe(PER_CHAT);
  });
});
