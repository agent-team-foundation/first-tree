const HELP_USAGE = `usage: context-tree help <topic>

Topics:
  onboarding   How to set up a context tree from scratch
`;

export { HELP_USAGE };

export async function runHelp(args: string[]): Promise<number> {
  const topic = args[0];

  if (!topic || topic === "--help" || topic === "-h") {
    console.log(HELP_USAGE);
    return 0;
  }

  switch (topic) {
    case "onboarding": {
      const { runOnboarding } = await import("#skill/engine/onboarding.js");
      return runOnboarding();
    }
    default:
      console.log(`Unknown help topic: ${topic}`);
      console.log(HELP_USAGE);
      return 1;
  }
}
