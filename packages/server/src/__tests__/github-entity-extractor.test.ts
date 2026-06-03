import type { ToolCallEventPayload } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { extractGithubEntity } from "../services/github-entity-extractor.js";

function basePayload(overrides: Partial<ToolCallEventPayload> = {}): ToolCallEventPayload {
  return {
    toolUseId: "tool_use_1",
    name: "Bash",
    args: { command: "" },
    status: "ok",
    resultPreview: "",
    ...overrides,
  };
}

describe("extractGithubEntity", () => {
  it("extracts a pull_request entity from `gh pr create` output", () => {
    const result = extractGithubEntity(
      basePayload({
        args: { command: 'gh pr create --title "Refactor inbox" --body "Fixes #42"' },
        resultPreview: "https://github.com/agent-team-foundation/first-tree/pull/123\n",
      }),
    );
    expect(result).toEqual({
      entityType: "pull_request",
      entityKey: "agent-team-foundation/first-tree#123",
      entityUrl: "https://github.com/agent-team-foundation/first-tree/pull/123",
      source: "bash-gh-pr",
    });
  });

  it("extracts a pull_request entity from Codex command_execution events", () => {
    const result = extractGithubEntity(
      basePayload({
        name: "command",
        args: { command: 'gh pr create --title "Codex PR" --body "body"' },
        resultPreview: "https://github.com/agent-team-foundation/first-tree/pull/456\n",
      }),
    );
    expect(result).toEqual({
      entityType: "pull_request",
      entityKey: "agent-team-foundation/first-tree#456",
      entityUrl: "https://github.com/agent-team-foundation/first-tree/pull/456",
      source: "bash-gh-pr",
    });
  });

  it("extracts a pull_request entity from Codex bash-wrapped gh commands with a repo flag", () => {
    const result = extractGithubEntity(
      basePayload({
        name: "command",
        args: {
          command:
            '/bin/bash -lc \'gh -R baixiaohang/first-tree-agent-prompts pr create --base main --head prompt-git-autonomy-362531 --title "Allow codex agents to refresh their workspaces" --body "body"\'',
        },
        resultPreview: "https://github.com/baixiaohang/first-tree-agent-prompts/pull/6\n",
      }),
    );
    expect(result).toEqual({
      entityType: "pull_request",
      entityKey: "baixiaohang/first-tree-agent-prompts#6",
      entityUrl: "https://github.com/baixiaohang/first-tree-agent-prompts/pull/6",
      source: "bash-gh-pr",
    });
  });

  it("extracts a pull_request entity from gh commands with an equals-form repo flag", () => {
    const result = extractGithubEntity(
      basePayload({
        args: { command: "gh --repo=owner/repo pr create --title feat --body body" },
        resultPreview: "https://github.com/owner/repo/pull/79",
      }),
    );
    expect(result).toEqual({
      entityType: "pull_request",
      entityKey: "owner/repo#79",
      entityUrl: "https://github.com/owner/repo/pull/79",
      source: "bash-gh-pr",
    });
  });

  it("extracts an issue entity from `gh issue create` output", () => {
    const result = extractGithubEntity(
      basePayload({
        args: { command: "gh issue create --title bug --body details" },
        resultPreview: "https://github.com/owner/repo/issues/77",
      }),
    );
    expect(result).toEqual({
      entityType: "issue",
      entityKey: "owner/repo#77",
      entityUrl: "https://github.com/owner/repo/issues/77",
      source: "bash-gh-issue",
    });
  });

  it("extracts an issue entity from gh commands with a global repo flag", () => {
    const result = extractGithubEntity(
      basePayload({
        args: { command: "gh --repo owner/repo issue create --title bug --body details" },
        resultPreview: "https://github.com/owner/repo/issues/78",
      }),
    );
    expect(result).toEqual({
      entityType: "issue",
      entityKey: "owner/repo#78",
      entityUrl: "https://github.com/owner/repo/issues/78",
      source: "bash-gh-issue",
    });
  });

  it("returns null when status is not ok (in-flight pending event)", () => {
    expect(
      extractGithubEntity(
        basePayload({
          status: "pending",
          args: { command: "gh pr create" },
          resultPreview: "https://github.com/owner/repo/pull/1",
        }),
      ),
    ).toBeNull();
  });

  it("returns null when status is error", () => {
    expect(
      extractGithubEntity(
        basePayload({
          status: "error",
          args: { command: "gh pr create" },
          resultPreview: "auth failed",
        }),
      ),
    ).toBeNull();
  });

  it("returns null when tool name is not a supported shell tool", () => {
    expect(
      extractGithubEntity(
        basePayload({
          name: "Read",
          args: { command: "gh pr create" },
          resultPreview: "https://github.com/owner/repo/pull/1",
        }),
      ),
    ).toBeNull();
  });

  it("ignores non-create gh commands even when their output contains a PR URL", () => {
    // `gh pr list` shows PR URLs but we MUST NOT bind them — those PRs were
    // not created by this tool call.
    expect(
      extractGithubEntity(
        basePayload({
          args: { command: "gh pr list" },
          resultPreview: "#1 fix bug https://github.com/owner/repo/pull/1",
        }),
      ),
    ).toBeNull();
  });

  it("ignores long dash-token gh commands that do not create an entity", () => {
    const dashTokens = Array.from({ length: 48 }, () => "-x").join(" ");
    expect(
      extractGithubEntity(
        basePayload({
          args: { command: `gh ${dashTokens} zzz` },
          resultPreview: "https://github.com/owner/repo/pull/1",
        }),
      ),
    ).toBeNull();
  });

  it("returns null when args is not an object with a command string", () => {
    expect(extractGithubEntity(basePayload({ args: null }))).toBeNull();
    expect(extractGithubEntity(basePayload({ args: { command: 123 } }))).toBeNull();
    expect(extractGithubEntity(basePayload({ args: "gh pr create" }))).toBeNull();
  });

  it("returns null when resultPreview has no GitHub URL", () => {
    expect(
      extractGithubEntity(
        basePayload({
          args: { command: "gh pr create" },
          resultPreview: "ok",
        }),
      ),
    ).toBeNull();
  });

  it("picks the issue URL when both `gh issue create` and an unrelated PR URL appear", () => {
    // The command discriminates intent, not the URL match — the issue regex
    // only matches /issues/N, so a stray /pull/N in the output is ignored.
    const result = extractGithubEntity(
      basePayload({
        args: { command: "gh issue create --title x" },
        resultPreview: "see also https://github.com/foo/bar/pull/9 — https://github.com/owner/repo/issues/77",
      }),
    );
    expect(result?.entityType).toBe("issue");
    expect(result?.entityKey).toBe("owner/repo#77");
  });
});
