import { join } from "node:path";
import { appendEvent, readEvents } from "../../core/events.js";
import { deriveRunObservability } from "../../core/observability.js";
import { createRunPaths } from "../../core/paths.js";
import { runAgentProvider } from "../../core/provider/index.js";
import { createEvalReporter } from "../../core/reporter.js";
import { createFirstTreeShim } from "../../core/shims/first-tree.js";
import { createFirstTreeStagingShim } from "../../core/shims/first-tree-staging.js";
import { createGhShim } from "../../core/shims/gh.js";
import { SEED_EVAL_TEAM_ID, setupFixture, validateFixture } from "./fixture.js";
import { casePassed, deriveMetrics, driftNote } from "./grader.js";
import { buildGrading, writeCaseSummaries } from "./summary.js";
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

  const seedPreflight =
    evalCase.fixture.invocationMode === "portable"
      ? {
          branch: "main",
          outcome: evalCase.fixture.seedAuthority === "member" ? ("needs-admin" as const) : ("bound" as const),
          repo:
            evalCase.fixture.seedBindingState === "different"
              ? "https://git.example.invalid/other-team/context-tree.git"
              : join(paths.runRoot, "context-tree-origin.git"),
          teamId: SEED_EVAL_TEAM_ID,
        }
      : undefined;
  createFirstTreeShim(paths, { seedPreflight });
  createFirstTreeStagingShim(paths);
  createGhShim(paths);
  const contextTreePath = setupFixture(evalCase, paths, reporter);
  const fixtureValidation = validateFixture(paths, contextTreePath, evalCase, options.verbose, reporter);
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
