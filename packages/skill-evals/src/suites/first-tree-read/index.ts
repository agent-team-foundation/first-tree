import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "../../core/events.js";
import { FIRST_TREE_READ_CASES, findFirstTreeReadCase } from "./cases.js";
import { runFirstTreeReadCase } from "./runner.js";
import { buildBatchSummary, formatSummaryTable } from "./summary.js";
import type { CliOptions, FirstTreeReadEvalCase } from "./types.js";

function usage(): string {
  return `Usage:
  pnpm --filter @first-tree/skill-evals eval:first-tree-read
  pnpm --filter @first-tree/skill-evals eval:first-tree-read -- --case <id>
  pnpm --filter @first-tree/skill-evals eval:first-tree-read -- --json
  pnpm --filter @first-tree/skill-evals eval:first-tree-read -- --verbose
  pnpm --filter @first-tree/skill-evals validate:first-tree-read-fixtures

Options:
  --case <id>              Run one case.
  --json                   Print aggregate summary as JSON.
  --model <model>          Pass a model override to codex exec.
  --codex-bin <path>       Codex binary to execute. Defaults to CODEX_BIN or codex.
  --validate-fixtures      Validate fixtures only; no model calls.
  --verbose                Print live readable progress to stderr.
  --help                   Show this help.
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
  const options: CliOptions = {
    caseId: null,
    codexBin: process.env.CODEX_BIN ?? "codex",
    json: false,
    model: process.env.CODEX_MODEL ?? null,
    validateFixtures: false,
    verbose: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--case") {
      options.caseId = readOptionValue(args, index, "--case");
      index += 1;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--model") {
      options.model = readOptionValue(args, index, "--model");
      index += 1;
      continue;
    }
    if (arg === "--codex-bin") {
      options.codexBin = readOptionValue(args, index, "--codex-bin");
      index += 1;
      continue;
    }
    if (arg === "--validate-fixtures") {
      options.validateFixtures = true;
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

function selectCases(options: CliOptions): readonly FirstTreeReadEvalCase[] {
  if (options.caseId === null) return FIRST_TREE_READ_CASES;

  const evalCase = findFirstTreeReadCase(options.caseId);
  if (evalCase === null) {
    const available = FIRST_TREE_READ_CASES.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown case '${options.caseId}'. Available cases: ${available}`);
  }
  return [evalCase];
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const selectedCases = selectCases(options);
  const runStartedAt = new Date().toISOString();
  const summaries = [];

  for (const evalCase of selectedCases) {
    if (!options.verbose) {
      process.stderr.write(
        options.validateFixtures
          ? `Validating fixture: ${evalCase.id}\n`
          : `Running first-tree-read eval case: ${evalCase.id}\n`,
      );
    }
    summaries.push(await runFirstTreeReadCase(packageRoot(), evalCase, options, runStartedAt));
  }

  const batch = buildBatchSummary(summaries, runStartedAt);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSummaryTable(batch)}\n`);
  }

  if (batch.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
