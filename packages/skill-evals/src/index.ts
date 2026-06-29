import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SHIPPED_SKILLS, type ShippedSkillName } from "./core/case-schema.js";
import { type SkillEvalSuiteDefinition, validateCoverageMatrix } from "./core/coverage.js";
import { isRecord } from "./core/events.js";
import { gradingFailureMessages } from "./core/grading.js";
import {
  appendResultStoreEntries,
  compareResultGroups,
  createRunGroupId,
  formatCompareSummary,
  latestRunGroups,
  type ResultStoreEntry,
  readGitInfo,
  readResultStore,
} from "./core/result-store.js";
import { changedFilesFromGit, formatSelectionSummary, selectSkillEvalRecommendations } from "./core/select.js";
import { readSkillFrontmatter } from "./core/skills/frontmatter.js";
import { formatFirstTreeReadGateSummary, runFirstTreeReadGate } from "./suites/first-tree-read/index.js";
import type { BatchSummary as ReadBatchSummary } from "./suites/first-tree-read/types.js";
import { formatFirstTreeSeedGateSummary, runFirstTreeSeedGate } from "./suites/first-tree-seed/index.js";
import type { BatchSummary as SeedBatchSummary } from "./suites/first-tree-seed/types.js";
import { formatFirstTreeWelcomeGateSummary, runFirstTreeWelcomeGate } from "./suites/first-tree-welcome/index.js";
import type { BatchSummary as WelcomeBatchSummary } from "./suites/first-tree-welcome/types.js";
import { formatFirstTreeWriteGateSummary, runFirstTreeWriteGate } from "./suites/first-tree-write/index.js";
import type { BatchSummary as WriteBatchSummary } from "./suites/first-tree-write/types.js";
import { formatQualitySummaryTable, runQualityEval } from "./suites/quality/index.js";
import type { QualityBatchSummary, QualitySkillName } from "./suites/quality/types.js";
import { SKILL_EVAL_SUITES } from "./suites/registry.js";

type CliOptions = {
  base: string | null;
  caseId: string | null;
  changedFiles: readonly string[];
  codexBin: string;
  command: "compare" | "floor" | "gate" | "quality" | "select";
  currentRunGroupId: string | null;
  judgeBin: string;
  judgeModel: string | null;
  json: boolean;
  model: string | null;
  previousRunGroupId: string | null;
  suite: ShippedSkillName | null;
  verbose: boolean;
};

type FloorCheck = {
  detail: string;
  name: string;
  ok: boolean;
};

type FloorSummary = {
  checks: readonly FloorCheck[];
  failed: number;
  passed: number;
  suites: readonly string[];
};

function usage(): string {
  return `Usage:
  pnpm --filter @first-tree/skill-evals eval:floor
  pnpm --filter @first-tree/skill-evals eval:floor -- --json
  pnpm --filter @first-tree/skill-evals eval:floor -- --suite <skill>
  pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-read
  pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-write
  pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-welcome
  pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-seed
  pnpm --filter @first-tree/skill-evals eval:quality
  pnpm --filter @first-tree/skill-evals eval:quality -- --suite first-tree-write
  pnpm --filter @first-tree/skill-evals eval:select -- --base main
  pnpm --filter @first-tree/skill-evals eval:compare

Commands:
  floor                  Run no-model schema, coverage, and skill-file checks.
  gate                   Run a live model gate suite and write grading.json.
  quality                Run opt-in LLM-as-judge quality cases.
  select                 Recommend eval commands from changed files.
  compare                Compare latest result-store run groups.

Options:
  --suite <skill>        Limit per-suite floor checks to one shipped skill.
  --case <id>            Run one live gate case.
  --base <ref>           Base ref for eval:select git diff. Defaults to main.
  --changed-file <path>  Add an explicit changed file for eval:select.
  --current <run-id>     Current run group for eval:compare. Defaults to latest.
  --previous <run-id>    Previous run group for eval:compare. Defaults to previous.
  --json                 Print summary as JSON.
  --model <model>        Pass a model override to codex exec.
  --codex-bin <path>     Codex binary to execute. Defaults to CODEX_BIN or codex.
  --judge-model <model>  Judge model override. Defaults to JUDGE_MODEL, CODEX_MODEL, or provider default.
  --judge-bin <path>     Judge Codex binary. Defaults to JUDGE_CODEX_BIN, CODEX_BIN, or codex.
  --verbose              Print live readable progress to stderr.
  --help                 Show this help.
`;
}

