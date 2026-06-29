import { readFileSync } from "node:fs";
import { join } from "node:path";

import { appendEvent } from "../../core/events.js";
import { createCodexJudgeProvider } from "../../core/judge/codex.js";
import { evaluateJudgeOutput, parseJudgeJson } from "../../core/judge/schema.js";
import type { JudgeEvaluation, JudgeProvider, JudgeProviderResponse } from "../../core/judge/types.js";
import { createRunPaths } from "../../core/paths.js";
import type { QualityJudgeRunResult } from "../../core/result-schema.js";
import { runFirstTreeWelcomeGate } from "../first-tree-welcome/index.js";
import { FIRST_TREE_WELCOME_QUALITY_DEFINITION } from "../first-tree-welcome/quality.js";
import type { CaseRunSummary as WelcomeCaseRunSummary } from "../first-tree-welcome/types.js";
import { runFirstTreeWriteGate } from "../first-tree-write/index.js";
import { FIRST_TREE_WRITE_QUALITY_DEFINITION } from "../first-tree-write/quality.js";
import type { CaseRunSummary as WriteCaseRunSummary } from "../first-tree-write/types.js";
import { buildQualityBatchSummary, writeQualityCaseSummaries } from "./summary.js";
import type {
  QualityArtifactInput,
  QualityBatchSummary,
  QualityCaseDefinition,
  QualityCaseRunSummary,
  QualityRunOptions,
} from "./types.js";

const QUALITY_DEFINITIONS: readonly QualityCaseDefinition[] = [
  FIRST_TREE_WRITE_QUALITY_DEFINITION,
  FIRST_TREE_WELCOME_QUALITY_DEFINITION,
];

function selectedDefinitions(options: QualityRunOptions): readonly QualityCaseDefinition[] {
  let definitions = QUALITY_DEFINITIONS;
  if (options.suite !== null) {
    definitions = definitions.filter((definition) => definition.evalCase.skill === options.suite);
  }
  if (options.caseId !== null) {
    definitions = definitions.filter((definition) => definition.evalCase.id === options.caseId);
  }
  if (definitions.length === 0) {
    const suiteSuffix = options.suite === null ? "" : ` for suite ${options.suite}`;
    const caseSuffix = options.caseId === null ? "" : ` and case ${options.caseId}`;
    throw new Error(`No quality cases found${suiteSuffix}${caseSuffix}.`);
  }
  return definitions;
}

function failedJudgeResult(
  definition: QualityCaseDefinition,
  rawOutput: string,
  error: unknown,
  response: JudgeProviderResponse | null,
): QualityJudgeRunResult {
  const message = error instanceof Error ? error.message : String(error);
  const thresholds = Object.fromEntries(definition.dimensions.map((dimension) => [dimension.key, dimension.threshold]));
  return {
    caseId: definition.evalCase.id,
    cost_usd: response?.cost_usd ?? null,
    duration_ms: response?.duration_ms ?? 0,
    failures: [message],
    judge_model: response?.judge_model ?? "unknown",
    judge_provider: response?.provider ?? "unknown",
    judge_reasoning: null,
    judge_scores: null,
    passed: false,
    raw_output: rawOutput,
    runId: definition.evalCase.id,
    skill: definition.evalCase.skill,
    thresholds,
    tier: "quality",
  };
}

function passedJudgeResult(
  definition: QualityCaseDefinition,
  response: JudgeProviderResponse,
  evaluation: JudgeEvaluation,
): QualityJudgeRunResult {
  return {
    caseId: definition.evalCase.id,
    cost_usd: response.cost_usd,
    duration_ms: response.duration_ms,
    failures: evaluation.failures,
    judge_model: response.judge_model,
    judge_provider: response.provider,
    judge_reasoning: evaluation.judge_reasoning,
    judge_scores: evaluation.judge_scores,
    passed: evaluation.passed,
    raw_output: response.raw_output,
    runId: definition.evalCase.id,
    skill: definition.evalCase.skill,
    thresholds: evaluation.thresholds,
    tier: "quality",
  };
}

