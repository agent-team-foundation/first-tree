import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SHIPPED_SKILLS, type ShippedSkillName } from "./core/case-schema.js";
import { type SkillEvalSuiteDefinition, validateCoverageMatrix } from "./core/coverage.js";
import { isRecord } from "./core/events.js";
import { readSkillFrontmatter } from "./core/skills/frontmatter.js";
import { formatFirstTreeWriteGateSummary, runFirstTreeWriteGate } from "./suites/first-tree-write/index.js";
import { SKILL_EVAL_SUITES } from "./suites/registry.js";

type CliOptions = {
  caseId: string | null;
  codexBin: string;
  command: "floor" | "gate";
  json: boolean;
  model: string | null;
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
  pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-write

Commands:
  floor                  Run no-model schema, coverage, and skill-file checks.
  gate                   Run a live model gate suite.

Options:
  --suite <skill>        Limit per-suite floor checks to one shipped skill.
  --case <id>            Run one live gate case.
  --json                 Print summary as JSON.
  --model <model>        Pass a model override to codex exec.
  --codex-bin <path>     Codex binary to execute. Defaults to CODEX_BIN or codex.
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
  if (command !== "floor" && command !== "gate") {
    throw new Error(`Unknown command: ${command}`);
  }

  const options: CliOptions = {
    caseId: null,
    codexBin: process.env.CODEX_BIN ?? "codex",
    command,
    json: false,
    model: process.env.CODEX_MODEL ?? null,
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

async function runGate(options: CliOptions): Promise<void> {
  if (options.suite !== "first-tree-write") {
    throw new Error("eval:gate currently requires --suite first-tree-write.");
  }

  const batch = await runFirstTreeWriteGate(packageRoot(), {
    caseId: options.caseId,
    codexBin: options.codexBin,
    json: options.json,
    model: options.model,
    verbose: options.verbose,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatFirstTreeWriteGateSummary(batch)}\n`);
  }
  if (batch.failed > 0) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "gate") {
    await runGate(options);
    return;
  }

  const summary = buildFloorSummary(options);
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
