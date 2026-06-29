import { writeFileSync } from "node:fs";

import type { GradingEvidence, RiskFlag, SkillCaseGrading, SkillCaseScoreKey } from "./result-schema.js";

const SCORE_LABELS: Record<SkillCaseScoreKey, string> = {
  outcome_pass: "outcome",
  process_pass: "process",
  risk_pass: "risk",
  routing_pass: "routing",
};

export function evidence(label: string, detail: string): GradingEvidence {
  return { detail, label };
}

export function riskFlag(label: string, detail: string): RiskFlag {
  return { detail, label };
}

export function writeGradingJson(path: string, grading: SkillCaseGrading): void {
  writeFileSync(path, `${JSON.stringify(grading, null, 2)}\n`, "utf8");
}

export function gradingMarkdownRows(grading: SkillCaseGrading): string {
  return [
    `- routing_pass: ${String(grading.scores.routing_pass)}`,
    `- process_pass: ${String(grading.scores.process_pass)}`,
    `- outcome_pass: ${String(grading.scores.outcome_pass)}`,
    `- risk_pass: ${String(grading.scores.risk_pass)}`,
    `- riskFlags: ${grading.riskFlags.length === 0 ? "none" : grading.riskFlags.map((flag) => flag.label).join(", ")}`,
  ].join("\n");
}

function evidenceForScore(grading: SkillCaseGrading, score: SkillCaseScoreKey): readonly string[] {
  const details = grading.evidence
    .filter((item) => item.label === score || item.label.startsWith(`${score}.`))
    .map((item) => item.detail);
  if (score === "risk_pass") {
    return [...details, ...grading.riskFlags.map((flag) => `${flag.label}: ${flag.detail}`)];
  }
  return details;
}

export function gradingFailureMessages(grading: SkillCaseGrading): readonly string[] {
  if (grading.passed) return [];
  const failures: string[] = [];
  const scoreKeys: readonly SkillCaseScoreKey[] = ["routing_pass", "process_pass", "outcome_pass", "risk_pass"];
  for (const key of scoreKeys) {
    if (grading.scores[key]) continue;
    const details = evidenceForScore(grading, key);
    const suffix = details.length > 0 ? `: ${details.join("; ")}` : "";
    failures.push(`${key}=false (${SCORE_LABELS[key]})${suffix}`);
  }
  return failures.length > 0 ? failures : ["gate case failed"];
}
