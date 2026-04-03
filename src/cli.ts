#!/usr/bin/env node

const USAGE = `usage: context-tree <command>

  New to context-tree? Run \`context-tree help onboarding\` first.

Commands:
  init      Bootstrap a new context tree (installs the framework skill)
  verify    Run verification checks against the current tree
  upgrade   Refresh the installed skill from upstream and generate follow-up tasks
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
      return (await import("#skill/engine/commands/help.js")).runHelp(args.slice(1));
    default:
      console.log(`Unknown command: ${command}`);
      console.log(USAGE);
      return 1;
  }
}

main().then((code) => process.exit(code));
