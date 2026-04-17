#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRODUCTS,
  getProduct,
  readProductVersion,
} from "./products/manifest.js";

export const USAGE = buildUsage();

function buildUsage(): string {
  const productLines = PRODUCTS.map(
    (p) => `  ${p.name.padEnd(20)}  ${p.description}`,
  ).join("\n");
  const gettingStarted = [
    "  first-tree tree --help",
    "  first-tree tree inspect --json",
    "  first-tree tree init",
    "  first-tree breeze --help",
    "  first-tree breeze status",
  ].join("\n");
  return `usage: first-tree <product> <command>

  first-tree is an umbrella CLI that dispatches into product namespaces.
  This CLI is designed for agents, not humans. Let your agent handle it.

Products:
${productLines}

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

function readFirstTreeVersion(): string {
  // Walk up from this module until we find the package.json that owns the CLI.
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === "first-tree" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return "unknown";
    }
    dir = parent;
  }
}

function formatVersionLine(): string {
  const cliVersion = readFirstTreeVersion();
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

  const productName = args[0];
  const product = getProduct(productName);

  if (!product) {
    write(`Unknown product: ${productName}`);
    write(
      `Did you mean \`first-tree tree ${productName}\`? Run \`first-tree --help\` for the list of products.`,
    );
    return 1;
  }

  if (product.autoUpgradeOnInvoke && !skipVersionCheck) {
    await runAutoUpgradeCheck();
  }

  const { run } = await product.load();
  return run(args.slice(1), write);
}

async function main(): Promise<number> {
  return runCli(process.argv.slice(2));
}

if (isDirectExecution(process.argv[1])) {
  main().then((code) => process.exit(code));
}
