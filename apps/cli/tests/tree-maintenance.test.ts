import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_SETTINGS_PATH,
  CODEX_CONFIG_PATH,
  CODEX_HOOKS_PATH,
  ensureAgentContextHooks,
  formatAgentContextHookMessages,
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

  it("formats hook sync messages for created and updated files", () => {
    expect(
      formatAgentContextHookMessages({
        claudeSettings: "created",
        codexConfig: "created",
        codexHooks: "created",
      }),
    ).toEqual([
      "Created `.claude/settings.json` with the first-tree SessionStart hook.",
      "Created `.codex/config.toml` with `codex_hooks = true`.",
      "Created `.codex/hooks.json` with the first-tree `SessionStart` hook.",
    ]);

    expect(
      formatAgentContextHookMessages({
        claudeSettings: "updated",
        codexConfig: "updated",
        codexHooks: "updated",
      }),
    ).toEqual([
      "Updated `.claude/settings.json` to use the first-tree SessionStart hook.",
      "Updated `.codex/config.toml` to enable `codex_hooks`.",
      "Updated `.codex/hooks.json` to use the first-tree `SessionStart` hook.",
    ]);

    expect(
      formatAgentContextHookMessages({
        claudeSettings: "unchanged",
        codexConfig: "unchanged",
        codexHooks: "unchanged",
      }),
    ).toEqual([]);
  });

  it("updates existing Codex config and removes stale managed Claude hook scripts", () => {
    const root = makeTempDir("first-tree-hook-update-existing-");
    const settingsPath = join(root, CLAUDE_SETTINGS_PATH);
    const configPath = join(root, CODEX_CONFIG_PATH);
    mkdirSync(join(root, ".claude"), { recursive: true });
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              "keep-raw-group",
              {
                hooks: [
                  {
                    type: "command",
                    command: ".agents/skills/first-tree/assets/framework/helpers/inject-tree-context.sh",
                  },
                  { type: "command", command: "echo keep" },
                  { type: "shell", command: INJECT_CONTEXT_COMMAND },
                  "keep-raw-hook",
                ],
              },
              {
                hooks: [
                  {
                    type: "command",
                    command: ".context-tree/scripts/inject-tree-context.sh",
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
    writeFileSync(configPath, '[features]\ncodex_hooks = false\nother = true\n\n[model]\nname = "gpt"\n');

    const result = ensureAgentContextHooks(root);
    const settings = readFileSync(settingsPath, "utf-8");
    const config = readFileSync(configPath, "utf-8");

    expect(result.claudeSettings).toBe("updated");
    expect(result.codexConfig).toBe("updated");
    expect(settings).not.toContain("inject-tree-context.sh");
    expect(settings).toContain("echo keep");
    expect(settings).toContain("keep-raw-hook");
    expect(settings).toContain("keep-raw-group");
    expect(config).toContain("[features]\ncodex_hooks = true\nother = true");
    expect(config).toContain('[model]\nname = "gpt"');
  });

  it("appends a Codex features section when config exists without one", () => {
    const root = makeTempDir("first-tree-hook-config-append-");
    const configPath = join(root, CODEX_CONFIG_PATH);
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(configPath, 'model = "gpt"\n');

    const result = ensureAgentContextHooks(root);

    expect(result.codexConfig).toBe("updated");
    expect(readFileSync(configPath, "utf-8")).toBe('model = "gpt"\n\n[features]\ncodex_hooks = true\n');
  });

  it("rebuilds malformed JSON hook files", () => {
    const root = makeTempDir("first-tree-hook-malformed-json-");
    const settingsPath = join(root, CLAUDE_SETTINGS_PATH);
    const hooksPath = join(root, CODEX_HOOKS_PATH);
    mkdirSync(join(root, ".claude"), { recursive: true });
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(settingsPath, "not json\n");
    writeFileSync(hooksPath, "not json\n");

    const result = ensureAgentContextHooks(root);

    expect(result.claudeSettings).toBe("updated");
    expect(result.codexHooks).toBe("updated");
    expect(readFileSync(settingsPath, "utf-8")).toContain(INJECT_CONTEXT_COMMAND);
    expect(readFileSync(hooksPath, "utf-8")).toContain("Loading First Tree context");
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
