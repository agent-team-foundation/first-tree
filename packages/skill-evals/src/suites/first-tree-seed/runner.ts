import { appendEvent, readEvents } from "../../core/events.js";
import { createRunPaths } from "../../core/paths.js";
import { runCodexProvider } from "../../core/provider/codex.js";
import { createEvalReporter } from "../../core/reporter.js";
import { createFirstTreeShim } from "../../core/shims/first-tree.js";
import { createFirstTreeStagingShim } from "../../core/shims/first-tree-staging.js";
import { createGhShim } from "../../core/shims/gh.js";
import { setupFixture, validateFixture } from "./fixture.js";
import { casePassed, deriveMetrics, driftNote } from "./grader.js";
import { writeCaseSummaries } from "./summary.js";
import type { CaseRunSummary, CliOptions, FirstTreeSeedEvalCase } from "./types.js";

export async function runFirstTreeSeedCase(
  packageRoot: string,
  evalCase: FirstTreeSeedEvalCase,
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
  const fixtureValidation = validateFixture(paths, contextTreePath, evalCase, options.verbose, reporter);
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

  const metrics = deriveMetrics(
    readEvents(paths.eventsPath),
    evalCase,
    fixtureValidation,
    runnerExitCode,
    paths,
    contextTreePath,
  );
  const passed = casePassed(evalCase, metrics);

  const summary: CaseRunSummary = {
    caseId: evalCase.id,
    driftNote: driftNote(evalCase, metrics),
    expectedAction: evalCase.expected.action,
    fixtureValidation,
    metrics,
    passed,
    prompt: evalCase.prompt,
    runRoot: paths.runRoot,
    startedAt,
    summaryJsonPath: paths.summaryJsonPath,
    summaryMdPath: paths.summaryMdPath,
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
