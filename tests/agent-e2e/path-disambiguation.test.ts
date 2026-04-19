/**
 * Stage C: path-disambiguation tests.
 *
 * first-tree has three working-directory contexts with overlapping
 * command surfaces:
 *
 *   1. A *source repo* bound to a Context Tree (tree lives elsewhere).
 *   2. A *dedicated tree repo* where the tree files live in-place.
 *   3. A *workspace root* that links member repos under it.
 *
 * Several CLI commands behave differently — or should refuse to run —
 * depending on which of these you're in. The deterministic tests in
 * tests/e2e/cli-e2e.test.ts cover those code paths. These tests
 * cover the complementary question: "does the agent, armed with our
 * SKILL.md files, pick the right path?"
 *
 * Gated by FIRST_TREE_AGENT_TESTS=1 + ANTHROPIC_API_KEY.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentAvailable,
  assertInvokedCommand,
  bashInvocations,
  makeSeedRepo,
  runAgent,
} from "./helpers/run-agent.js";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function loadSkill(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

function framePrompt(args: {
  intent: string;
  skills: string[];
  ambient: string;
}): string {
  const skillBlocks = args.skills
    .map((rel) => `--- BEGIN ${rel} ---\n${loadSkill(rel)}\n--- END ${rel} ---`)
    .join("\n\n");
  return [
    "You are helping a developer use the `first-tree` CLI. Follow the",
    "skill files below. Use real shell commands via Bash. Do not",
    "fabricate flags or subcommands — only use the ones documented.",
    "Pay attention to which KIND of directory you are in; the CLI",
    "behaves differently in source repos, dedicated tree repos, and",
    "workspace roots.",
    "",
    skillBlocks,
    "",
    `Current situation: ${args.ambient}`,
    `Task: ${args.intent}`,
  ].join("\n");
}

const d = agentAvailable() ? describe : describe.skip;

d("path disambiguation (real Claude subprocess)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it(
    "prefers --tree-path over running `tree verify` inside a source repo",
    async () => {
      // A source repo bound to a shared tree: the tree files live in a
      // sibling checkout, not here. `tree verify` without --tree-path
      // would run in the wrong directory.
      const { path, cleanup } = makeSeedRepo({
        "README.md": "# bound source repo\n",
        ".first-tree/source.json": JSON.stringify(
          {
            tree: {
              repo: "agent-team-foundation/example-context",
              localPath: "../example-context",
            },
            mode: "shared-source",
          },
          null,
          2,
        ),
      });
      cleanups.push(cleanup);

      const result = await runAgent({
        prompt: framePrompt({
          ambient:
            "You are inside a *source repo* that is bound to a shared Context Tree. The tree files live in a sibling directory `../example-context`, not here.",
          intent:
            "Run `first-tree tree verify` correctly for this setup. The tree files are not in this directory.",
          skills: ["skills/first-tree/SKILL.md", "skills/tree/SKILL.md"],
        }),
        workingDirectory: path,
        maxTurns: 8,
      });

      expect(["success", "error_max_turns"]).toContain(result.exitReason);
      // Must either pass --tree-path to verify OR cd into the tree dir first.
      const commands = bashInvocations(result);
      const usedTreePath = commands.some((c) =>
        /first-tree\s+tree\s+verify\b.*--tree-path/.test(c),
      );
      const cdFirst = commands.some((c) =>
        /cd\s+[^\n&|;]*example-context[^\n&|;]*\s*(&&|;)\s*first-tree\s+tree\s+verify\b/.test(
          c,
        ),
      );
      expect(
        usedTreePath || cdFirst,
        `agent did not target the sibling tree checkout.\n${commands.map((c) => `  - ${c.slice(0, 200)}`).join("\n")}`,
      ).toBe(true);
    },
    180_000,
  );

  it(
    "picks the dedicated flow when the user explicitly asks for a dedicated tree",
    async () => {
      const { path, cleanup } = makeSeedRepo({
        "README.md": "# empty repo\n",
      });
      cleanups.push(cleanup);

      const result = await runAgent({
        prompt: framePrompt({
          ambient:
            "You are inside an empty repo. The developer wants a new *dedicated* Context Tree — i.e. the tree files should live in THIS repo, not in a separate shared tree repo.",
          intent:
            "Create a new dedicated Context Tree here. Do not bind to an external shared tree.",
          skills: ["skills/first-tree/SKILL.md", "skills/tree/SKILL.md"],
        }),
        workingDirectory: path,
        maxTurns: 6,
      });

      expect(["success", "error_max_turns"]).toContain(result.exitReason);
      assertInvokedCommand(
        result,
        /first-tree\s+tree\s+init\b/,
        "agent should run `first-tree tree init` for dedicated-tree setup",
      );
      // It must NOT route through bind; bind is the shared-tree path.
      const bindHits = bashInvocations(result).filter((c) =>
        /first-tree\s+tree\s+bind\b/.test(c),
      );
      expect(
        bindHits,
        `agent used \`tree bind\` but should have used \`tree init\`:\n${bindHits.join("\n")}`,
      ).toEqual([]);
    },
    180_000,
  );

  it(
    "uses the workspace flow when invoked at a workspace root with member repos",
    async () => {
      // Workspace root with two member-repo directories already present.
      // The correct onboarding path is `first-tree tree workspace` (not a
      // per-repo bind inside one of the members).
      const { path, cleanup } = makeSeedRepo({
        "README.md": "# workspace root\n",
        "repo-a/README.md": "# member repo a\n",
        "repo-a/package.json": "{\"name\":\"repo-a\"}\n",
        "repo-b/README.md": "# member repo b\n",
        "repo-b/package.json": "{\"name\":\"repo-b\"}\n",
      });
      cleanups.push(cleanup);

      const result = await runAgent({
        prompt: framePrompt({
          ambient:
            "You are at a *workspace root*. Under it are two member repos: `repo-a/` and `repo-b/`. This is not itself a source repo for any product — it is a folder that contains multiple repos.",
          intent:
            "Onboard this workspace (including the member repos beneath it) to a shared Context Tree at agent-team-foundation/example-context.",
          skills: ["skills/first-tree/SKILL.md", "skills/tree/SKILL.md"],
        }),
        workingDirectory: path,
        maxTurns: 8,
      });

      expect(["success", "error_max_turns"]).toContain(result.exitReason);
      const commands = bashInvocations(result);
      const usedWorkspace = commands.some((c) =>
        /first-tree\s+tree\s+workspace\b/.test(c),
      );
      expect(
        usedWorkspace,
        `agent did not invoke \`first-tree tree workspace\` for a workspace root.\n${commands.map((c) => `  - ${c.slice(0, 200)}`).join("\n")}`,
      ).toBe(true);
    },
    240_000,
  );
});
