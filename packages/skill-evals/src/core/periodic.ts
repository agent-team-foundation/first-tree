import type { ShippedSkillName, SkillEvalCase } from "./case-schema.js";
import type { SkillEvalSuiteDefinition } from "./coverage.js";

export type PeriodicCaseSelection = {
  caseId: string;
  skill: ShippedSkillName;
  status: "implemented" | "planned";
};

export type PeriodicSummary = {
  command: "eval:periodic";
  failed: number;
  passed: number;
  planned: number;
  runStartedAt: string;
  selected: readonly PeriodicCaseSelection[];
  skipped: number;
};

export type PeriodicOptions = {
  caseId: string | null;
  suite: ShippedSkillName | null;
};

function periodicCases(suites: readonly SkillEvalSuiteDefinition[]): readonly SkillEvalCase[] {
  return suites.flatMap((suite) => suite.cases.filter((evalCase) => evalCase.tier === "periodic"));
}

function selectedPeriodicCases(
  suites: readonly SkillEvalSuiteDefinition[],
  options: PeriodicOptions,
): readonly SkillEvalCase[] {
  return periodicCases(suites).filter((evalCase) => {
    if (options.suite !== null && evalCase.skill !== options.suite) return false;
    if (options.caseId !== null && evalCase.id !== options.caseId) return false;
    return true;
  });
}

export function buildPeriodicSummary(
  suites: readonly SkillEvalSuiteDefinition[],
  options: PeriodicOptions,
  runStartedAt = new Date().toISOString(),
): PeriodicSummary {
  const selectedCases = selectedPeriodicCases(suites, options);
  if (options.caseId !== null && selectedCases.length === 0) {
    const suiteText = options.suite === null ? "" : ` for suite ${options.suite}`;
    throw new Error(`No periodic case '${options.caseId}' found${suiteText}.`);
  }

  const implemented = selectedCases.filter((evalCase) => evalCase.status === "implemented");
  if (implemented.length > 0) {
    const cases = implemented.map((evalCase) => `${evalCase.skill}:${evalCase.id}`).join(", ");
    throw new Error(`Implemented periodic cases selected but no periodic runner is registered yet: ${cases}.`);
  }

  const selected = selectedCases.map((evalCase) => ({
    caseId: evalCase.id,
    skill: evalCase.skill,
    status: evalCase.status,
  }));
  const planned = selected.filter((evalCase) => evalCase.status === "planned").length;

  return {
    command: "eval:periodic",
    failed: 0,
    passed: 0,
    planned,
    runStartedAt,
    selected,
    skipped: planned,
  };
}

export function formatPeriodicSummary(summary: PeriodicSummary): string {
  const lines = [
    "Skill Eval Periodic",
    "",
    "No implemented periodic cases selected.",
    `Selected periodic cases: ${summary.selected.length}`,
    `Planned cases: ${summary.planned}`,
    `Skipped: ${summary.skipped}`,
  ];

  if (summary.selected.length > 0) {
    lines.push("", "Selected cases:");
    for (const evalCase of summary.selected) {
      lines.push(`- ${evalCase.skill}:${evalCase.caseId} (${evalCase.status})`);
    }
  }

  lines.push(
    "",
    "Periodic is a human-directed tier for broader, more expensive coverage. Additional suites may add implemented periodic cases later.",
  );
  return lines.join("\n");
}
