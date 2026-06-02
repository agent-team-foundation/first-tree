import { basename, dirname, join } from "node:path";

import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";

import {
  detectMigrationState,
  type MigrationDetection,
  type MigrationResult,
  migrateWorkspaceToW1,
  promoteToWorkspace,
} from "../../core/migrate-workspace.js";
import type { CommandContext, SubcommandModule } from "../types.js";

type MigrateCliOptions = {
  dryRun?: boolean;
  workspaceName?: string;
  yes?: boolean;
};

export const MIGRATE_USAGE = `usage: first-tree tree migrate-to-w1 [--dry-run] [--workspace-name NAME] [--yes]

Migrate a legacy multi-mode workspace onto the workspace-rooted (W1) layout.

The command auto-detects three starting points and converges them on the
same cleanup flow. For single-repo legacy layouts (no parent workspace
directory) the tool offers to materialize one and move both repos into it
before cleaning up — that move requires explicit confirmation.

No git operations are performed; every change is left as a working-tree
edit for you to commit.

Options:
  --dry-run             Print what would change without touching disk
  --workspace-name NAME Override the default '<source>-workspace' name when
                        promoting a single repo into a workspace dir
  --yes                 Skip the promote-step confirmation prompt
  --help                Show this help message`;

function configureMigrateCommand(command: Command): void {
  command
    .option("--dry-run", "print what would change without touching disk")
    .option("--workspace-name <name>", "override the default '<source>-workspace' name when promoting")
    .option("--yes", "skip the promote-step confirmation prompt");
}

function readMigrateOptions(command: Command): MigrateCliOptions {
  const options = command.opts() as Record<string, string | boolean | undefined>;
  return {
    dryRun: options.dryRun === true,
    workspaceName: typeof options.workspaceName === "string" ? options.workspaceName : undefined,
    yes: options.yes === true,
  };
}

function printResult(result: MigrationResult, prefix: string): void {
  console.log(`${prefix}\n`);
  console.log(`  Workspace:  ${result.workspaceRoot}`);
  console.log(`  Tree:       ${result.manifest.tree}`);
  console.log(`  Sources:    ${result.manifest.sources.length > 0 ? result.manifest.sources.join(", ") : "(none)"}`);

  if (result.removed.length > 0) {
    console.log(`\n  Removed (${result.removed.length}):`);
    for (const entry of result.removed) {
      console.log(`    - ${entry.path}  (${entry.kind})`);
    }
  }

  if (result.modified.length > 0) {
    console.log(`\n  Modified (${result.modified.length}):`);
    for (const entry of result.modified) {
      console.log(`    ~ ${entry.path}  (${entry.kind})`);
    }
  }

  if (result.warnings.length > 0) {
    console.log(`\n  Warnings:`);
    for (const warning of result.warnings) {
      console.log(`    ! ${warning}`);
    }
  }

  console.log();
  if (result.dryRun) {
    console.log("Dry run — no files were changed.");
  } else {
    console.log("Migration complete. Each affected repo has dirty working-tree changes; commit them when ready.");
  }
}

async function handlePromote(
  detection: Extract<MigrationDetection, { kind: "promotable-source" }>,
  options: MigrateCliOptions,
): Promise<{ ok: true; result: MigrationResult } | { ok: false; reason: string }> {
  const workspaceName = options.workspaceName ?? detection.suggestedWorkspaceName;
  const parentDir = dirname(detection.sourceRoot);
  const workspaceRoot = join(parentDir, workspaceName);
  const newSourceRoot = join(workspaceRoot, basename(detection.sourceRoot));
  const newTreeRoot = join(workspaceRoot, basename(detection.treeRoot));

  console.log(
    "Single repo + sibling tree detected. To migrate, both repos will be moved into a new parent directory:\n",
  );
  console.log(`  Workspace root (new):   ${workspaceRoot}`);
  console.log(`  Source repo (moves to): ${newSourceRoot}`);
  console.log(`  Tree repo   (moves to): ${newTreeRoot}\n`);
  console.log("Each repo's .git/ travels with the move; no git operations are performed.\n");

  if (options.dryRun) {
    const plan = promoteToWorkspace(detection, { workspaceName, dryRun: true });
    console.log(`Dry run — would mkdir ${plan.workspaceRoot} and move both repos into it.`);
    const cleanupPlan = migrateWorkspaceToW1(
      {
        kind: "workspace",
        workspaceRoot: plan.workspaceRoot,
        treeRoot: plan.newTreeRoot,
        sourceRoots: [plan.newSourceRoot],
      },
      { dryRun: true },
    );
    printResult(cleanupPlan, "Dry-run cleanup plan");
    return { ok: true, result: cleanupPlan };
  }

  if (!options.yes) {
    const accepted = await confirm({ message: "Proceed with the move?", default: false });
    if (!accepted) {
      return { ok: false, reason: "User declined the promote step. No changes made." };
    }
  }

  const promote = promoteToWorkspace(detection, { workspaceName });

  const result = migrateWorkspaceToW1(
    {
      kind: "workspace",
      workspaceRoot: promote.workspaceRoot,
      treeRoot: promote.newTreeRoot,
      sourceRoots: [promote.newSourceRoot],
    },
    { dryRun: options.dryRun ?? false },
  );

  console.log(`Promoted to workspace: ${promote.workspaceRoot}`);
  return { ok: true, result };
}

async function runMigrateCommand(context: CommandContext): Promise<void> {
  try {
    const options = readMigrateOptions(context.command);
    const detection = detectMigrationState(process.cwd());

    if (context.options.json && detection.kind !== "workspace" && detection.kind !== "promotable-source") {
      console.log(JSON.stringify({ detection }, null, 2));
      return;
    }

    switch (detection.kind) {
      case "already-migrated": {
        console.log(`Already migrated: ${detection.workspaceRoot}`);
        console.log("`.first-tree/workspace.json` is present. Nothing to do.");
        return;
      }

      case "not-applicable": {
        console.error(`Cannot migrate: ${detection.reason}`);
        process.exitCode = 1;
        return;
      }

      case "workspace": {
        const result = migrateWorkspaceToW1(detection, { dryRun: options.dryRun ?? false });
        if (context.options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printResult(result, options.dryRun ? "Dry-run migration plan" : "First Tree workspace migrated to W1");
        return;
      }

      case "promotable-source": {
        const outcome = await handlePromote(detection, options);
        if (!outcome.ok) {
          console.log(outcome.reason);
          return;
        }
        if (context.options.json) {
          console.log(JSON.stringify(outcome.result, null, 2));
          return;
        }
        printResult(outcome.result, options.dryRun ? "Dry-run migration plan" : "First Tree workspace migrated to W1");
        return;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export const migrateCommand: SubcommandModule = {
  name: "migrate-to-w1",
  alias: "",
  summary: "",
  description: "Migrate a legacy workspace onto the W1 (workspace-rooted) layout.",
  action: runMigrateCommand,
  configure: configureMigrateCommand,
};
