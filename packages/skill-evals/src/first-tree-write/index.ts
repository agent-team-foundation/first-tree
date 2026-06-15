import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FIRST_TREE_WRITE_CASES, findFirstTreeWriteCase } from "./cases.js";
import { runFirstTreeWriteCase } from "./runner.js";
import { buildBatchSummary, formatSummaryTable } from "./summary.js";
import type { CliOptions, FirstTreeWriteEvalCase } from "./types.js";

function usage(): string {
  return `Usage:
  pnpm --filter @first-tree/skill-evals eval:first-tree-write
  pnpm --filter @first-tree/skill-evals eval:first-tree-write -- --case <id>
  pnpm --filter @first-tree/skill-evals eval:first-tree-write -- --json
  pnpm --filter @first-tree/skill-evals eval:first-tree-write -- --verbose
  pnpm --filter @first-tree/skill-evals validate:first-tree-write-fixtures

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

function selectCases(options: CliOptions): readonly FirstTreeWriteEvalCase[] {
  if (options.caseId === null) return FIRST_TREE_WRITE_CASES;

  const evalCase = findFirstTreeWriteCase(options.caseId);
  if (evalCase === null) {
    const available = FIRST_TREE_WRITE_CASES.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown case '${options.caseId}'. Available cases: ${available}`);
  }
  return [evalCase];
}

function packageRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
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
          : `Running first-tree-write eval case: ${evalCase.id}\n`,
      );
    }
    summaries.push(await runFirstTreeWriteCase(packageRoot(), evalCase, options, runStartedAt));
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
