import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_SETTINGS_PATH,
  CODEX_CONFIG_PATH,
  CODEX_HOOKS_PATH,
  ensureAgentContextHooks,
  INJECT_CONTEXT_COMMAND,
  removeAgentContextHooks,
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

describe("buildSourceIntegrationBlock", () => {
  it("notes the ask-a-human flow is pending redesign and carries no retired NHA CLI text", () => {
    const block = buildSourceIntegrationBlock("context-tree", {
      bindingMode: "shared-source",
      entrypoint: "/repos/x",
      treeMode: "shared",
      treeRepoName: "context-tree",
    });
    expect(block).toContain("[pending redesign, 自行判断]");
    expect(block).not.toMatch(/attention raise/);
  });
});

describe("upgradeTargetRoot", () => {
  it("upgrades a W1 workspace-member source root", () => {
    const sourceRoot = makeTempDir("first-tree-upgrade-source-");
    writeFileSync(
      join(sourceRoot, "AGENTS.md"),
      `${buildSourceIntegrationBlock("context-tree", {
        bindingMode: "workspace-member",
        entrypoint: "/repos/product-repo",
        treeMode: "shared",
        treeRepoName: "context-tree",
      })}\n`,
    );

    const summary = upgradeTargetRoot(sourceRoot);

    expect(summary.targetKind).toBe("source");
  });

  it("refuses to upgrade a pre-W1 source root and points the user at migrate-to-w1 (PR-C)", () => {
    // PR-C audit Finding 7 + 2b: `tree skill upgrade` on a pre-W1 source
    // repo no longer silently refreshes the legacy injection — it
    // throws up front so the user runs `migrate-to-w1` first. Exercise
    // both legacy binding modes.
    for (const bindingMode of ["standalone-source", "shared-source"] as const) {
      const sourceRoot = makeTempDir(`first-tree-upgrade-legacy-${bindingMode}-`);
      writeFileSync(
        join(sourceRoot, "AGENTS.md"),
        `${buildSourceIntegrationBlock("context-tree", {
          bindingMode,
          entrypoint: "/",
          treeMode: "shared",
          treeRepoName: "context-tree",
        })}\n`,
      );

      expect(() => upgradeTargetRoot(sourceRoot)).toThrowError(/migrate-to-w1/u);
    }
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

describe("agent hooks scope to workspace-root only", () => {
  function writeBinding(
    root: string,
    bindingMode: "workspace-root" | "workspace-member" | "shared-source" | "standalone-source",
  ): void {
    const entrypointByMode: Record<typeof bindingMode, string> = {
      "workspace-root": "/workspaces/liuchao-staff",
      "workspace-member": "/workspaces/liuchao-staff/repos/product-repo",
      "shared-source": "/repos/product-repo",
      "standalone-source": "/",
    };
    writeFileSync(
      join(root, "AGENTS.md"),
      `${buildSourceIntegrationBlock("context-tree", {
        bindingMode,
        entrypoint: entrypointByMode[bindingMode],
        treeMode: "shared",
        treeRepoName: "context-tree",
        ...(bindingMode === "workspace-root" || bindingMode === "workspace-member"
          ? { workspaceId: "liuchao-staff" }
          : {}),
      })}\n`,
    );
  }

  it("workspace-root: installs hooks", () => {
    const root = makeTempDir("first-tree-hooks-ws-root-");
    writeBinding(root, "workspace-root");

    const summary = upgradeTargetRoot(root);

    expect(summary.targetKind).toBe("source");
    expect(summary.hookSync.claudeSettings).toBe("created");
    expect(summary.hookSync.codexHooks).toBe("created");
    expect(summary.hookSync.codexConfig).toBe("created");
    expect(existsSync(join(root, CLAUDE_SETTINGS_PATH))).toBe(true);
    expect(readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf-8")).toContain(INJECT_CONTEXT_COMMAND);
  });

  it("workspace-member: does not install hooks (no-op when none exist)", () => {
    const root = makeTempDir("first-tree-hooks-ws-member-");
    writeBinding(root, "workspace-member");

    const summary = upgradeTargetRoot(root);

    expect(summary.targetKind).toBe("source");
    expect(summary.hookSync.claudeSettings).toBe("unchanged");
    expect(summary.hookSync.codexHooks).toBe("unchanged");
    expect(summary.hookSync.codexConfig).toBe("unchanged");
    expect(existsSync(join(root, CLAUDE_SETTINGS_PATH))).toBe(false);
    expect(existsSync(join(root, CODEX_HOOKS_PATH))).toBe(false);
  });

  it("workspace-member: strips legacy managed hooks installed by older versions", () => {
    const root = makeTempDir("first-tree-hooks-ws-member-strip-");
    // Pretend an older version had installed hooks here recursively.
    ensureAgentContextHooks(root);
    expect(existsSync(join(root, CLAUDE_SETTINGS_PATH))).toBe(true);
    expect(readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf-8")).toContain(INJECT_CONTEXT_COMMAND);

    writeBinding(root, "workspace-member");

    const summary = upgradeTargetRoot(root);

    expect(summary.hookSync.claudeSettings).toBe("removed");
    expect(summary.hookSync.codexHooks).toBe("removed");
    // codex_hooks flag is left alone — it gates the user's own hooks too.
    expect(summary.hookSync.codexConfig).toBe("unchanged");
    expect(readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf-8")).not.toContain(INJECT_CONTEXT_COMMAND);
    expect(readFileSync(join(root, CODEX_HOOKS_PATH), "utf-8")).not.toContain(INJECT_CONTEXT_COMMAND);
    expect(readFileSync(join(root, CODEX_CONFIG_PATH), "utf-8")).toMatch(/codex_hooks\s*=\s*true/);
  });

  it("shared-source: upgrade refuses (PR-C) — no hook plumbing executes", () => {
    // PR-C audit Finding 7: legacy bindings now hit the early-return
    // reject. The original behavioral pin (no hooks installed) is
    // preserved structurally: nothing runs, so nothing writes. Pin the
    // refusal directly.
    const root = makeTempDir("first-tree-hooks-shared-");
    writeBinding(root, "shared-source");

    expect(() => upgradeTargetRoot(root)).toThrowError(/migrate-to-w1/u);
    expect(existsSync(join(root, CLAUDE_SETTINGS_PATH))).toBe(false);
  });

  it("standalone-source: upgrade refuses (PR-C) — no hook plumbing executes", () => {
    const root = makeTempDir("first-tree-hooks-standalone-");
    writeBinding(root, "standalone-source");

    expect(() => upgradeTargetRoot(root)).toThrowError(/migrate-to-w1/u);
    expect(existsSync(join(root, CLAUDE_SETTINGS_PATH))).toBe(false);
  });

  it("tree repo upgrade: strips legacy hooks, never installs", () => {
    const root = makeTempDir("first-tree-hooks-tree-strip-");
    writeTreeState(root, {
      treeId: "context-tree",
      treeMode: "shared",
      treeRepoName: "context-tree",
    });
    // Simulate a tree repo that an older version had installed hooks into.
    ensureAgentContextHooks(root);
    expect(readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf-8")).toContain(INJECT_CONTEXT_COMMAND);

    const summary = upgradeTargetRoot(root);

    expect(summary.targetKind).toBe("tree");
    expect(summary.hookSync.claudeSettings).toBe("removed");
    expect(summary.hookSync.codexHooks).toBe("removed");
    expect(readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf-8")).not.toContain(INJECT_CONTEXT_COMMAND);
  });

  it("tree repo upgrade: does NOT scaffold tree-root WHITEPAPER.md (PR-A finding 2a)", () => {
    // Companion to bootstrap.ts:59's removal. `upgradeTargetRoot` on a tree
    // repo previously called `ensureWhitepaperSymlink(targetRoot)` at
    // `upgrade.ts:96`, which silently re-created the dead write that
    // `tree init` no longer produces. Pin the upgrade path's behavior too.
    const root = makeTempDir("first-tree-upgrade-tree-no-whitepaper-");
    writeTreeState(root, {
      treeId: "context-tree",
      treeMode: "shared",
      treeRepoName: "context-tree",
    });

    const summary = upgradeTargetRoot(root);

    expect(summary.targetKind).toBe("tree");
    expect(existsSync(join(root, "WHITEPAPER.md"))).toBe(false);
  });

  it("removeAgentContextHooks preserves user-added hooks in the same file", () => {
    const root = makeTempDir("first-tree-hooks-preserve-user-");
    mkdirSync(join(root, ".claude"), { recursive: true });
    // User-added Stop hook in .claude/settings.json alongside the first-tree managed hook.
    writeFileSync(
      join(root, CLAUDE_SETTINGS_PATH),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: INJECT_CONTEXT_COMMAND }] },
              { hooks: [{ type: "command", command: "echo my-own-hook" }] },
            ],
            Stop: [{ hooks: [{ type: "command", command: "echo stop-hook" }] }],
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = removeAgentContextHooks(root);

    expect(result.claudeSettings).toBe("removed");
    const after = readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf-8");
    expect(after).not.toContain(INJECT_CONTEXT_COMMAND);
    expect(after).toContain("echo my-own-hook");
    expect(after).toContain("echo stop-hook");
  });

  it("removeAgentContextHooks is a no-op when no managed hooks are present", () => {
    const root = makeTempDir("first-tree-hooks-remove-noop-");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, CLAUDE_SETTINGS_PATH),
      `${JSON.stringify(
        {
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "echo stop-hook" }] }],
          },
        },
        null,
        2,
      )}\n`,
    );
    const before = readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf-8");

    const result = removeAgentContextHooks(root);

    expect(result.claudeSettings).toBe("unchanged");
    expect(readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf-8")).toBe(before);
  });

  it(
    "removeAgentContextHooks is a byte-for-byte no-op when SessionStart contains only user hooks " +
      "(does not reformat the file)",
    () => {
      // Regression: an earlier draft of stripSessionStartManagedDocument would
      // JSON.stringify the parsed root whenever hooks.SessionStart existed,
      // turning a compact / differently-indented user file into pretty-printed
      // form and reporting "removed" for a pure formatting change.
      const root = makeTempDir("first-tree-hooks-user-sessionstart-noop-");
      mkdirSync(join(root, ".claude"), { recursive: true });
      // Compact JSON (one line). If strip rewrites, the output would be
      // multi-line pretty-printed.
      const compact = `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo my-own-hook"}]}]}}\n`;
      writeFileSync(join(root, CLAUDE_SETTINGS_PATH), compact);

      const result = removeAgentContextHooks(root);

      expect(result.claudeSettings).toBe("unchanged");
      expect(readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf-8")).toBe(compact);
    },
  );

  it("removeAgentContextHooks strips real v0.4.x legacy literals in .claude/settings.json", () => {
    // Real v0.4.x literal — the rename from `tree inject-context` to `tree
    // inject` happened in Phase 1B. The ensure path translates the legacy
    // literal in flight; the strip path must catch it as managed too.
    // Assembled from parts so a grep guard does not flag this test fixture.
    const LEGACY_SUBCOMMAND = `inject${"-"}context`;
    const LEGACY_CLAUDE_COMMAND = `npx -p first-tree first-tree tree ${LEGACY_SUBCOMMAND}`;
    const root = makeTempDir("first-tree-hooks-strip-v04x-claude-");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, CLAUDE_SETTINGS_PATH),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: LEGACY_CLAUDE_COMMAND }] },
              { hooks: [{ type: "command", command: "echo user-hook" }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = removeAgentContextHooks(root);
    const after = readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf-8");

    expect(result.claudeSettings).toBe("removed");
    expect(after).not.toContain(LEGACY_SUBCOMMAND);
    expect(after).toContain("echo user-hook");
  });

  it("removeAgentContextHooks strips real v0.4.x legacy literals in .codex/hooks.json", () => {
    const LEGACY_SUBCOMMAND = `inject${"-"}context`;
    const LEGACY_CODEX_COMMAND = `npx -p first-tree first-tree tree ${LEGACY_SUBCOMMAND}`;
    const root = makeTempDir("first-tree-hooks-strip-v04x-codex-");
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(
      join(root, CODEX_HOOKS_PATH),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "startup|resume",
                hooks: [{ type: "command", command: LEGACY_CODEX_COMMAND, statusMessage: "Loading" }],
              },
              {
                matcher: "startup|resume",
                hooks: [{ type: "command", command: "echo user-codex-hook" }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = removeAgentContextHooks(root);
    const after = readFileSync(join(root, CODEX_HOOKS_PATH), "utf-8");

    expect(result.codexHooks).toBe("removed");
    expect(after).not.toContain(LEGACY_SUBCOMMAND);
    expect(after).toContain("echo user-codex-hook");
  });

  it(
    "removeAgentContextHooks leaves codex_hooks flag and user .codex/hooks.json entries " +
      "intact when only first-tree managed entries are stripped",
    () => {
      // Regression: removing the [features].codex_hooks flag would silently
      // disable any user hook installations in the same .codex/hooks.json.
      const root = makeTempDir("first-tree-hooks-codex-flag-preserved-");
      ensureAgentContextHooks(root); // sets up flag + first-tree managed hook
      // Add a user hook entry alongside the managed one.
      const codexHooks = JSON.parse(readFileSync(join(root, CODEX_HOOKS_PATH), "utf-8")) as {
        hooks: { SessionStart: unknown[] };
      };
      codexHooks.hooks.SessionStart.push({
        matcher: "startup|resume",
        hooks: [{ type: "command", command: "echo user-codex-hook" }],
      });
      writeFileSync(join(root, CODEX_HOOKS_PATH), `${JSON.stringify(codexHooks, null, 2)}\n`);

      const result = removeAgentContextHooks(root);
      const codexHooksAfter = readFileSync(join(root, CODEX_HOOKS_PATH), "utf-8");
      const codexConfigAfter = readFileSync(join(root, CODEX_CONFIG_PATH), "utf-8");

      expect(result.codexHooks).toBe("removed");
      expect(result.codexConfig).toBe("unchanged");
      expect(codexHooksAfter).not.toContain(INJECT_CONTEXT_COMMAND);
      expect(codexHooksAfter).toContain("echo user-codex-hook");
      expect(codexConfigAfter).toMatch(/codex_hooks\s*=\s*true/);
    },
  );
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
