#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const USAGE = `usage: first-tree <command>

  This CLI is designed for agents, not humans. Let your agent handle it.
  New to first-tree? Run \`first-tree help onboarding\` first.

Commands:
  inspect               Classify the current folder before onboarding
  init                  High-level onboarding wrapper for repo/workspace roots
  bind                  Bind the current repo/workspace root to an existing tree repo
  workspace             Workspace helpers (currently: sync child repos to a shared tree)
  publish               Publish a tree repo to GitHub
  verify                Run verification checks against a tree repo
  upgrade               Refresh the installed skill in a tree repo
  sync                  Detect drift between a tree repo and its bound sources
  review                Run Claude Code PR review (CI helper)
  generate-codeowners   Generate .github/CODEOWNERS from tree ownership
  inject-context        Output Claude Code SessionStart hook payload from NODE.md
  help                  Show help for a topic (e.g. \`help onboarding\`)

Options:
  --help                Show this help message
  --version             Show version number
  --skip-version-check  Skip the auto-upgrade check (for latency-sensitive callers)

Common examples:
  first-tree inspect --json
  first-tree init
  first-tree init --tree-path ../org-context --tree-mode shared
  first-tree init --scope workspace --tree-path ../org-context --tree-mode shared --sync-members
  first-tree bind --tree-path ../org-context --tree-mode shared
  first-tree publish --tree-path ../org-context
  mkdir my-org-tree && cd my-org-tree && git init && first-tree init tree --here
  first-tree verify --tree-path ../my-org-tree
  first-tree upgrade --tree-path ../my-org-tree

Note:
  \`first-tree init tree --here\` is for when the current repo is already the tree repo.
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
    } = await import("#engine/runtime/auto-upgrade.js");
    const { resolveBundledPackageRoot, readCanonicalFrameworkVersion } =
      await import("#engine/runtime/installer.js");
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
    const {
      resolveBundledPackageRoot,
      readCanonicalFrameworkVersion,
      readSkillVersion,
    } = await import("#engine/runtime/installer.js");
    const packageRoot = resolveBundledPackageRoot();
    const cliVersion = readCanonicalFrameworkVersion(packageRoot);
    const skillVersion = readSkillVersion(packageRoot);
    write(`${cliVersion} (skills: ${skillVersion})`);
    return 0;
  }

  if (!skipVersionCheck) {
    await runAutoUpgradeCheck();
  }

  const command = args[0];

  switch (command) {
    case "init": {
      const { runInit } = await import("#engine/commands/init.js");
      return runInit(args.slice(1));
    }
    case "inspect": {
      const { runInspect } = await import("#engine/commands/inspect.js");
      return runInspect(args.slice(1));
    }
    case "bind": {
      const { runBind } = await import("#engine/commands/bind.js");
      return runBind(args.slice(1));
    }
    case "workspace": {
      const { runWorkspace } = await import("#engine/commands/workspace.js");
      return runWorkspace(args.slice(1));
    }
    case "verify": {
      const { runVerify } = await import("#engine/commands/verify.js");
      return runVerify(args.slice(1));
    }
    case "publish": {
      const { runPublish } = await import("#engine/commands/publish.js");
      return runPublish(args.slice(1));
    }
    case "upgrade": {
      const { runUpgrade } = await import("#engine/commands/upgrade.js");
      return runUpgrade(args.slice(1));
    }
    case "sync": {
      const { runSync } = await import("#engine/commands/sync.js");
      return runSync(args.slice(1));
    }
    case "review": {
      const { runReview } = await import("#engine/commands/review.js");
      return runReview(args.slice(1));
    }
    case "generate-codeowners": {
      const { runGenerateCodeowners } = await import(
        "#engine/commands/generate-codeowners.js"
      );
      return runGenerateCodeowners(args.slice(1));
    }
    case "inject-context": {
      const { runInjectContext } = await import(
        "#engine/commands/inject-context.js"
      );
      return runInjectContext(args.slice(1));
    }
    case "help":
      return (await import("#engine/commands/help.js")).runHelp(
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
