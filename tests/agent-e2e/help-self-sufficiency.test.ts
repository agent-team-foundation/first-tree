/**
 * Stage E: help self-sufficiency tests.
 *
 * For each CLI namespace (`tree`, `breeze`, `gardener`, `skill`), the
 * output of `first-tree <ns> --help` must let an agent construct a
 * correct invocation without external references. We judge the same
 * three axes as the SKILL.md tests (clarity / completeness /
 * actionability, each ≥4/5), with a separate pinned baseline.
 *
 * `--help` is the surface an agent lands on when it stumbles — a
 * regression here often manifests as "agent tried but never guessed
 * the right flag." Guarding it early catches help-text rot that
 * wouldn't show up in unit tests.
 *
 * Gated by FIRST_TREE_AGENT_TESTS=1 + ANTHROPIC_API_KEY. Additionally
 * skipped if `dist/cli.js` is missing (run `pnpm build` first).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  judgeAgainstAxes,
  judgeAvailable,
} from "./helpers/llm-judge.js";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const CLI = join(REPO_ROOT, "dist", "cli.js");
const BASELINE_FILE = join(
  REPO_ROOT,
  "tests",
  "agent-e2e",
  "baselines",
  "help-quality.json",
);

interface HelpBaseline {
  clarity: number;
  completeness: number;
  actionability: number;
}

interface HelpBaselines {
  tolerance: number;
  namespaces: Record<string, HelpBaseline>;
}

function loadBaselines(): HelpBaselines {
  if (!existsSync(BASELINE_FILE)) {
    return { tolerance: 0.5, namespaces: {} };
  }
  return JSON.parse(readFileSync(BASELINE_FILE, "utf-8")) as HelpBaselines;
}

// Exported for parity with Stage A: baselines are hand-bumped after a
// maintainer reviews the score drift. See docs/testing/overview.md.
export function writeBaseline(ns: string, score: HelpBaseline): void {
  const current = loadBaselines();
  current.namespaces[ns] = score;
  writeFileSync(BASELINE_FILE, JSON.stringify(current, null, 2) + "\n");
}

function getHelp(ns: string): string {
  const result = spawnSync(process.execPath, [CLI, ns, "--help"], {
    encoding: "utf-8",
    env: { ...process.env, FIRST_TREE_SKIP_VERSION_CHECK: "1" },
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `\`${ns} --help\` exited with ${result.status}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

const NAMESPACES = ["tree", "breeze", "gardener", "skill"];
const MIN_SCORE = 4;

const d =
  judgeAvailable() && existsSync(CLI) ? describe : describe.skip;

d("CLI help is self-sufficient (LLM judge)", () => {
  const baselines = loadBaselines();

  it.each(NAMESPACES)(
    "first-tree %s --help scores ≥4 on every axis without regression",
    async (ns) => {
      const help = getHelp(ns);
      const verdict = await judgeAgainstAxes({
        subject: `the output of \`first-tree ${ns} --help\` as read by a coding agent`,
        content: help,
        axes: [
          {
            key: "clarity" as const,
            description:
              "Can an agent unambiguously understand what each subcommand does from this text alone?",
          },
          {
            key: "completeness" as const,
            description:
              "Are all subcommands, meaningful flags, valid values, and minimum inputs for each subcommand covered?",
          },
          {
            key: "actionability" as const,
            description:
              "Armed with ONLY this text, can an agent construct at least one correct, useful invocation for each subcommand?",
          },
        ],
      });

      const { scores, reasoning } = verdict;

      expect(
        scores.clarity,
        `${ns}: clarity=${scores.clarity}\n${reasoning}`,
      ).toBeGreaterThanOrEqual(MIN_SCORE);
      expect(
        scores.completeness,
        `${ns}: completeness=${scores.completeness}\n${reasoning}`,
      ).toBeGreaterThanOrEqual(MIN_SCORE);
      expect(
        scores.actionability,
        `${ns}: actionability=${scores.actionability}\n${reasoning}`,
      ).toBeGreaterThanOrEqual(MIN_SCORE);

      // Regression check vs pinned baseline.
      const baseline = baselines.namespaces[ns];
      if (baseline) {
        const regressions: string[] = [];
        for (const axis of ["clarity", "completeness", "actionability"] as const) {
          const delta = baseline[axis] - scores[axis];
          if (delta > baselines.tolerance) {
            regressions.push(
              `${axis}: baseline=${baseline[axis]} observed=${scores[axis]}`,
            );
          }
        }
        expect(
          regressions,
          `${ns} --help regressed past tolerance ${baselines.tolerance}:\n` +
            regressions.join("\n"),
        ).toEqual([]);
      }
    },
    120_000,
  );
});
