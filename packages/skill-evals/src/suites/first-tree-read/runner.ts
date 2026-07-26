import { appendEvent, readEvents } from "../../core/events.js";
import { deriveRunObservability } from "../../core/observability.js";
import { createRunPaths } from "../../core/paths.js";
import { runAgentProvider } from "../../core/provider/index.js";
import { createEvalReporter } from "../../core/reporter.js";
import { createFirstTreeShim } from "../../core/shims/first-tree.js";
import { setupFixture, validateFixture } from "./fixture.js";
import { casePassed, deriveMetrics } from "./metrics.js";
import { buildGrading, driftNote, writeCaseSummaries } from "./summary.js";
import type { CaseRunSummary, CliOptions, FirstTreeReadEvalCase } from "./types.js";

export async function runFirstTreeReadCase(
  packageRoot: string,
  evalCase: FirstTreeReadEvalCase,
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

  createFirstTreeShim(paths);
  const contextTreePath = setupFixture(evalCase, paths, reporter);
  const fixtureValidation = validateFixture(paths, contextTreePath, evalCase.id, options.verbose, reporter);
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
  const runnerExitCode = runnerResult.exitCode;
  const events = readEvents(paths.eventsPath);
  const metrics = deriveMetrics(events, fixtureValidation, runnerExitCode, evalCase.expectedFacts);
  const passed = casePassed(evalCase.expectedTrigger, metrics, evalCase.readMode);
  const grading = buildGrading(evalCase.id, metrics, evalCase.expectedTrigger, passed, evalCase.readMode);
  const observability = deriveRunObservability(events);

  const summary: CaseRunSummary = {
    caseId: evalCase.id,
    driftNote: driftNote(metrics, evalCase.expectedTrigger, evalCase.readMode),
    expectedTrigger: evalCase.expectedTrigger,
    firstResponseLatencyMs: observability.firstResponseLatencyMs,
    fixtureValidation,
    grading,
    gradingJsonPath: paths.gradingJsonPath,
    metrics,
    passed,
    prompt: evalCase.prompt,
    readMode: evalCase.readMode,
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
