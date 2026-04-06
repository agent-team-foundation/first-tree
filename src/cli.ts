#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const USAGE = `usage: first-tree <command>

  This CLI is designed for agents, not humans. Let your agent handle it.
  New to first-tree? Run \`first-tree help onboarding\` first.

Commands:
  init      Install source/workspace integration and create or refresh a dedicated context tree repo
  publish   Publish a dedicated tree repo to GitHub and record it back in the source repo
  verify    Run verification checks against a tree repo
  upgrade   Refresh the installed skill in a tree repo
  help      Show help for a topic (e.g. \`help onboarding\`)

Options:
  --help       Show this help message
  --version    Show version number

Common examples:
  first-tree init
  first-tree init --seed-members contributors
  first-tree publish --open-pr
  mkdir my-org-tree && cd my-org-tree && git init && first-tree init --here
  first-tree verify --tree-path ../my-org-tree
  first-tree upgrade --tree-path ../my-org-tree

Note:
  \`--here\` is for when the current repo is already the dedicated tree repo.
`;

type Output = (text: string) => void;

export { USAGE };

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

export async function runCli(
  args: string[],
  output: Output = console.log,
): Promise<number> {
  const write = (text: string): void => output(text);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    write(USAGE);
    return 0;
  }

  if (args[0] === "--version" || args[0] === "-v") {
    const { resolveBundledPackageRoot, readCanonicalFrameworkVersion } =
      await import("#skill/engine/runtime/installer.js");
    write(readCanonicalFrameworkVersion(resolveBundledPackageRoot()));
    return 0;
  }

  const command = args[0];

  switch (command) {
    case "init": {
      const { runInit } = await import("#skill/engine/commands/init.js");
      return runInit(args.slice(1));
    }
    case "verify": {
      const { runVerify } = await import("#skill/engine/commands/verify.js");
      return runVerify(args.slice(1));
    }
    case "publish": {
      const { runPublish } = await import("#skill/engine/commands/publish.js");
      return runPublish(args.slice(1));
    }
    case "upgrade": {
      const { runUpgrade } = await import("#skill/engine/commands/upgrade.js");
      return runUpgrade(args.slice(1));
    }
    case "help":
      return (await import("#skill/engine/commands/help.js")).runHelp(
        args.slice(1),
        write,
      );
    default:
      write(`Unknown command: ${command}`);
      write(USAGE);
      return 1;
  }
}

async function main(): Promise<number> {
  return runCli(process.argv.slice(2));
}

if (isDirectExecution(process.argv[1])) {
  main().then((code) => process.exit(code));
}
