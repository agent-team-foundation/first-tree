import { writeFileSync } from "node:fs";

import { evidence, gradingMarkdownRows, riskFlag, writeGradingJson } from "../../core/grading.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";
import type { BatchSummary, CaseRunSummary, EvalMetrics, FixtureValidation, ReadMode } from "./types.js";

const HELP_ARGV = ["tree", "tree", "--help"];

function markdownBool(value: boolean): string {
  return value ? "true" : "false";
}

function argvEquals(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isHelpArgv(argv: readonly string[]): boolean {
  return argvEquals(argv, HELP_ARGV);
}

function isTreeTreeArgv(argv: readonly string[]): boolean {
  return argv[0] === "tree" && argv[1] === "tree";
}

function isTreeSelectorArgv(argv: readonly string[]): boolean {
  return isTreeTreeArgv(argv) && !isHelpArgv(argv);
}

function formatArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(arg)) return arg;
  return JSON.stringify(arg);
}

function formatCommand(argv: readonly string[]): string {
  return argv.map(formatArg).join(" ");
}

export function driftNote(
  metrics: EvalMetrics,
  expectedTrigger: boolean,
  readMode: ReadMode = "managed",
): string | null {
  const notes: string[] = [];
  const nonZeroResults = metrics.firstTreeCommandResults.filter((result) => result.exitCode !== 0);
  const selectorCallCount = metrics.firstTreeArgv.filter(isTreeSelectorArgv).length;
  const selectorExitCodes = metrics.firstTreeCommandResults
    .filter((result) => isTreeSelectorArgv(result.argv))
    .map((result) => result.exitCode);

  if (nonZeroResults.length > 0) {
    const detail = nonZeroResults
      .map((result) => `first-tree ${formatCommand(result.argv)} => ${result.exitCode}`)
      .join("; ");
    notes.push(`first-tree command(s) returned non-zero exit code(s): ${detail}.`);
  }

  if (expectedTrigger && !metrics.helpSucceeded) {
    if (!metrics.helpAttempted && metrics.helpExitCodes.length === 0) {
      notes.push("Required first-tree tree tree --help command did not run during model phase.");
    } else {
      const exitCodes = metrics.helpExitCodes.length > 0 ? metrics.helpExitCodes.join(", ") : "none";
      notes.push(`Required first-tree tree tree --help command did not succeed; observed exit code(s): ${exitCodes}.`);
    }
  }

  if (expectedTrigger && !metrics.selectionSucceeded) {
    if (selectorCallCount === 0 && selectorExitCodes.length === 0) {
      notes.push("Required first-tree tree tree selector command did not run during model phase.");
    } else {
      const exitCodes = selectorExitCodes.length > 0 ? selectorExitCodes.join(", ") : "none";
      notes.push(
        `Required first-tree tree tree selector command did not succeed; observed exit code(s): ${exitCodes}.`,
      );
    }
  }

  if (expectedTrigger && readMode === "byo") {
    if (!metrics.readHelpSucceeded) notes.push("Required first-tree tree read --help command did not succeed.");
    if (!metrics.readActivationSucceeded) {
      notes.push(`BYO Read required exactly one successful activation; observed calls=${metrics.readActivationCalls}.`);
    }
    if (!metrics.byoReadSequenceOk) {
      notes.push("BYO Read commands did not follow read help → activation → hierarchy help → selector order.");
    }
    if (!metrics.byoSelectorsNoPull) notes.push("Every BYO hierarchy selector must include --no-pull.");
    if (!metrics.byoSnapshotDetached || !metrics.byoSnapshotExactHeadConsistent) {
      notes.push("BYO selectors did not all observe the activation's exact detached snapshot head.");
    }
  }

  if (expectedTrigger && !metrics.expectedFactsObserved) {
    notes.push(
      "Expected Context Tree facts were not surfaced in the model output; inspect events.jsonl for the final assistant messages.",
    );
  }

  if (!expectedTrigger && metrics.expectedFactHits.length > 0) {
    notes.push(`Off-topic case surfaced Context Tree fact(s): ${metrics.expectedFactHits.join(" | ")}.`);
  }

  return notes.length > 0 ? notes.join(" ") : null;
}

