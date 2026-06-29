import { writeFileSync } from "node:fs";

import type { QualityBatchSummary, QualityCaseRunSummary } from "./types.js";

function markdownBool(value: boolean): string {
  return value ? "true" : "false";
}

function fenced(value: string): string {
  return value.trim().length === 0 ? "_empty_" : `\n\`\`\`text\n${value}\n\`\`\``;
}

function scoreRows(summary: QualityCaseRunSummary): string {
  const scores = summary.judge_scores;
  return summary.dimensions
    .map((dimension) => {
      const score = scores?.[dimension.key] ?? "n/a";
      return `- ${dimension.key}: score=${score}, threshold=${dimension.threshold}`;
    })
    .join("\n");
}

export function writeQualityCaseSummaries(summary: QualityCaseRunSummary): void {
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(summary.judgePromptPath, summary.judgePrompt, "utf8");
  writeFileSync(summary.judgeRawOutputPath, summary.raw_output, "utf8");

  const markdown = `# Quality Eval: ${summary.caseId}

## Result

- passed: ${markdownBool(summary.passed)}
- skill: ${summary.skill}
- deterministicGatePassed: ${markdownBool(summary.deterministicGatePassed)}
- gateCaseId: ${summary.gateCaseId}
- judge_provider: ${summary.judge_provider}
- judge_model: ${summary.judge_model}
- duration_ms: ${summary.duration_ms}
- cost_usd: ${summary.cost_usd ?? "n/a"}
- failures: ${summary.failures.length === 0 ? "none" : summary.failures.join("; ")}

## Scores

${scoreRows(summary)}

## Judge Reasoning

${summary.judge_reasoning ?? "_none_"}

## Source

${fenced(summary.source)}

## Artifact

${fenced(summary.artifact)}

## Raw Judge Output

${fenced(summary.raw_output)}

## Paths

- runRoot: \`${summary.runRoot}\`
- gateRunRoot: ${summary.gateRunRoot === null ? "`n/a`" : `\`${summary.gateRunRoot}\``}
- gateSummaryJsonPath: ${summary.gateSummaryJsonPath === null ? "`n/a`" : `\`${summary.gateSummaryJsonPath}\``}
- judgePromptPath: \`${summary.judgePromptPath}\`
- judgeRawOutputPath: \`${summary.judgeRawOutputPath}\`
`;

  writeFileSync(summary.summaryMdPath, markdown, "utf8");
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

export function formatQualitySummaryTable(batch: QualityBatchSummary): string {
  const rows = batch.cases.map((summary) => [
    summary.caseId,
    summary.skill,
    summary.judge_model,
    summary.failures.length === 0 ? "none" : summary.failures.join(","),
    String(summary.passed),
  ]);
  const header = ["case_id", "skill", "judge_model", "failures", "passed"];
  const widths = header.map((label, index) => {
    let width = label.length;
    for (const row of rows) {
      const value = row[index];
      if (value && value.length > width) width = value.length;
    }
    return width;
  });

  const lines = [
    header.map((label, index) => pad(label, widths[index] ?? label.length)).join("  "),
    ...rows.map((row) => row.map((value, index) => pad(value, widths[index] ?? value.length)).join("  ")),
  ];

  return lines.join("\n");
}

export function buildQualityBatchSummary(
  cases: readonly QualityCaseRunSummary[],
  runStartedAt: string,
): QualityBatchSummary {
  let passed = 0;
  for (const summary of cases) {
    if (summary.passed) passed += 1;
  }

  return {
    cases,
    failed: cases.length - passed,
    passed,
    runStartedAt,
  };
}
