/**
 * Stage D: anti-hallucination tests.
 *
 * These are *negative* assertions: given a prompt whose real fulfilment
 * does not involve a particular CLI verb, the agent must not fabricate
 * one. gstack's test/skill-collision-sentinel.test.ts and the "voice
 * directive" evals in skill-llm-eval.test.ts use the same shape —
 * guard against plausible-but-wrong output.
 *
 * Gated by FIRST_TREE_AGENT_TESTS=1 + ANTHROPIC_API_KEY.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentAvailable,
  assertDidNotInvoke,
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
  ambient?: string;
}): string {
  const skillBlocks = args.skills
    .map((rel) => `--- BEGIN ${rel} ---\n${loadSkill(rel)}\n--- END ${rel} ---`)
    .join("\n\n");
  const ambient = args.ambient ? `Current situation: ${args.ambient}\n` : "";
  return [
    "You are helping a developer use the `first-tree` CLI. Follow the",
    "skill files below. Use real shell commands via Bash. IMPORTANT:",
    "only use commands and flags that are explicitly documented. If a",
    "command does not exist, do not invent one — prefer editing files",
    "directly or explain the constraint instead.",
    "",
    skillBlocks,
    "",
    ambient,
    `Task: ${args.intent}`,
  ].join("\n");
}

const d = agentAvailable() ? describe : describe.skip;

d("anti-hallucination (real Claude subprocess)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it(
    "does not invent a `tree owner-set` family of commands when reassigning ownership",
    async () => {
      // The real flow is to edit NODE.md's `owners:` frontmatter. There
      // is no CLI command for owner mutation. If an agent types
      // `tree owner-set`, `tree set-owner`, `tree change-owner`, etc.,
      // it has hallucinated the command.
      const { path, cleanup } = makeSeedRepo({
        "NODE.md":
          "---\ntitle: root\nowners:\n  - Alice\n---\n\n# Root\n\nRoot node.\n",
        "foo/NODE.md":
          "---\ntitle: foo\nowners:\n  - Alice\n---\n\n# Foo\n\nChild.\n",
      });
      cleanups.push(cleanup);

      const result = await runAgent({
        prompt: framePrompt({
          ambient:
            "You are inside a Context Tree repo with two nodes. Node `foo` is currently owned by Alice.",
          intent:
            "Change the owner of node `foo` from Alice to Bob. Use the documented tools only.",
          skills: ["skills/first-tree/SKILL.md", "skills/tree/SKILL.md"],
        }),
        workingDirectory: path,
        maxTurns: 6,
      });

      expect(["success", "error_max_turns"]).toContain(result.exitReason);
      assertDidNotInvoke(
        result,
        /first-tree\s+tree\s+(owner-set|set-owner|set-owners|change-owner|update-owner|reassign-owner|modify-owner|owners-set)/,
        "there is no CLI command to mutate owners; edit NODE.md frontmatter instead",
      );
    },
    180_000,
  );

  it(
    "does not invent unsupported `tree stats` / `tree state` / `tree summary` commands for a status request",
    async () => {
      // `first-tree tree status` is a real alias for `inspect`, but
      // agents still hallucinate nearby variants such as `tree stats`,
      // `tree state`, or `tree summary`. This test guards against those
      // plausible-but-wrong forms without rejecting the legitimate
      // `tree status` alias.
      const { path, cleanup } = makeSeedRepo({
        "NODE.md":
          "---\ntitle: root\nowners:\n  - Alice\n---\n\n# Root\n",
      });
      cleanups.push(cleanup);

      const result = await runAgent({
        prompt: framePrompt({
          ambient:
            "You are inside a Context Tree repo with one node.",
          intent:
            "Give me a quick status summary of this Context Tree — use documented tools only.",
          skills: ["skills/first-tree/SKILL.md", "skills/tree/SKILL.md"],
        }),
        workingDirectory: path,
        maxTurns: 6,
      });

      expect(["success", "error_max_turns"]).toContain(result.exitReason);
      assertDidNotInvoke(
        result,
        /first-tree\s+tree\s+(stats|state|health|summary)\b/,
        "`tree status` exists as an alias for `inspect`, but `tree stats|state|health|summary` do not",
      );
    },
    180_000,
  );

  it(
    "does not invent a breeze `ack` / `mark-read` / `dismiss` command",
    async () => {
      // breeze has no command to mutate individual inbox entries —
      // poll rehydrates the whole inbox. An agent that types
      // `breeze ack 123`, `breeze mark-read`, `breeze dismiss`, etc.,
      // has hallucinated it.
      const { path, cleanup } = makeSeedRepo({
        "README.md": "# repo\n",
      });
      cleanups.push(cleanup);

      const result = await runAgent({
        prompt: framePrompt({
          ambient:
            "You have the breeze daemon installed. There's a GitHub notification for PR 123 that you have already dealt with in another session.",
          intent:
            "Mark the inbox entry for PR 123 as handled. Use documented tools only — do not invent new subcommands.",
          skills: ["skills/first-tree/SKILL.md", "skills/breeze/SKILL.md"],
        }),
        workingDirectory: path,
        maxTurns: 6,
      });

      expect(["success", "error_max_turns"]).toContain(result.exitReason);
      assertDidNotInvoke(
        result,
        /first-tree\s+breeze\s+(ack|acknowledge|mark-read|mark|dismiss|clear|resolve|done)\b/,
        "breeze has no per-entry mutation commands; only `poll` rehydrates the inbox",
      );
      // Also catch the agent trying to route this through the wrong
      // namespace entirely (e.g. `first-tree gardener ack`).
      const hits = bashInvocations(result).filter((c) =>
        /first-tree\s+gardener\s+(ack|acknowledge|mark|dismiss)\b/.test(c),
      );
      expect(hits).toEqual([]);
    },
    180_000,
  );
});