export function buildGrading(
  caseId: string,
  metrics: EvalMetrics,
  expectedTrigger: boolean,
  passed: boolean,
  readMode: ReadMode = "managed",
): SkillCaseGrading {
  const unexpectedReadUse =
    metrics.skillHit || metrics.firstTreeCalls > 0 || metrics.firstTreeCommandResults.length > 0;
  const routingPass = expectedTrigger ? metrics.skillFileReadObserved : !unexpectedReadUse;
  const byoProcessPassed =
    readMode === "managed" ||
    (metrics.readHelpSucceeded &&
      metrics.readActivationSucceeded &&
      metrics.byoReadSequenceOk &&
      metrics.byoSelectorsNoPull &&
      metrics.byoSnapshotDetached &&
      metrics.byoSnapshotExactHeadConsistent);
  const processPass = expectedTrigger
    ? metrics.fixtureValidationOk &&
      metrics.runnerExitCode === 0 &&
      metrics.helpSucceeded &&
      metrics.selectionSucceeded &&
      metrics.modelFirstTreeCommandsOk &&
      byoProcessPassed
    : metrics.fixtureValidationOk &&
      metrics.runnerExitCode === 0 &&
      metrics.firstTreeCalls === 0 &&
      metrics.firstTreeCommandResults.length === 0 &&
      metrics.modelFirstTreeCommandsOk;
  const outcomePass = expectedTrigger ? metrics.expectedFactsObserved : metrics.expectedFactHits.length === 0;
  const riskPass = metrics.modelFirstTreeCommandsOk;
  const failedCommands = metrics.firstTreeCommandResults.filter((result) => result.exitCode !== 0);

  return {
    caseId,
    evidence: [
      evidence(
        "routing_pass",
        expectedTrigger
          ? `trigger case skill file read observed=${metrics.skillFileReadObserved}`
          : `non-trigger case unexpected skill/tree usage observed=${unexpectedReadUse}`,
      ),
      evidence(
        "process_pass",
        expectedTrigger
          ? `fixture ok=${metrics.fixtureValidationOk}; runner exit=${metrics.runnerExitCode}; read mode=${readMode}; read help succeeded=${metrics.readHelpSucceeded}; activation calls=${metrics.readActivationCalls}; activation succeeded=${metrics.readActivationSucceeded}; sequence ok=${metrics.byoReadSequenceOk}; selectors no-pull=${metrics.byoSelectorsNoPull}; detached=${metrics.byoSnapshotDetached}; exact head consistent=${metrics.byoSnapshotExactHeadConsistent}; hierarchy help succeeded=${metrics.helpSucceeded}; selector succeeded=${metrics.selectionSucceeded}; first-tree commands ok=${metrics.modelFirstTreeCommandsOk}`
          : `fixture ok=${metrics.fixtureValidationOk}; runner exit=${metrics.runnerExitCode}; model first-tree calls=${metrics.firstTreeCalls}; first-tree results=${metrics.firstTreeCommandResults.length}`,
      ),
      evidence(
        "outcome_pass",
        expectedTrigger
          ? `expected facts observed=${metrics.expectedFactsObserved}; hits=${metrics.expectedFactHits.join(" | ") || "none"}`
          : `off-topic expected fact hits=${metrics.expectedFactHits.join(" | ") || "none"}`,
      ),
      evidence(
        "risk_pass",
        failedCommands.length === 0
          ? "no failed model-phase first-tree commands observed"
          : `failed model-phase first-tree commands=${failedCommands
              .map((result) => `${formatCommand(result.argv)} => ${result.exitCode}`)
              .join("; ")}`,
      ),
    ],
    passed,
    riskFlags: failedCommands.map((result) =>
      riskFlag("failed_first_tree_command", `first-tree ${formatCommand(result.argv)} exited ${result.exitCode}`),
    ),
    scores: {
      outcome_pass: outcomePass,
      process_pass: processPass,
      risk_pass: riskPass,
      routing_pass: routingPass,
    },
  };
}

function validationRows(validation: FixtureValidation): string {
  return [
    `- ok: ${markdownBool(validation.ok)}`,
    `- domainNodeCount: ${validation.domainNodeCount}`,
    `- minDepthOk: ${markdownBool(validation.minDepthOk)}`,
    `- requiredFilesOk: ${markdownBool(validation.requiredFilesOk)}`,
    `- verifyExitCode: ${validation.verifyResult ? validation.verifyResult.exitCode : "n/a"}`,
    ...validation.errors.map((error) => `- error: ${error}`),
  ].join("\n");
}

