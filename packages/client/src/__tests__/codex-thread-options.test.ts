import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { buildCodexThreadOptions } from "../handlers/codex/index.js";

/**
 * Codex CLI's two auth modes accept different model slugs:
 *   - ChatGPT-account auth rejects the `gpt-5-codex` family.
 *   - API-key auth accepts the wider set.
 * The server therefore stores `model: ""` by default and lets the CLI pick. The
 * handler must respect that — emitting `model` only when the operator
 * actively chose one, otherwise omitting it from `ThreadOptions`. A
 * regression here would silently break ChatGPT-auth users at first turn
 * (the symptom we hit before this fix: "turn completed with no message").
 */
function basePayload(
  overrides: Partial<Extract<AgentRuntimeConfigPayload, { kind: "codex" }>> = {},
): AgentRuntimeConfigPayload {
  return {
    kind: "codex",
    prompt: { append: "" },
    model: "",
    mcpServers: [],
    env: [],
    gitRepos: [],
    resourceSkills: [],
    reasoningEffort: "high",
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
    // Codex runs with `danger-full-access` because the agent's local-execution
    // surface (docker, cross-directory writes) routes through it; irreversible
    // actions are gated by the agent itself instead of by the codex sandbox.
    expect(opts.sandboxMode).toBe("danger-full-access");
    expect(opts.approvalPolicy).toBe("never");
    // Default reasoning effort for codex agents is "high" (footgun F3: minimal
    // reasoning is incompatible with default tools and is excluded entirely).
    expect(opts.modelReasoningEffort).toBe("high");
    expect(opts.webSearchEnabled).toBe(false);
  });

  it("passes the operator-configured reasoning effort through to the SDK", () => {
    for (const reasoningEffort of ["medium", "xhigh", "max", "ultra"] as const) {
      expect(buildCodexThreadOptions(basePayload({ reasoningEffort }), "/tmp/wsk").modelReasoningEffort).toBe(
        reasoningEffort,
      );
    }
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
    // Predeclared source repos materialise under the agent home's
    // `source-repos/` directory (no `worktrees/` prefix). The
    // `additionalDirectories` allowlist follows the same resolved paths.
    expect(opts.additionalDirectories).toEqual(["/tmp/wsk/source-repos/bar", "/tmp/wsk/source-repos/custom-path"]);
  });

  it("rejects unsafe git repo localPath before adding additionalDirectories", () => {
    expect(() =>
      buildCodexThreadOptions(
        basePayload({
          gitRepos: [{ url: "https://github.com/foo/bar.git", localPath: "../outside" }],
        }),
        "/tmp/wsk",
      ),
    ).toThrow(/Unsafe git repo localPath/);
  });
});
