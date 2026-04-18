import {
  copyCanonicalSkill,
  resolveBundledPackageRoot,
} from "#products/tree/engine/runtime/installer.js";

export interface UpgradeDeps {
  targetRoot?: string;
  write?: (text: string) => void;
}

export const UPGRADE_USAGE = `usage: first-tree skill upgrade

  Wipe and reinstall the four shipped first-tree skills in the current
  working directory (or --root <path>) from the currently installed
  first-tree package. This refreshes only the local skill payloads under
  .agents/skills/* and .claude/skills/*.

Options:
  --root <path>         Upgrade a different directory (default: cwd)
  --help, -h            Show this help message
`;

function parseTargetRoot(
  args: readonly string[],
): string | { error: string } {
  let targetRoot = process.cwd();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--root") {
      const value = args[i + 1];
      if (!value) {
        return { error: "Missing value for --root" };
      }
      targetRoot = value;
      i += 1;
      continue;
    }
    return { error: `Unknown upgrade option: ${arg}` };
  }
  return targetRoot;
}

export function runUpgrade(
  args: readonly string[],
  deps: UpgradeDeps = {},
): number {
  if (args[0] === "--help" || args[0] === "-h") {
    (deps.write ?? console.log)(UPGRADE_USAGE);
    return 0;
  }

  const parsedRoot = deps.targetRoot ?? parseTargetRoot(args);
  if (typeof parsedRoot !== "string") {
    console.error(parsedRoot.error);
    console.log(UPGRADE_USAGE);
    return 1;
  }

  const write = deps.write ?? ((text: string) => process.stdout.write(text + "\n"));
  try {
    const sourceRoot = resolveBundledPackageRoot();
    copyCanonicalSkill(sourceRoot, parsedRoot);
    write(
      "Upgraded the four shipped first-tree skills under `.agents/skills/*` and `.claude/skills/*`.",
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`first-tree skill upgrade: ${message}`);
    return 1;
  }
}
