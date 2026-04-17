#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  META_COMMANDS,
  PRODUCTS,
  getCommand,
  readProductVersion,
} from "./products/manifest.js";
import { readPackageVersion } from "./shared/version.js";

export const USAGE = buildUsage();

function buildUsage(): string {
  const formatRow = (name: string, description: string): string =>
    `  ${name.padEnd(20)}  ${description}`;
  const productLines = PRODUCTS.map((p) => formatRow(p.name, p.description))
    .join("\n");
  const metaLines = META_COMMANDS.map((m) => formatRow(m.name, m.description))
    .join("\n");
  const gettingStarted = [
    "  first-tree tree --help",
    "  first-tree tree inspect --json",
    "  first-tree tree init",
    "  first-tree breeze --help",
    "  first-tree breeze status",
  ].join("\n");
  return `usage: first-tree <command> [...]

  first-tree is an umbrella CLI that dispatches into product namespaces.
  This CLI is designed for agents, not humans. Let your agent handle it.

Products:
${productLines}

Diagnostics:
${metaLines}

Global options:
  --help, -h            Show this help message
  --version, -v         Show version numbers for the CLI and each product
  --skip-version-check  Skip the auto-upgrade check (for latency-sensitive callers)

Getting started:
${gettingStarted}
`;
}

type Output = (text: string) => void;

export function isDirectExecution(
  argv1: string | undefined,
  metaUrl: string = import.meta.url,
): boolean {
  if (argv1 === undefined) {
    return false;
  }

  try {
    // npm commonly invokes bins through a symlink or shim path.
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

export function stripGlobalFlags(args: string[]): {
  rest: string[];
  skipVersionCheck: boolean;
} {
  const rest: string[] = [];
  let skipVersionCheck = false;
  for (const arg of args) {
    if (arg === "--skip-version-check") {
      skipVersionCheck = true;
      continue;
    }
    rest.push(arg);
  }
  return { rest, skipVersionCheck };
}

async function runAutoUpgradeCheck(): Promise<void> {
  // Best-effort silent auto-upgrade. Any failure is swallowed so the user's
  // command always runs.
  try {
    const {
      checkAndAutoUpgrade,
      defaultFetchLatestVersion,
      defaultInstallLatestVersion,
      defaultReadCache,
      defaultWriteCache,
    } = await import("#products/tree/engine/runtime/auto-upgrade.js");
    const { resolveBundledPackageRoot, readCanonicalFrameworkVersion } =
      await import("#products/tree/engine/runtime/installer.js");
    const currentVersion = readCanonicalFrameworkVersion(
      resolveBundledPackageRoot(),
    );
    await checkAndAutoUpgrade({
      currentVersion,
      fetchLatestVersion: defaultFetchLatestVersion,
      installLatestVersion: defaultInstallLatestVersion,
      readCache: defaultReadCache,
      writeCache: defaultWriteCache,
    });
  } catch {
    // Swallow — auto-upgrade is best-effort
  }
}

function formatVersionLine(): string {
  const cliVersion = readPackageVersion(import.meta.url, "first-tree");
  const parts = [`first-tree=${cliVersion}`];
  for (const product of PRODUCTS) {
    parts.push(`${product.name}=${readProductVersion(product.name)}`);
  }
  return parts.join(" ");
}

export async function runCli(
  rawArgs: string[],
  output: Output = console.log,
): Promise<number> {
  const write = (text: string): void => output(text);
  const { rest: args, skipVersionCheck } = stripGlobalFlags(rawArgs);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    write(USAGE);
    return 0;
  }

  if (args[0] === "--version" || args[0] === "-v") {
    write(formatVersionLine());
    return 0;
  }

  const commandName = args[0];
  const command = getCommand(commandName);

  if (!command) {
    write(`Unknown command: ${commandName}`);
    write(
      `Did you mean \`first-tree tree ${commandName}\`? Run \`first-tree --help\` for the list of commands.`,
    );
    return 1;
  }

  if (command.autoUpgradeOnInvoke && !skipVersionCheck) {
    await runAutoUpgradeCheck();
  }

  const { run } = await command.load();
  return run(args.slice(1), write);
}

async function main(): Promise<number> {
  return runCli(process.argv.slice(2));
}

if (isDirectExecution(process.argv[1])) {
  main().then((code) => process.exit(code));
}