function readOptionValue(args: readonly string[], index: number, optionName: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function parseArgs(args: readonly string[]): CliOptions {
  const normalized = args.filter((arg) => arg !== "--");
  const command = normalized[0] ?? "floor";
  if (command === "--help" || command === "-h") {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (
    command !== "floor" &&
    command !== "gate" &&
    command !== "quality" &&
    command !== "select" &&
    command !== "compare"
  ) {
    throw new Error(`Unknown command: ${command}`);
  }

  const options: CliOptions = {
    base: null,
    caseId: null,
    changedFiles: [],
    codexBin: process.env.CODEX_BIN ?? "codex",
    command,
    currentRunGroupId: null,
    judgeBin: process.env.JUDGE_CODEX_BIN ?? process.env.CODEX_BIN ?? "codex",
    judgeModel: process.env.JUDGE_MODEL ?? process.env.CODEX_MODEL ?? null,
    json: false,
    model: process.env.CODEX_MODEL ?? null,
    previousRunGroupId: null,
    suite: null,
    verbose: false,
  };

  for (let index = 1; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--case") {
      options.caseId = readOptionValue(normalized, index, "--case");
      index += 1;
      continue;
    }
    if (arg === "--base") {
      options.base = readOptionValue(normalized, index, "--base");
      index += 1;
      continue;
    }
    if (arg === "--changed-file") {
      options.changedFiles = [...options.changedFiles, readOptionValue(normalized, index, "--changed-file")];
      index += 1;
      continue;
    }
    if (arg === "--current") {
      options.currentRunGroupId = readOptionValue(normalized, index, "--current");
      index += 1;
      continue;
    }
    if (arg === "--previous") {
      options.previousRunGroupId = readOptionValue(normalized, index, "--previous");
      index += 1;
      continue;
    }
    if (arg === "--suite") {
      const suite = readOptionValue(normalized, index, "--suite");
      if (!SHIPPED_SKILLS.includes(suite as ShippedSkillName)) {
        throw new Error(`Unknown suite '${suite}'. Available suites: ${SHIPPED_SKILLS.join(", ")}`);
      }
      options.suite = suite as ShippedSkillName;
      index += 1;
      continue;
    }
    if (arg === "--model") {
      options.model = readOptionValue(normalized, index, "--model");
      index += 1;
      continue;
    }
    if (arg === "--codex-bin") {
      options.codexBin = readOptionValue(normalized, index, "--codex-bin");
      index += 1;
      continue;
    }
    if (arg === "--judge-model") {
      options.judgeModel = readOptionValue(normalized, index, "--judge-model");
      index += 1;
      continue;
    }
    if (arg === "--judge-bin") {
      options.judgeBin = readOptionValue(normalized, index, "--judge-bin");
      index += 1;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function qualitySuite(options: CliOptions): QualitySkillName | null {
  if (options.suite === null) return null;
  if (options.suite === "first-tree-write" || options.suite === "first-tree-welcome") {
    return options.suite;
  }
  throw new Error("eval:quality currently supports --suite first-tree-write or --suite first-tree-welcome.");
}

function packageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (current !== dirname(current)) {
    const packageJsonPath = `${current}/package.json`;
    if (existsSync(packageJsonPath)) {
      const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (isRecord(packageJson) && packageJson.name === "@first-tree/skill-evals") {
        return current;
      }
    }
    current = dirname(current);
  }
  throw new Error("Could not locate @first-tree/skill-evals package root.");
}

function repoRootFromPackage(packageRootPath: string): string {
  return dirname(dirname(packageRootPath));
}

function checkSkillFiles(repoRoot: string, suites: readonly SkillEvalSuiteDefinition[]): readonly FloorCheck[] {
  return suites.map((suite) => {
    const skillPath = join(repoRoot, "skills", suite.skill, "SKILL.md");
    if (!existsSync(skillPath)) {
      return {
        detail: `Missing ${skillPath}`,
        name: `${suite.skill}: skill file`,
        ok: false,
      };
    }

    try {
      const frontmatter = readSkillFrontmatter(skillPath);
      if (frontmatter.name !== suite.skill) {
        return {
          detail: `Frontmatter name is ${frontmatter.name}, expected ${suite.skill}`,
          name: `${suite.skill}: skill file`,
          ok: false,
        };
      }
      return {
        detail: frontmatter.description,
        name: `${suite.skill}: skill file`,
        ok: true,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        detail: message,
        name: `${suite.skill}: skill file`,
        ok: false,
      };
    }
  });
}

function checkCoverage(suites: readonly SkillEvalSuiteDefinition[]): FloorCheck {
  const validation = validateCoverageMatrix(suites);
  return {
    detail: validation.ok
      ? "Coverage matrix includes all shipped skills with floor and gate entries."
      : validation.errors.join("; "),
    name: "coverage matrix",
    ok: validation.ok,
  };
}

function buildFloorSummary(options: CliOptions): FloorSummary {
  const packageRootPath = packageRoot();
  const allSuites = SKILL_EVAL_SUITES;
  const selectedSuites =
    options.suite === null ? allSuites : allSuites.filter((suite) => suite.skill === options.suite);
  const checks = [checkCoverage(allSuites), ...checkSkillFiles(repoRootFromPackage(packageRootPath), selectedSuites)];
  const passed = checks.filter((check) => check.ok).length;

  return {
    checks,
    failed: checks.length - passed,
    passed,
    suites: selectedSuites.map((suite) => suite.skill),
  };
}

function formatFloorSummary(summary: FloorSummary): string {
  const lines = ["Skill Eval Floor", ""];
  for (const check of summary.checks) {
    lines.push(`${check.ok ? "PASS" : "FAIL"}  ${check.name}`);
    if (!check.ok) {
      lines.push(`      ${check.detail}`);
    }
  }
  lines.push("", `Total: ${summary.passed}/${summary.checks.length} passed`);
  return lines.join("\n");
}

function floorCheckCaseId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function floorCheckSkill(name: string): ShippedSkillName | "framework" {
  return SHIPPED_SKILLS.find((skill) => name.startsWith(`${skill}:`)) ?? "framework";
}

function writeFloorArtifact(
  packageRootPath: string,
  summary: FloorSummary,
  runGroupId: string,
): { gradingJsonPath: string | null; runRoot: string; summaryJsonPath: string; summaryMdPath: string } {
  const runRoot = join(packageRootPath, ".runs", runGroupId);
  const summaryJsonPath = join(runRoot, "summary.json");
  const summaryMdPath = join(runRoot, "summary.md");
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(summaryMdPath, `${formatFloorSummary(summary)}\n`, "utf8");
  return { gradingJsonPath: null, runRoot, summaryJsonPath, summaryMdPath };
}

function floorResultEntries(
  packageRootPath: string,
  summary: FloorSummary,
  options: {
    artifact: { gradingJsonPath: string | null; runRoot: string; summaryJsonPath: string; summaryMdPath: string };
    base: string | null;
    durationMs: number;
    runGroupId: string;
    startedAt: string;
  },
): readonly ResultStoreEntry[] {
  const git = readGitInfo(repoRootFromPackage(packageRootPath), options.base);
  return summary.checks.map((check) => ({
    artifact: options.artifact,
    caseId: floorCheckCaseId(check.name),
    command: "eval:floor",
    costUsd: null,
    durationMs: options.durationMs,
    failures: check.ok ? [] : [check.detail],
    git,
    judgeScores: null,
    model: null,
    passed: check.ok,
    provider: null,
    runGroupId: options.runGroupId,
    schemaVersion: 1,
    skill: floorCheckSkill(check.name),
    startedAt: options.startedAt,
    status: check.ok ? "passed" : "failed",
    tier: "floor",
    turns: null,
  }));
}

type GateBatchSummary = ReadBatchSummary | SeedBatchSummary | WelcomeBatchSummary | WriteBatchSummary;

function gateResultEntries(
  packageRootPath: string,
  batch: GateBatchSummary,
  suite: ShippedSkillName,
  options: CliOptions,
): readonly ResultStoreEntry[] {
  const runGroupId = createRunGroupId(batch.runStartedAt, `eval-gate-${suite}`);
  const git = readGitInfo(repoRootFromPackage(packageRootPath), options.base);
  return batch.cases.map((summary) => {
    const durationMs = Math.max(0, Date.now() - Date.parse(summary.startedAt));
    return {
      artifact: {
        gradingJsonPath: summary.gradingJsonPath,
        runRoot: summary.runRoot,
        summaryJsonPath: summary.summaryJsonPath,
        summaryMdPath: summary.summaryMdPath,
      },
      caseId: summary.caseId,
      command: "eval:gate",
      costUsd: null,
      durationMs,
      failures: summary.passed
        ? []
        : [...gradingFailureMessages(summary.grading), ...(summary.driftNote ? [`drift: ${summary.driftNote}`] : [])],
      git,
      judgeScores: null,
      model: options.model,
      passed: summary.passed,
      provider: "codex",
      runGroupId,
      schemaVersion: 1,
      skill: suite,
      startedAt: summary.startedAt,
      status: summary.passed ? "passed" : "failed",
      tier: "gate",
      turns: null,
    } satisfies ResultStoreEntry;
  });
}

function qualityResultEntries(
  packageRootPath: string,
  batch: QualityBatchSummary,
  options: CliOptions,
): readonly ResultStoreEntry[] {
  const runGroupId = createRunGroupId(batch.runStartedAt, `eval-quality-${options.suite ?? "all"}`);
  const git = readGitInfo(repoRootFromPackage(packageRootPath), options.base);
  return batch.cases.map(
    (summary) =>
      ({
        artifact: {
          gradingJsonPath: null,
          runRoot: summary.runRoot,
          summaryJsonPath: summary.summaryJsonPath,
          summaryMdPath: summary.summaryMdPath,
        },
        caseId: summary.caseId,
        command: "eval:quality",
        costUsd: summary.cost_usd,
        durationMs: summary.duration_ms,
        failures: summary.failures,
        git,
        judgeScores: summary.judge_scores,
        model: summary.judge_model,
        passed: summary.passed,
        provider: summary.judge_provider,
        runGroupId,
        schemaVersion: 1,
        skill: summary.skill as ShippedSkillName,
        startedAt: summary.startedAt,
        status: summary.passed ? "passed" : "failed",
        tier: "quality",
        turns: null,
      }) satisfies ResultStoreEntry,
  );
}

async function runGate(options: CliOptions): Promise<void> {
  const packageRootPath = packageRoot();
  if (options.suite === "first-tree-read") {
    const batch = await runFirstTreeReadGate(packageRootPath, {
      caseId: options.caseId,
      codexBin: options.codexBin,
      json: options.json,
      model: options.model,
      verbose: options.verbose,
    });
    appendResultStoreEntries(packageRootPath, gateResultEntries(packageRootPath, batch, options.suite, options));
    if (options.json) {
      process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatFirstTreeReadGateSummary(batch)}\n`);
    }
    if (batch.failed > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (options.suite === "first-tree-write") {
    const batch = await runFirstTreeWriteGate(packageRootPath, {
      caseId: options.caseId,
      codexBin: options.codexBin,
      json: options.json,
      model: options.model,
      verbose: options.verbose,
    });
    appendResultStoreEntries(packageRootPath, gateResultEntries(packageRootPath, batch, options.suite, options));
    if (options.json) {
      process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatFirstTreeWriteGateSummary(batch)}\n`);
    }
    if (batch.failed > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (options.suite === "first-tree-seed") {
    const batch = await runFirstTreeSeedGate(packageRootPath, {
      caseId: options.caseId,
      codexBin: options.codexBin,
      json: options.json,
      model: options.model,
      verbose: options.verbose,
    });
    appendResultStoreEntries(packageRootPath, gateResultEntries(packageRootPath, batch, options.suite, options));
    if (options.json) {
      process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatFirstTreeSeedGateSummary(batch)}\n`);
    }
    if (batch.failed > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (options.suite === "first-tree-welcome") {
    const batch = await runFirstTreeWelcomeGate(packageRootPath, {
      caseId: options.caseId,
      codexBin: options.codexBin,
      json: options.json,
      model: options.model,
      verbose: options.verbose,
    });
    appendResultStoreEntries(packageRootPath, gateResultEntries(packageRootPath, batch, options.suite, options));
    if (options.json) {
      process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatFirstTreeWelcomeGateSummary(batch)}\n`);
    }
    if (batch.failed > 0) {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(
    "eval:gate currently requires --suite first-tree-read, --suite first-tree-write, --suite first-tree-seed, or --suite first-tree-welcome.",
  );
}

async function runQuality(options: CliOptions): Promise<void> {
  const packageRootPath = packageRoot();
  const batch = await runQualityEval(packageRootPath, {
    caseId: options.caseId,
    codexBin: options.codexBin,
    judgeBin: options.judgeBin,
    judgeModel: options.judgeModel,
    json: options.json,
    model: options.model,
    suite: qualitySuite(options),
    verbose: options.verbose,
  });
  appendResultStoreEntries(packageRootPath, qualityResultEntries(packageRootPath, batch, options));
  if (options.json) {
    process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatQualitySummaryTable(batch)}\n`);
  }
  if (batch.failed > 0) {
    process.exitCode = 1;
  }
}

function runSelect(options: CliOptions): void {
  const packageRootPath = packageRoot();
  const repoRoot = repoRootFromPackage(packageRootPath);
  const base = options.base ?? "main";
  const changedFiles = options.changedFiles.length === 0 ? changedFilesFromGit(repoRoot, base) : options.changedFiles;
  const summary = selectSkillEvalRecommendations(changedFiles, options.changedFiles.length === 0 ? base : null);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSelectionSummary(summary)}\n`);
  }
}

function runCompare(options: CliOptions): void {
  const packageRootPath = packageRoot();
  const entries = readResultStore(packageRootPath);
  const { current, previous } = latestRunGroups(entries, options.currentRunGroupId, options.previousRunGroupId);
  const summary = compareResultGroups(current, previous);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatCompareSummary(summary)}\n`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "select") {
    runSelect(options);
    return;
  }
  if (options.command === "compare") {
    runCompare(options);
    return;
  }
  if (options.command === "gate") {
    await runGate(options);
    return;
  }
  if (options.command === "quality") {
    await runQuality(options);
    return;
  }

  const packageRootPath = packageRoot();
  const startedAt = new Date().toISOString();
  const before = Date.now();
  const summary = buildFloorSummary(options);
  const runGroupId = createRunGroupId(startedAt, `eval-floor-${options.suite ?? "all"}`);
  const artifact = writeFloorArtifact(packageRootPath, summary, runGroupId);
  appendResultStoreEntries(
    packageRootPath,
    floorResultEntries(packageRootPath, summary, {
      artifact,
      base: options.base,
      durationMs: Date.now() - before,
      runGroupId,
      startedAt,
    }),
  );
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatFloorSummary(summary)}\n`);
  }
  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