function deterministicGateFailure(
  definition: QualityCaseDefinition,
  input: QualityArtifactInput,
): QualityJudgeRunResult {
  const thresholds = Object.fromEntries(definition.dimensions.map((dimension) => [dimension.key, dimension.threshold]));
  return {
    caseId: definition.evalCase.id,
    cost_usd: null,
    duration_ms: 0,
    failures: [`deterministic gate ${input.gateCaseId} failed; judge was not run`],
    judge_model: "not-run",
    judge_provider: "not-run",
    judge_reasoning: null,
    judge_scores: null,
    passed: false,
    raw_output: "",
    runId: definition.evalCase.id,
    skill: definition.evalCase.skill,
    thresholds,
    tier: "quality",
  };
}

function readFixtureFile(path: string): string {
  return readFileSync(path, "utf8");
}

function writeQualityInput(gateSummary: WriteCaseRunSummary): QualityArtifactInput {
  return {
    artifact:
      gateSummary.metrics.treeDiff.trim().length > 0
        ? gateSummary.metrics.treeDiff
        : `Final response:\n${gateSummary.metrics.finalResponse}`,
    deterministicGatePassed: gateSummary.passed,
    gateCaseId: gateSummary.caseId,
    gateRunRoot: gateSummary.runRoot,
    gateSummaryJsonPath: gateSummary.summaryJsonPath,
    gateSummaryMdPath: gateSummary.summaryMdPath,
    source: readFixtureFile(join(gateSummary.workspacePath, "source-artifacts", "durable-decision-note.md")),
  };
}

function welcomeEvidenceSource(gateSummary: WelcomeCaseRunSummary): string {
  const sourceRepoPath = join(gateSummary.workspacePath, "source-repo");
  const contextTreePath = join(gateSummary.workspacePath, "context-tree");
  return [
    "Setup state: readable source repo and populated Context Tree.",
    "",
    "Repo README:",
    readFixtureFile(join(sourceRepoPath, "README.md")),
    "",
    "Session source evidence:",
    readFixtureFile(join(sourceRepoPath, "src", "auth", "session.ts")),
    "",
    "Context Tree checkout reliability node:",
    readFixtureFile(join(contextTreePath, "product", "checkout-reliability.md")),
  ].join("\n");
}

function welcomeQualityInput(gateSummary: WelcomeCaseRunSummary): QualityArtifactInput {
  return {
    artifact: [
      "Chat ask/send text:",
      gateSummary.metrics.chatText.trim() || "_none_",
      "",
      "Final response:",
      gateSummary.metrics.finalResponse.trim() || "_none_",
    ].join("\n"),
    deterministicGatePassed: gateSummary.passed,
    gateCaseId: gateSummary.caseId,
    gateRunRoot: gateSummary.runRoot,
    gateSummaryJsonPath: gateSummary.summaryJsonPath,
    gateSummaryMdPath: gateSummary.summaryMdPath,
    source: welcomeEvidenceSource(gateSummary),
  };
}

async function collectLiveQualityInput(
  packageRoot: string,
  definition: QualityCaseDefinition,
  options: QualityRunOptions,
): Promise<QualityArtifactInput> {
  if (definition.evalCase.skill === "first-tree-write") {
    const batch = await runFirstTreeWriteGate(packageRoot, {
      caseId: definition.gateCaseId,
      codexBin: options.codexBin,
      json: false,
      model: options.model,
      verbose: options.verbose,
    });
    const summary = batch.cases[0];
    if (summary === undefined) {
      throw new Error(`No gate summary produced for ${definition.gateCaseId}.`);
    }
    return writeQualityInput(summary);
  }

  if (definition.evalCase.skill === "first-tree-welcome") {
    const batch = await runFirstTreeWelcomeGate(packageRoot, {
      caseId: definition.gateCaseId,
      codexBin: options.codexBin,
      json: false,
      model: options.model,
      verbose: options.verbose,
    });
    const summary = batch.cases[0];
    if (summary === undefined) {
      throw new Error(`No gate summary produced for ${definition.gateCaseId}.`);
    }
    return welcomeQualityInput(summary);
  }

  throw new Error(`Unsupported quality suite: ${definition.evalCase.skill}.`);
}

