/**
 * Stage A: static SKILL.md quality gates.
 *
 * Each of the four published skills must score ≥4/5 on clarity,
 * completeness, and actionability, and must not regress past tolerance
 * against its pinned baseline (baselines/skill-quality.json).
 *
 * Gated by FIRST_TREE_AGENT_TESTS=1 and ANTHROPIC_API_KEY so the
 * default test run never calls the API. Invoked via `pnpm test:agent`.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findSkillRegressions,
  loadSkillQualityBaselines,
} from "./helpers/baselines.js";
import {
  judgeAvailable,
  judgeSkillQuality,
} from "./helpers/llm-judge.js";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SKILLS = [
  { name: "first-tree", path: "skills/first-tree/SKILL.md" },
  { name: "tree", path: "skills/tree/SKILL.md" },
  { name: "breeze", path: "skills/breeze/SKILL.md" },
  { name: "gardener", path: "skills/gardener/SKILL.md" },
];

const MIN_SCORE = 4;
const d = judgeAvailable() ? describe : describe.skip;

d("SKILL.md quality (LLM judge)", () => {
  const baselines = loadSkillQualityBaselines();

  it.each(SKILLS)(
    "$name skill scores ≥$expected on every axis and does not regress",
    async ({ name, path }) => {
      const content = readFileSync(join(REPO_ROOT, path), "utf-8");
      const score = await judgeSkillQuality({ skillName: name, content });

      expect(
        score.clarity,
        `${name}: clarity=${score.clarity}\n${score.reasoning}`,
      ).toBeGreaterThanOrEqual(MIN_SCORE);
      expect(
        score.completeness,
        `${name}: completeness=${score.completeness}\n${score.reasoning}`,
      ).toBeGreaterThanOrEqual(MIN_SCORE);
      expect(
        score.actionability,
        `${name}: actionability=${score.actionability}\n${score.reasoning}`,
      ).toBeGreaterThanOrEqual(MIN_SCORE);

      const regressions = findSkillRegressions({
        skill: name,
        observed: score,
        baselines,
      });
      expect(
        regressions,
        `${name} regressed past tolerance (${baselines.tolerance}):\n` +
          regressions
            .map(
              (r) =>
                `  ${r.axis}: baseline=${r.baseline} observed=${r.observed}`,
            )
            .join("\n"),
      ).toEqual([]);
    },
    120_000,
  );
});
