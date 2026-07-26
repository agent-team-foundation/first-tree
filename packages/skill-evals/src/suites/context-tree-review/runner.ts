import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { appendEvent, isRecord, readEvents } from "../../core/events.js";
import { deriveRunObservability } from "../../core/observability.js";
import { createRunPaths, writeShellPathBootstrap } from "../../core/paths.js";
import { runAgentProvider } from "../../core/provider/index.js";
import { createEvalReporter } from "../../core/reporter.js";
import { createFirstTreeShim } from "../../core/shims/first-tree.js";
import { createGhShim } from "../../core/shims/gh.js";
import { createGlabShim } from "../../core/shims/glab.js";
import { inspectFixtureIntegrity, setupFixture } from "./fixture.js";
import { createContextTreeReviewGitShim } from "./git-shim.js";
import { deriveGitlabReviewBehavior, gradeGitlabReviewBehavior } from "./gitlab-behavior-grader.js";
import { casePassed, deriveMetrics } from "./grader.js";
import { buildGitlabGrading, buildGrading, writeCaseSummaries } from "./summary.js";
import type { CaseRunSummary, CliOptions, ContextTreeReviewEvalCase } from "./types.js";

export async function runContextTreeReviewCase(
  packageRoot: string,
  evalCase: ContextTreeReviewEvalCase,
  options: CliOptions,
  runStartedAt: string,
): Promise<CaseRunSummary> {
  const startedAt = new Date().toISOString();
  const paths = createRunPaths({ caseId: evalCase.id, packageRoot, startedAt });
  const reporter = createEvalReporter(evalCase.id, options.verbose);
  appendEvent(paths.eventsPath, { caseId: evalCase.id, runStartedAt, type: "case_started" });
  reporter.caseStarted();
  const fixture = setupFixture(evalCase, paths);
  const modelPaths = { ...paths, binDir: join(paths.workspacePath, ".first-tree-eval", "bin") };
  mkdirSync(modelPaths.binDir, { recursive: true });
  createContextTreeReviewGitShim(modelPaths, { reviewFixturePath: fixture.fixturePath });
  createFirstTreeShim(modelPaths, {
    modelVerifyMode: "real",
    reviewFixturePath: fixture.fixturePath,
    reviewVerifyRunnerPath: fixture.verifyRunnerPath,
  });
  if (evalCase.forgeProvider === "gitlab") {
    createGhShim(modelPaths);
    createGlabShim(modelPaths, { reviewFixturePath: fixture.fixturePath });
  } else {
    createGhShim(modelPaths, { reviewFixturePath: fixture.fixturePath });
  }
  writeShellPathBootstrap(modelPaths, {
    FIRST_TREE_AGENT_ID: fixture.expectation.reviewerAgentUuid,
    FIRST_TREE_CHAT_ID: fixture.expectation.chatId,
    FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE: fixture.expectation.runtimeSessionTokenFile,
  });
  const runner = await runAgentProvider(
    {
      caseId: evalCase.id,
      claudeBin: options.claudeBin,
      codexBin: options.codexBin,
      model: options.model,
      prompt: evalCase.prompt,
      provider: options.provider,
      verbose: options.verbose,
    },
    { paths: modelPaths, reporter },
  );
  const events = readEvents(paths.eventsPath);
  const metrics = deriveMetrics(
    events,
    evalCase,
    fixture.expectation,
    inspectFixtureIntegrity(fixture),
    runner.exitCode,
  );
  const workflowPassed = casePassed(evalCase, metrics);
  const gitlabBehavior =
    evalCase.forgeProvider === "gitlab" ? deriveGitlabReviewBehavior(events, metrics, fixture.expectation) : [];
  const gitlabBehaviorGrade = gradeGitlabReviewBehavior(gitlabBehavior);
  const blockedGlabAttempts = events.filter(
    (event) =>
      isRecord(event) &&
      ((event.type === "glab_result" && (event.blockedByEval === true || event.reviewFixtureViolation === true)) ||
        (event.type === "first_tree_result" && event.gitlabReviewFixtureViolation === true)),
  ).length;
  const grading =
    evalCase.forgeProvider === "gitlab"
      ? buildGitlabGrading(evalCase, metrics, workflowPassed, gitlabBehavior, gitlabBehaviorGrade, blockedGlabAttempts)
      : buildGrading(evalCase, metrics, workflowPassed);
  const passed = grading.passed;
  const observability = deriveRunObservability(events);
  const summary: CaseRunSummary = {
    caseId: evalCase.id,
    driftNote: null,
    expectedAction: evalCase.expected.action,
    firstResponseLatencyMs: observability.firstResponseLatencyMs,
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
  appendEvent(paths.eventsPath, { caseId: evalCase.id, passed, type: "case_finished" });
  reporter.caseFinished(passed);
  return summary;
}
