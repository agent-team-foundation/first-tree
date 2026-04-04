#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const USAGE = `usage: context-tree <command>

  New to context-tree? Run \`context-tree help onboarding\` first.

Commands:
  init      Bootstrap a new context tree (installs the framework skill)
  verify    Run verification checks against the current tree
  upgrade   Refresh the installed skill from the current first-tree npm package and generate follow-up tasks
  help      Show help for a topic (e.g. \`help onboarding\`)

Options:
  --help       Show this help message
  --version    Show version number
`;

type Output = (text: string) => void;

export { USAGE };

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
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version: string };
    write(pkg.version);
    return 0;
  }

  const command = args[0];

  switch (command) {
    case "init": {
      const { runInit } = await import("#skill/engine/commands/init.js");
      return runInit();
    }
    case "verify": {
      const { runVerify } = await import("#skill/engine/commands/verify.js");
      return runVerify();
    }
    case "upgrade": {
      const { runUpgrade } = await import("#skill/engine/commands/upgrade.js");
      return runUpgrade();
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

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then((code) => process.exit(code));
}
