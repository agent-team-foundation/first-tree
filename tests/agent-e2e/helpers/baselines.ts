/**
 * Baseline pinning for LLM-judge scores.
 *
 * LLM-based evals wobble. We accept some variance but refuse regressions
 * past a fixed tolerance. Baselines live in
 * tests/agent-e2e/baselines/*.json and are hand-bumped by maintainers
 * after reviewing why a score drifted (same pattern as gstack's
 * test/fixtures baselines).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = resolve(HERE, "..", "baselines");

export interface SkillQualityBaseline {
  clarity: number;
  completeness: number;
  actionability: number;
}

export interface SkillQualityBaselines {
  /** How far a per-axis score may drop below baseline before we fail. */
  tolerance: number;
  skills: Record<string, SkillQualityBaseline>;
}

function baselinePath(name: string): string {
  return join(BASELINE_DIR, `${name}.json`);
}

export function loadSkillQualityBaselines(): SkillQualityBaselines {
  const file = baselinePath("skill-quality");
  if (!existsSync(file)) {
    return { tolerance: 0.5, skills: {} };
  }
  return JSON.parse(readFileSync(file, "utf-8")) as SkillQualityBaselines;
}

export interface Regression {
  axis: keyof SkillQualityBaseline;
  baseline: number;
  observed: number;
  tolerance: number;
}

/**
 * Returns the list of axes that regressed past tolerance. Empty = OK.
 * If no baseline exists for a skill, this is a no-op (baselines get
 * seeded by running the test once and committing the output).
 */
export function findSkillRegressions(args: {
  skill: string;
  observed: SkillQualityBaseline;
  baselines: SkillQualityBaselines;
}): Regression[] {
  const baseline = args.baselines.skills[args.skill];
  if (!baseline) return [];
  const regressions: Regression[] = [];
  for (const axis of ["clarity", "completeness", "actionability"] as const) {
    const delta = baseline[axis] - args.observed[axis];
    if (delta > args.baselines.tolerance) {
      regressions.push({
        axis,
        baseline: baseline[axis],
        observed: args.observed[axis],
        tolerance: args.baselines.tolerance,
      });
    }
  }
  return regressions;
}

/**
 * Write (or overwrite) the baseline for a skill. Used by the
 * `--update` flag in the harness; never called automatically from a
 * passing test run.
 */
export function writeSkillBaseline(
  skill: string,
  observed: SkillQualityBaseline,
): void {
  const current = loadSkillQualityBaselines();
  current.skills[skill] = {
    clarity: observed.clarity,
    completeness: observed.completeness,
    actionability: observed.actionability,
  };
  writeFileSync(baselinePath("skill-quality"), JSON.stringify(current, null, 2) + "\n");
}
