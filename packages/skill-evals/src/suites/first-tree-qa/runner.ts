import { appendEvent, readEvents } from "../../core/events.js";
import { deriveRunObservability } from "../../core/observability.js";
import { createRunPaths } from "../../core/paths.js";
import { runAgentProvider } from "../../core/provider/index.js";
import { createEvalReporter } from "../../core/reporter.js";
import { setupFixture, validateFixture } from "./fixture.js";
import { buildGrading, casePassed, deriveMetrics, driftNote } from "./grader.js";
import { writeCaseSummaries } from "./summary.js";
import type { CaseRunSummary, CliOptions, FirstTreeQaEvalCase } from "./types.js";

export async function runFirstTreeQaCase(
  packageRoot: string,
  evalCase: FirstTreeQaEvalCase,
  options: CliOptions,
  runStartedAt: string,
): Promise<CaseRunSummary> {
  const startedAt = new Date().toISOString();
  const paths = createRunPaths({ caseId: evalCase.id, packageRoot, startedAt });
  const reporter = createEvalReporter(evalCase.id, options.verbose);
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    runStartedAt,
    type: "case_started",
  });
  reporter.caseStarted();

  const sourceRepoPath = setupFixture(evalCase, paths, reporter);
  const fixtureValidation = validateFixture(paths, sourceRepoPath);
  const runnerResult = await runAgentProvider(
    {
      caseId: evalCase.id,
      claudeBin: options.claudeBin,
      codexBin: options.codexBin,
      model: options.model,
      prompt: evalCase.prompt,
      provider: options.provider,
      verbose: options.verbose,
    },
    { paths, reporter },
  );
  const events = readEvents(paths.eventsPath);
  const metrics = deriveMetrics(events, evalCase, fixtureValidation, runnerResult.exitCode, paths);
  const passed = casePassed(evalCase, metrics);
  const grading = buildGrading(evalCase, metrics);
  const observability = deriveRunObservability(events);
  const summary: CaseRunSummary = {
    caseId: evalCase.id,
    driftNote: driftNote(evalCase, metrics),
    expectedAction: evalCase.expected.status,
    firstResponseLatencyMs: observability.firstResponseLatencyMs,
    fixtureValidation,
    grading,
    gradingJsonPath: paths.gradingJsonPath,
    metrics,
    passed,
    prompt: evalCase.prompt,
    runRoot: paths.runRoot,
    startedAt,
    summaryJsonPath: paths.summaryJsonPath,
    summaryMdPath: paths.summaryMdPath,
    turns: observability.turns,
    workspacePath: paths.workspacePath,
  };
  writeCaseSummaries(summary);
  reporter.summaryWritten(paths.summaryJsonPath, paths.summaryMdPath);
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    passed,
    summaryJsonPath: paths.summaryJsonPath,
    summaryMdPath: paths.summaryMdPath,
    type: "case_finished",
  });
  reporter.caseFinished(passed);
  return summary;
}
