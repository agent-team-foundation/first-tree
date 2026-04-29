import type { AgentRuntimeConfigPayload } from "@agent-team-foundation/first-tree-hub-shared";
import { describe, expect, it } from "vitest";
import { buildCodexThreadOptions } from "../handlers/codex.js";

/**
 * Codex CLI's two auth modes accept different model slugs:
 *   - ChatGPT-account auth rejects the `gpt-5-codex` family.
 *   - API-key auth accepts the wider set.
 * Hub therefore stores `model: ""` by default and lets the CLI pick. The
 * handler must respect that — emitting `model` only when the operator
 * actively chose one, otherwise omitting it from `ThreadOptions`. A
 * regression here would silently break ChatGPT-auth users at first turn
 * (the symptom we hit before this fix: "turn completed with no message").
 */
function basePayload(overrides: Partial<AgentRuntimeConfigPayload> = {}): AgentRuntimeConfigPayload {
  return {
    kind: "codex",
    prompt: { append: "" },
    model: "",
    mcpServers: [],
    env: [],
    gitRepos: [],
    ...overrides,
  };
}

describe("buildCodexThreadOptions", () => {
  it("omits `model` when payload.model is empty (auth-mode-agnostic default)", () => {
    const opts = buildCodexThreadOptions(basePayload({ model: "" }), "/tmp/wsk");
    expect("model" in opts).toBe(false);
  });

  it("passes `model` through when the operator explicitly set one", () => {
    const opts = buildCodexThreadOptions(basePayload({ model: "gpt-5.5" }), "/tmp/wsk");
    expect(opts.model).toBe("gpt-5.5");
  });

  it("pins the auth-friendly defaults the SDK requires", () => {
    const opts = buildCodexThreadOptions(basePayload(), "/tmp/wsk");
    expect(opts.workingDirectory).toBe("/tmp/wsk");
    expect(opts.skipGitRepoCheck).toBe(true);
    expect(opts.sandboxMode).toBe("workspace-write");
    expect(opts.approvalPolicy).toBe("never");
    // Footgun F3: minimal reasoning is incompatible with default tools.
    expect(opts.modelReasoningEffort).toBe("high");
    expect(opts.webSearchEnabled).toBe(false);
  });

  it("derives additionalDirectories from gitRepos (with deriveRepoLocalPath fallback)", () => {
    const opts = buildCodexThreadOptions(
      basePayload({
        gitRepos: [
          { url: "https://github.com/foo/bar.git" },
          { url: "https://github.com/baz/qux.git", localPath: "custom-path" },
        ],
      }),
      "/tmp/wsk",
    );
    expect(opts.additionalDirectories).toEqual(["/tmp/wsk/bar", "/tmp/wsk/custom-path"]);
  });
});
