import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_SETTINGS_PATH,
  CODEX_HOOKS_PATH,
  ensureAgentContextHooks,
  INJECT_CONTEXT_COMMAND,
} from "../src/commands/tree/agent-context-hooks.js";
import { writeTreeState } from "../src/commands/tree/binding-state.js";
import { runTreeReview } from "../src/commands/tree/review-helper.js";
import { buildSourceIntegrationBlock } from "../src/commands/tree/source-integration.js";
import { upgradeTargetRoot } from "../src/commands/tree/upgrade.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("buildSourceIntegrationBlock — binName threading", () => {
  it("defaults to `first-tree` when no binName is provided (back-compat for callers and tests)", () => {
    const block = buildSourceIntegrationBlock("context-tree", {
      bindingMode: "shared-source",
      entrypoint: "/repos/x",
      treeMode: "shared",
      treeRepoName: "context-tree",
    });
    expect(block).toContain("`first-tree attention raise --requires-response`");
    expect(block).not.toContain("first-tree-staging");
    expect(block).not.toContain("first-tree-dev");
  });

  it("uses the supplied binName so staging / dev hosts render the binary that is actually on PATH", () => {
    const staging = buildSourceIntegrationBlock("context-tree", {
      binName: "first-tree-staging",
      bindingMode: "shared-source",
      entrypoint: "/repos/x",
      treeMode: "shared",
      treeRepoName: "context-tree",
    });
    expect(staging).toContain("`first-tree-staging attention raise --requires-response`");
    expect(staging).not.toMatch(/`first-tree attention raise/);

    const dev = buildSourceIntegrationBlock("context-tree", {
      binName: "first-tree-dev",
      bindingMode: "shared-source",
      entrypoint: "/repos/x",
      treeMode: "shared",
      treeRepoName: "context-tree",
    });
    expect(dev).toContain("`first-tree-dev attention raise --requires-response`");
  });
});

describe("upgradeTargetRoot", () => {
  it("upgrades a bound source root", () => {
    const sourceRoot = makeTempDir("first-tree-upgrade-source-");
    writeFileSync(
      join(sourceRoot, "AGENTS.md"),
      `${buildSourceIntegrationBlock("context-tree", {
        bindingMode: "shared-source",
        entrypoint: "/repos/product-repo",
        treeMode: "shared",
        treeRepoName: "context-tree",
      })}\n`,
    );

    const summary = upgradeTargetRoot(sourceRoot);

    expect(summary.targetKind).toBe("source");
  });

  it("upgrades a tree root", () => {
    const treeRoot = makeTempDir("first-tree-upgrade-tree-");
    writeTreeState(treeRoot, {
      treeId: "context-tree",
      treeMode: "shared",
      treeRepoName: "context-tree",
    });

    const summary = upgradeTargetRoot(treeRoot);

    expect(summary.targetKind).toBe("tree");
  });
});

describe("ensureAgentContextHooks legacy migration", () => {
  // Assembled from parts so the grep guard does not flag this literal.
  const LEGACY_SUBCOMMAND = `inject${"-"}context`;
  const LEGACY_TREE_FRAGMENT = `tree ${LEGACY_SUBCOMMAND}`;
  const LEGACY_COMMAND = `npx -p first-tree first-tree ${LEGACY_TREE_FRAGMENT}`;

  it("rewrites the legacy tree inject-* literal in .claude/settings.json to tree inject", () => {
    const root = makeTempDir("first-tree-hook-migrate-claude-");
    const settingsPath = join(root, CLAUDE_SETTINGS_PATH);
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [{ type: "command", command: LEGACY_COMMAND }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = ensureAgentContextHooks(root);
    const updated = readFileSync(settingsPath, "utf-8");

    expect(result.claudeSettings).toBe("updated");
    expect(updated).toContain(INJECT_CONTEXT_COMMAND);
    expect(updated).not.toContain(LEGACY_TREE_FRAGMENT);
  });

  it("is idempotent when .claude/settings.json already uses the new tree inject literal", () => {
    const root = makeTempDir("first-tree-hook-migrate-claude-noop-");
    const settingsPath = join(root, CLAUDE_SETTINGS_PATH);
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [{ type: "command", command: INJECT_CONTEXT_COMMAND }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    const before = readFileSync(settingsPath, "utf-8");

    const result = ensureAgentContextHooks(root);
    const after = readFileSync(settingsPath, "utf-8");

    expect(result.claudeSettings).toBe("unchanged");
    expect(after).toBe(before);
  });

  it("rewrites the legacy literal in .codex/hooks.json to tree inject", () => {
    const root = makeTempDir("first-tree-hook-migrate-codex-");
    const hooksPath = join(root, CODEX_HOOKS_PATH);
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(
      hooksPath,
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "startup|resume",
                hooks: [
                  {
                    type: "command",
                    command: LEGACY_COMMAND,
                    statusMessage: "Loading First Tree context",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = ensureAgentContextHooks(root);
    const updated = readFileSync(hooksPath, "utf-8");

    expect(result.codexHooks).toBe("updated");
    expect(updated).toContain(INJECT_CONTEXT_COMMAND);
    expect(updated).not.toContain(LEGACY_TREE_FRAGMENT);
  });

  it("creates fresh hook files with the new tree inject literal when none exist", () => {
    const root = makeTempDir("first-tree-hook-migrate-fresh-");
    const claudePath = join(root, CLAUDE_SETTINGS_PATH);
    const codexHooksPath = join(root, CODEX_HOOKS_PATH);

    expect(existsSync(claudePath)).toBe(false);
    expect(existsSync(codexHooksPath)).toBe(false);

    const result = ensureAgentContextHooks(root);

    expect(result.claudeSettings).toBe("created");
    expect(result.codexHooks).toBe("created");
    const claudeContent = readFileSync(claudePath, "utf-8");
    const codexContent = readFileSync(codexHooksPath, "utf-8");
    expect(claudeContent).toContain(INJECT_CONTEXT_COMMAND);
    expect(claudeContent).not.toContain(LEGACY_TREE_FRAGMENT);
    expect(codexContent).toContain(INJECT_CONTEXT_COMMAND);
    expect(codexContent).not.toContain(LEGACY_TREE_FRAGMENT);
  });
});

describe("runTreeReview", () => {
  it("writes parsed review JSON to the requested output path", () => {
    const root = makeTempDir("first-tree-review-root-");
    const diffPath = join(root, "pr.diff");
    const outputPath = join(root, "review.json");
    writeFileSync(join(root, "AGENTS.md"), "# Agents\n");
    writeFileSync(join(root, "NODE.md"), "# Root\n");
    writeFileSync(diffPath, "diff --git a/foo.md b/foo.md\n");

    const exitCode = runTreeReview({
      diffPath,
      outputPath,
      repoRoot: root,
      runner: () => '{"verdict":"APPROVE","summary":"Looks good"}',
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf-8")).toContain('"verdict": "APPROVE"');
  });
});
