import { appendEvent, readEvents } from "../../core/events.js";
import { deriveRunObservability } from "../../core/observability.js";
import { createRunPaths } from "../../core/paths.js";
import { runCodexProvider } from "../../core/provider/codex.js";
import { createEvalReporter } from "../../core/reporter.js";
import { createFirstTreeShim } from "../../core/shims/first-tree.js";
import { createFirstTreeStagingShim } from "../../core/shims/first-tree-staging.js";
import { createGhShim } from "../../core/shims/gh.js";
import { setupFixture, validateFixture } from "./fixture.js";
import { casePassed, deriveMetrics, driftNote } from "./grader.js";
import { buildGrading, writeCaseSummaries } from "./summary.js";
import type { CaseRunSummary, CliOptions, FirstTreeWelcomeEvalCase } from "./types.js";

export async function runFirstTreeWelcomeCase(
  packageRoot: string,
  evalCase: FirstTreeWelcomeEvalCase,
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
  createFirstTreeStagingShim(paths);
  createGhShim(paths);
  const contextTreePath = setupFixture(evalCase, paths, reporter);
  const fixtureValidation = validateFixture(paths, contextTreePath, evalCase.id, options.verbose, reporter);
  const runnerExitCode = await runCodexProvider(
    {
      bin: options.codexBin,
      caseId: evalCase.id,
      model: options.model,
      prompt: evalCase.prompt,
      verbose: options.verbose,
    },
    { paths, reporter },
  );

  const events = readEvents(paths.eventsPath);
  const metrics = deriveMetrics(events, evalCase, fixtureValidation, runnerExitCode, paths, contextTreePath);
  const passed = casePassed(evalCase, metrics);
  const grading = buildGrading(evalCase, metrics, passed);
  const observability = deriveRunObservability(events);

  const summary: CaseRunSummary = {
    caseId: evalCase.id,
    driftNote: driftNote(evalCase, metrics),
    expectedAction: evalCase.expected.action,
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