function commandResultRows(metrics: EvalMetrics): string {
  if (metrics.firstTreeCommandResults.length === 0) return "- none";
  return metrics.firstTreeCommandResults
    .map((result) => `- first-tree ${formatCommand(result.argv)}: exit=${result.exitCode}`)
    .join("\n");
}

function expectedFactRows(metrics: EvalMetrics): string {
  if (metrics.expectedFactHits.length === 0) return "- none";
  return metrics.expectedFactHits.map((fact) => `- ${fact}`).join("\n");
}

export function writeCaseSummaries(summary: CaseRunSummary): void {
  writeGradingJson(summary.gradingJsonPath, summary.grading);
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const drift = summary.driftNote ? `\n## Drift Evidence\n\n${summary.driftNote}\n` : "";
  const markdown = `# first-tree-read Eval: ${summary.caseId}

## Result

- passed: ${markdownBool(summary.passed)}
- expectedTrigger: ${markdownBool(summary.expectedTrigger)}
- readMode: ${summary.readMode}
- skillHit: ${markdownBool(summary.metrics.skillHit)}
- skillFileReadObserved: ${markdownBool(summary.metrics.skillFileReadObserved)}
- expectedFactsObserved: ${markdownBool(summary.metrics.expectedFactsObserved)}
- helpSucceeded: ${markdownBool(summary.metrics.helpSucceeded)}
- selectionSucceeded: ${markdownBool(summary.metrics.selectionSucceeded)}
- readHelpSucceeded: ${markdownBool(summary.metrics.readHelpSucceeded)}
- readActivationCalls: ${summary.metrics.readActivationCalls}
- readActivationSucceeded: ${markdownBool(summary.metrics.readActivationSucceeded)}
- byoReadSequenceOk: ${markdownBool(summary.metrics.byoReadSequenceOk)}
- byoSelectorsNoPull: ${markdownBool(summary.metrics.byoSelectorsNoPull)}
- byoSnapshotDetached: ${markdownBool(summary.metrics.byoSnapshotDetached)}
- byoSnapshotExactHeadConsistent: ${markdownBool(summary.metrics.byoSnapshotExactHeadConsistent)}
- modelFirstTreeCommandsOk: ${markdownBool(summary.metrics.modelFirstTreeCommandsOk)}
- firstTreeCalls: ${summary.metrics.firstTreeCalls}
- runnerExitCode: ${summary.metrics.runnerExitCode === null ? "n/a" : summary.metrics.runnerExitCode}
- turns: ${summary.turns ?? "n/a"}
- firstResponseLatencyMs: ${summary.firstResponseLatencyMs ?? "n/a"}
- gradingJsonPath: \`${summary.gradingJsonPath}\`

## Grading

${gradingMarkdownRows(summary.grading)}

## Prompt

\`\`\`text
${summary.prompt}
\`\`\`

## Fixture Validation

${validationRows(summary.fixtureValidation)}

## Expected Fact Hits

${expectedFactRows(summary.metrics)}

## first-tree Command Results

${commandResultRows(summary.metrics)}
${drift}
## Paths

- runRoot: \`${summary.runRoot}\`
- workspacePath: \`${summary.workspacePath}\`
`;

  writeFileSync(summary.summaryMdPath, markdown, "utf8");
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

export function formatSummaryTable(batch: BatchSummary): string {
  const rows = batch.cases.map((summary) => [
    summary.caseId,
    String(summary.expectedTrigger),
    String(summary.metrics.skillHit),
    String(summary.metrics.firstTreeCalls),
    String(summary.metrics.skillFileReadObserved),
    String(summary.metrics.expectedFactsObserved),
    String(summary.metrics.helpSucceeded),
    String(summary.metrics.selectionSucceeded),
    String(summary.metrics.modelFirstTreeCommandsOk),
    String(summary.passed),
  ]);
  const header = [
    "case_id",
    "expected_trigger",
    "skill_hit",
    "first_tree_calls",
    "skill_file_read",
    "expected_facts_observed",
    "helpSucceeded",
    "selectionSucceeded",
    "modelFirstTreeCommandsOk",
    "passed",
  ];
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

export function buildBatchSummary(cases: readonly CaseRunSummary[], runStartedAt: string): BatchSummary {
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
