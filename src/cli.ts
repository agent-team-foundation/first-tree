#!/usr/bin/env node

const USAGE = `usage: context-tree <command>

  New to context-tree? Run \`context-tree help onboarding\` first.

Commands:
  init      Bootstrap a new context tree (clones seed-tree, copies framework files)
  verify    Run verification checks against the current tree
  upgrade   Generate an upgrade task list from upstream changes
  help      Show help for a topic (e.g. \`help onboarding\`)

Options:
  --help    Show this help message
`;

const HELP_USAGE = `usage: context-tree help <topic>

Topics:
  onboarding   How to set up a context tree from scratch
`;

async function runHelp(args: string[]): Promise<number> {
  const topic = args[0];

  if (!topic || topic === "--help" || topic === "-h") {
    console.log(HELP_USAGE);
    return 0;
  }

  switch (topic) {
    case "onboarding": {
      const { runOnboarding } = await import("#src/onboarding.js");
      return runOnboarding();
    }
    default:
      console.log(`Unknown help topic: ${topic}`);
      console.log(HELP_USAGE);
      return 1;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    return 0;
  }

  const command = args[0];

  switch (command) {
    case "init": {
      const { runInit } = await import("#src/init.js");
      return runInit();
    }
    case "verify": {
      const { runVerify } = await import("#src/verify.js");
      return runVerify();
    }
    case "upgrade": {
      const { runUpgrade } = await import("#src/upgrade.js");
      return runUpgrade();
    }
    case "help":
      return runHelp(args.slice(1));
    default:
      console.log(`Unknown command: ${command}`);
      console.log(USAGE);
      return 1;
  }
}

main().then((code) => process.exit(code));
