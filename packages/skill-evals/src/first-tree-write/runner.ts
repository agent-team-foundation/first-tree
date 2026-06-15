import { appendEvent, readEvents } from "../shared/events.js";
import { createEvalReporter } from "../shared/reporter.js";
import { runCodex } from "../shared/runner.js";
import { createFirstTreeShim, createRunPaths, setupFixture, validateFixture } from "./fixture.js";
import { casePassed, deriveMetrics, fixtureOnlyPassed, withAccidentalWriteHit } from "./metrics.js";
import { driftNote, writeCaseSummaries } from "./summary.js";
import type { CaseRunSummary, CliOptions, FirstTreeWriteEvalCase } from "./types.js";

function allowReadSkillTreeLookupOnNonTrigger(evalCase: FirstTreeWriteEvalCase): boolean {
  return evalCase.installedSkillSet === "read-write";
}

export async function runFirstTreeWriteCase(
  packageRoot: string,
  evalCase: FirstTreeWriteEvalCase,
  options: CliOptions,
  runStartedAt: string,
): Promise<CaseRunSummary> {
  const startedAt = new Date().toISOString();
  const paths = createRunPaths(packageRoot, evalCase, startedAt);
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
  const runnerExitCode = options.validateFixtures
    ? 0
    : await runCodex(options, evalCase.id, evalCase.prompt, paths, reporter);
  const metrics = withAccidentalWriteHit(
    deriveMetrics(readEvents(paths.eventsPath), fixtureValidation, runnerExitCode, evalCase.expectedTargetPath),
    evalCase.expectedTrigger,
  );
  const passed = options.validateFixtures
    ? fixtureOnlyPassed(fixtureValidation)
    : casePassed(evalCase.expectedTrigger, metrics, {
        allowReadSkillTreeLookupOnNonTrigger: allowReadSkillTreeLookupOnNonTrigger(evalCase),
      });

  const summary: CaseRunSummary = {
    caseId: evalCase.id,
    driftNote: driftNote(metrics, evalCase.expectedTrigger),
    expectedTargetPath: evalCase.expectedTargetPath,
    expectedTrigger: evalCase.expectedTrigger,
    fixtureValidation,
    installedSkillSet: evalCase.installedSkillSet,
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
