import {
  copyCanonicalSkill,
  resolveBundledPackageRoot,
} from "#products/tree/engine/runtime/installer.js";

export interface InstallDeps {
  targetRoot?: string;
  write?: (text: string) => void;
}

export const INSTALL_USAGE = `usage: first-tree skill install

  Install the four shipped first-tree skills into the current working
  directory (or --root <path>). This manages only the local skill payloads
  under .agents/skills/* and .claude/skills/*; it does not write tree/source
  binding metadata.

Options:
  --root <path>         Install into a different directory (default: cwd)
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
    return { error: `Unknown install option: ${arg}` };
  }
  return targetRoot;
}

export function runInstall(
  args: readonly string[],
  deps: InstallDeps = {},
): number {
  if (args[0] === "--help" || args[0] === "-h") {
    (deps.write ?? console.log)(INSTALL_USAGE);
    return 0;
  }

  const parsedRoot = deps.targetRoot ?? parseTargetRoot(args);
  if (typeof parsedRoot !== "string") {
    console.error(parsedRoot.error);
    console.log(INSTALL_USAGE);
    return 1;
  }

  const write = deps.write ?? ((text: string) => process.stdout.write(text + "\n"));
  try {
    const sourceRoot = resolveBundledPackageRoot();
    copyCanonicalSkill(sourceRoot, parsedRoot);
    write(
      "Installed the four shipped first-tree skills under `.agents/skills/*` and `.claude/skills/*`.",
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`first-tree skill install: ${message}`);
    return 1;
  }
}
