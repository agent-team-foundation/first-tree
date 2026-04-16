const HELP_USAGE = `usage: first-tree help <topic>

Topics:
  onboarding   How to set up a context tree from scratch
`;

export { HELP_USAGE };

type Output = (text: string) => void;

export async function runHelp(
  args: string[],
  output: Output = console.log,
): Promise<number> {
  const topic = args[0];

  if (!topic || topic === "--help" || topic === "-h") {
    output(HELP_USAGE);
    return 0;
  }

  switch (topic) {
    case "onboarding": {
      const { runOnboarding } = await import("#products/tree/engine/onboarding.js");
      return runOnboarding(output);
    }
    default:
      output(`Unknown help topic: ${topic}`);
      output(HELP_USAGE);
      return 1;
  }
}