async function runQualityCase(
  packageRoot: string,
  definition: QualityCaseDefinition,
  options: QualityRunOptions,
  providerOverride?: JudgeProvider,
  inputOverride?: ReadonlyMap<string, QualityArtifactInput>,
): Promise<QualityCaseRunSummary> {
  const startedAt = new Date().toISOString();
  const paths = createRunPaths({
    caseId: definition.evalCase.id,
    packageRoot,
    startedAt,
  });
  const input =
    inputOverride?.get(definition.evalCase.id) ?? (await collectLiveQualityInput(packageRoot, definition, options));
  const judgePrompt = definition.buildJudgePrompt(input);
  const judgePromptPath = join(paths.runRoot, "judge-prompt.txt");
  const judgeRawOutputPath = join(paths.runRoot, "judge-raw-output.txt");

  appendEvent(paths.eventsPath, {
    caseId: definition.evalCase.id,
    skill: definition.evalCase.skill,
    type: "quality_case_started",
  });

  const provider =
    providerOverride ??
    createCodexJudgeProvider({
      bin: options.judgeBin,
      eventsPath: paths.eventsPath,
      model: options.judgeModel,
      paths,
    });

  let result: QualityJudgeRunResult;
  let response: JudgeProviderResponse | null = null;
  if (!input.deterministicGatePassed) {
    result = deterministicGateFailure(definition, input);
  } else {
    try {
      response = await provider.judge({
        caseId: definition.evalCase.id,
        dimensions: definition.dimensions,
        prompt: judgePrompt,
      });
      const parsed = parseJudgeJson(response.raw_output, definition.dimensions);
      result = passedJudgeResult(definition, response, evaluateJudgeOutput(parsed, definition.dimensions));
    } catch (error: unknown) {
      result = failedJudgeResult(definition, response?.raw_output ?? "", error, response);
    }
  }

  const summary: QualityCaseRunSummary = {
    ...result,
    artifact: input.artifact,
    deterministicGatePassed: input.deterministicGatePassed,
    dimensions: definition.dimensions,
    gateCaseId: input.gateCaseId,
    gateRunRoot: input.gateRunRoot,
    gateSummaryJsonPath: input.gateSummaryJsonPath,
    gateSummaryMdPath: input.gateSummaryMdPath,
    judgePrompt,
    judgePromptPath,
    judgeRawOutputPath,
    runRoot: paths.runRoot,
    source: input.source,
    startedAt,
    summaryJsonPath: paths.summaryJsonPath,
    summaryMdPath: paths.summaryMdPath,
  };

  appendEvent(paths.eventsPath, {
    caseId: definition.evalCase.id,
    failures: result.failures,
    passed: result.passed,
    type: "quality_case_finished",
  });

  writeQualityCaseSummaries(summary);
  if (options.verbose) {
    process.stderr.write(`[${definition.evalCase.id}] quality ${result.passed ? "passed" : "failed"}\n`);
  }
  return summary;
}

export async function runQualityEval(
  packageRoot: string,
  options: QualityRunOptions,
  providerOverride?: JudgeProvider,
  inputOverride?: ReadonlyMap<string, QualityArtifactInput>,
): Promise<QualityBatchSummary> {
  const runStartedAt = new Date().toISOString();
  const cases: QualityCaseRunSummary[] = [];
  for (const definition of selectedDefinitions(options)) {
    cases.push(await runQualityCase(packageRoot, definition, options, providerOverride, inputOverride));
  }
  return buildQualityBatchSummary(cases, runStartedAt);
}

export { formatQualitySummaryTable } from "./summary.js";
