#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ALL_COMMANDS,
  META_COMMANDS,
  PRODUCTS,
  getCommand,
  readCommandVersion,
} from "./products/manifest.js";
import { readPackageVersion } from "./shared/version.js";

export const USAGE = buildUsage();

function buildUsage(): string {
  const formatRow = (name: string, description: string): string =>
    `  ${name.padEnd(20)}  ${description}`;
  const productLines = PRODUCTS.map((p) => formatRow(p.name, p.description))
    .join("\n");
  const maintenanceLines = META_COMMANDS.map((m) =>
    formatRow(m.name, m.description)
  ).join("\n");
  const primaryProducts = PRODUCTS.map((p) => p.name).join(", ");
  const maintenanceNamespaces = META_COMMANDS.map((m) => m.name).join(", ");
  const gettingStarted = [
    "  first-tree tree --help",
    "  first-tree tree inspect --json",
    "  first-tree tree init",
    "  first-tree breeze --help",
    "  first-tree breeze status",
    "  first-tree skill doctor",
  ].join("\n");
  return `usage: first-tree <namespace> <command>

  first-tree is an umbrella CLI with three primary products (${primaryProducts})
  plus a maintenance namespace (${maintenanceNamespaces}).
  This CLI is designed for agents, not humans. Let your agent handle it.

Products:
${productLines}

Maintenance:
${maintenanceLines}

Global options:
  --help, -h            Show this help message
  --version, -v         Show version numbers for the CLI and each namespace
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
  for (const command of ALL_COMMANDS) {
    parts.push(`${command.name}=${readCommandVersion(command.name)}`);
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

  const namespaceName = args[0];
  const command = getCommand(namespaceName);

  if (!command) {
    write(`Unknown first-tree namespace: ${namespaceName}`);
    write(
      `Did you mean \`first-tree tree ${namespaceName}\`? Run \`first-tree --help\` for the list of products and maintenance commands.`,
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
