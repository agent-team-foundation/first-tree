#!/usr/bin/env node

const USAGE = `usage: context-tree <command>

  New to context-tree? Run \`context-tree help onboarding\` first.

Commands:
  init      Bootstrap a new context tree (clones first-tree, copies framework files)
  verify    Run verification checks against the current tree
  upgrade   Generate an upgrade task list from upstream changes
  help      Show help for a topic (e.g. \`help onboarding\`)

Options:
  --help       Show this help message
  --version    Show version number
`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    return 0;
  }

  if (args[0] === "--version" || args[0] === "-v") {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version: string };
    console.log(pkg.version);
    return 0;
  }

  const command = args[0];

  switch (command) {
    case "init": {
      const { runInit } = await import("#src/commands/init.js");
      return runInit();
    }
    case "verify": {
      const { runVerify } = await import("#src/commands/verify.js");
      return runVerify();
    }
    case "upgrade": {
      const { runUpgrade } = await import("#src/commands/upgrade.js");
      return runUpgrade();
    }
    case "help":
      return (await import("#src/commands/help.js")).runHelp(args.slice(1));
    default:
      console.log(`Unknown command: ${command}`);
      console.log(USAGE);
      return 1;
  }
}

main().then((code) => process.exit(code));
