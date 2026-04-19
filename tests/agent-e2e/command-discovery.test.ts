/**
 * Stage B: command-discovery tests.
 *
 * Given an intent prompt, the agent (armed with our SKILL.md files)
 * must invoke the correct `first-tree <namespace> <command>` command.
 * This is the most basic skill-health signal: "can an agent find the
 * right tool in our surface area?"
 *
 * Each test seeds a minimal tmp git repo, runs a real Claude Code
 * subprocess, and asserts on the actual Bash invocations the agent
 * made. We allow exit_reason = error_max_turns because several of
 * these tasks can reasonably stop mid-flow once the intended command
 * has been issued.
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

/**
 * Read the shipped SKILL.md and inline it into the agent prompt so
 * the subprocess does not have to rely on host-machine skill
 * discovery. This makes tests hermetic and independent of Claude
 * Code's local skill search path.
 */
function loadSkill(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf-8");
}

function framePrompt(args: { intent: string; skills: string[] }): string {
  const skillBlocks = args.skills
    .map((rel) => {
      const body = loadSkill(rel);
      return `--- BEGIN ${rel} ---\n${body}\n--- END ${rel} ---`;
    })
    .join("\n\n");
  return [
    "You are helping a developer use the `first-tree` CLI. Follow the",
    "skill files below. Use real shell commands via Bash. Do not",
    "fabricate flags or subcommands — only use the ones documented.",
    "",
    skillBlocks,
    "",
    `Task: ${args.intent}`,
  ].join("\n");
}

const d = agentAvailable() ? describe : describe.skip;

interface Case {
  label: string;
  intent: string;
  seed: Record<string, string>;
  skills: string[];
  expectPattern: RegExp;
  hint: string;
  maxTurns?: number;
}

const CASES: Case[] = [
  {
    label: "tree init for a brand-new repo",
    intent:
      "Please onboard this repository to a brand-new, dedicated Context Tree. Use the first-tree CLI; do not create files by hand.",
    seed: {
      "README.md": "# empty-repo\n",
    },
    skills: ["skills/first-tree/SKILL.md", "skills/tree/SKILL.md"],
    expectPattern: /first-tree\s+tree\s+init/,
    hint: "agent should call `first-tree tree init` to create a dedicated tree",
  },
  {
    label: "tree bind for an existing shared tree",
    intent:
      "Bind this repository to the existing shared Context Tree at agent-team-foundation/example-context. Do not init a new tree.",
    seed: {
      "README.md": "# source-repo\n",
      "src/index.ts": "export const ready = true;\n",
    },
    skills: ["skills/first-tree/SKILL.md", "skills/tree/SKILL.md"],
    expectPattern: /first-tree\s+tree\s+bind\b/,
    hint: "agent should call `first-tree tree bind` (not tree init)",
  },
  {
    label: "breeze poll for notifications",
    intent:
      "Show me my GitHub notification inbox. I want to see what needs my attention right now. Use the first-tree CLI.",
    seed: { "README.md": "# any-repo\n" },
    skills: ["skills/first-tree/SKILL.md", "skills/breeze/SKILL.md"],
    expectPattern: /first-tree\s+breeze\s+(poll|status|watch)\b/,
    hint:
      "agent should call a breeze inbox command (poll/status/watch), not a tree command",
  },
  {
    label: "gardener respond to PR feedback",
    intent:
      "There's a new review comment on PR #123 in this repo. Please respond to the reviewer feedback using the first-tree gardener agent.",
    seed: { "README.md": "# repo-with-pr\n" },
    skills: ["skills/first-tree/SKILL.md", "skills/gardener/SKILL.md"],
    expectPattern: /first-tree\s+gardener\s+respond\b.*(--pr\s+123|#123)/,
    hint:
      "agent should call `first-tree gardener respond --pr 123` with the PR number",
  },
  {
    label: "skill upgrade instead of manual file edits",
    intent:
      "My first-tree skill files feel out of date. Please upgrade first-tree on this machine. Do not edit files by hand.",
    seed: { "README.md": "# any-repo\n" },
    skills: ["skills/first-tree/SKILL.md"],
    expectPattern: /first-tree\s+skill\s+upgrade\b/,
    hint:
      "agent should call `first-tree skill upgrade`, not manually edit SKILL.md files",
  },
  {
    label: "tree verify from a bound source repo",
    intent:
      "Verify that the Context Tree bound to this repo is in a good state. Use the first-tree CLI.",
    seed: {
      "README.md": "# bound-source\n",
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
    },
    skills: ["skills/first-tree/SKILL.md", "skills/tree/SKILL.md"],
    expectPattern: /first-tree\s+tree\s+verify\b/,
    hint: "agent should call `first-tree tree verify`",
  },
];

d("command discovery (real Claude subprocess)", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it.each(CASES)(
    "$label",
    async ({ intent, seed, skills, expectPattern, hint, maxTurns }) => {
      const { path, cleanup } = makeSeedRepo(seed);
      cleanups.push(cleanup);
      const result = await runAgent({
        prompt: framePrompt({ intent, skills }),
        workingDirectory: path,
        maxTurns: maxTurns ?? 6,
      });

      expect(
        ["success", "error_max_turns"],
        `agent exited unexpectedly: ${result.exitReason}`,
      ).toContain(result.exitReason);

      try {
        assertInvokedCommand(result, expectPattern, hint);
      } catch (err) {
        const dump = bashInvocations(result)
          .map((c) => `  - ${c.slice(0, 200)}`)
          .join("\n");
        throw new Error(
          `${(err as Error).message}\n\nFull bash log:\n${dump}`,
        );
      }
    },
    180_000,
  );
});
