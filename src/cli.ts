#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const USAGE = `usage: first-tree <product> <command>

  first-tree is an umbrella CLI that dispatches into product namespaces.
  This CLI is designed for agents, not humans. Let your agent handle it.

Products:
  tree                  Context Tree tooling (init, bind, sync, publish, ...)
  breeze                Breeze tooling (not yet available in the TypeScript port)

Global options:
  --help, -h            Show this help message
  --version, -v         Show version numbers for the CLI and each product
  --skip-version-check  Skip the auto-upgrade check (for latency-sensitive callers)

Getting started:
  first-tree tree --help
  first-tree tree inspect --json
  first-tree tree init
`;

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

function readProductVersion(productDir: string): string {
  // VERSION files are siblings of the bundled product cli.ts. When the CLI
  // runs from the published package they live under dist/products/<name>/;
  // in the source tree they live under src/products/<name>/. Try both.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "products", productDir, "VERSION"),
    join(here, "..", "src", "products", productDir, "VERSION"),
    join(here, "..", "products", productDir, "VERSION"),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf-8").trim();
    } catch {
      // try next
    }
  }
  return "unknown";
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
    const cliVersion = readFirstTreeVersion();
    const treeVersion = readProductVersion("tree");
    const breezeVersion = readProductVersion("breeze");
    write(
      `first-tree=${cliVersion} tree=${treeVersion} breeze=${breezeVersion}`,
    );
    return 0;
  }

  const product = args[0];

  switch (product) {
    case "tree": {
      if (!skipVersionCheck) {
        await runAutoUpgradeCheck();
      }
      const { runTree } = await import("./products/tree/cli.js");
      return runTree(args.slice(1), write);
    }
    case "breeze": {
      const { runBreeze } = await import("./products/breeze/cli.js");
      return runBreeze(args.slice(1));
    }
    default:
      write(`Unknown product: ${product}`);
      write(
        `Did you mean \`first-tree tree ${product}\`? Run \`first-tree --help\` for the list of products.`,
      );
      return 1;
  }
}

async function main(): Promise<number> {
  return runCli(process.argv.slice(2));
}

if (isDirectExecution(process.argv[1])) {
  main().then((code) => process.exit(code));
}
