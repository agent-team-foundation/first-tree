import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeText } from "../../core/commands.js";
import { appendEvent, readEvents } from "../../core/events.js";
import { deriveRunObservability } from "../../core/observability.js";
import { createRunPaths } from "../../core/paths.js";
import { runAgentProvider } from "../../core/provider/index.js";
import { createEvalReporter } from "../../core/reporter.js";
import { createFirstTreeShim } from "../../core/shims/first-tree.js";
import { createGhShim } from "../../core/shims/gh.js";
import type { RunPaths } from "../../core/types.js";
import { inspectFixtureIntegrity, setupFixture } from "./fixture.js";
import { casePassed, deriveMetrics } from "./grader.js";
import { buildGrading, writeCaseSummaries } from "./summary.js";
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
  createFirstTreeShim(modelPaths, {
    modelVerifyMode: "real",
    recordedModelVerifyCwd: fixture.reviewWorktreePath,
    recordedModelVerifyHead: fixture.expectation.headOid,
    recordedModelVerifyPath: fixture.verifyResultPath,
    reviewFixturePath: fixture.fixturePath,
  });
  createGhShim(modelPaths, { reviewFixturePath: fixture.fixturePath });
  const runtimeTokenPath = join(paths.workspacePath, ".first-tree-eval", "runtime-session-token");
  const runtimeEnvironment = {
    CONTEXT_REVIEW_RUN_ID: fixture.expectation.runId,
    FIRST_TREE_AGENT_ID: fixture.expectation.agentId,
    FIRST_TREE_CHAT_ID: fixture.expectation.chatId,
    FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE: runtimeTokenPath,
  } as const;
  writeRuntimeEnvironment(modelPaths, runtimeEnvironment, runtimeTokenPath);
  const runner = await runAgentProvider(
    {
      caseId: evalCase.id,
      claudeBin: options.claudeBin,
      codexBin: options.codexBin,
      model: options.model,
      prompt:
        `${evalCase.prompt}\n\nExact review head: ${fixture.expectation.headOid}\n` +
        `Expected reviewer agent: ${fixture.expectation.agentId}\n` +
        `Before any PR read, prove runtime identity without printing values: ` +
        `test -n "$FIRST_TREE_CHAT_ID"; test "$FIRST_TREE_AGENT_ID" = "${fixture.expectation.agentId}"; ` +
        `test -r "$FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE". Then read the distinct local GitHub identity with exactly ` +
        `gh api user --jq .login. Use only standalone no-output named tests; do not add conditional environment probes. ` +
        `Check the trusted source and PR refs only through fetch followed by an exact rev-parse FETCH_HEAD test. ` +
        `Run each fetch and each test as a separate synchronous command, and wait for the fetch to exit 0 before starting its test; ` +
        `never issue them in parallel, in one tool-call batch, in one shell command, or in the background. ` +
        `Never run ls-remote, awk, another parser, env, printenv, set, shell tracing, or any pipeline.`,
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
  const passed = casePassed(evalCase, metrics);
  const grading = buildGrading(evalCase, metrics, passed);
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

function writeRuntimeEnvironment(
  paths: RunPaths,
  environment: Readonly<Record<string, string>>,
  runtimeTokenPath: string,
): void {
  writeText(runtimeTokenPath, "eval-runtime-session-proof\n");
  const exports = Object.entries(environment)
    .map(([key, value]) => `export ${key}='${value.replaceAll("'", "'\\''")}'`)
    .join("\n");
  for (const file of [".zshenv", ".zprofile", ".bash_profile", "bash-env", "sh-env"]) {
    appendFileSync(join(paths.shellEnvDir, file), `${exports}\n`, "utf8");
  }
}
