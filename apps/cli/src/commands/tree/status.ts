import { computeWorkspaceStatus, discoverWorkspaceRoot, type WorkspaceStatus } from "../../core/workspace.js";
import type { CommandContext, SubcommandModule } from "../types.js";

/**
 * Read-only status report for the workspace-rooted layout.
 *
 * Walks up from the current working directory looking for
 * `<workspaceRoot>/.first-tree/workspace.json`. When no workspace is found
 * the command exits 1 with a pointer at the onboarding and migration
 * entrypoints — there is no legacy `inspect` fallback under W1.
 *
 * Implements the §status contract in
 *   first-tree-context: first-tree-skill-cli/workspace-layout-simplification.md
 */
export function runStatusCommand(context: CommandContext): void {
  const workspaceRoot = discoverWorkspaceRoot(process.cwd());

  if (workspaceRoot === undefined) {
    console.error("No First Tree workspace found at or above cwd.");
    console.error("- For a new workspace: `first-tree tree init --scope workspace --tree-path ./<name>`");
    console.error("- For a legacy multi-mode layout: `first-tree tree migrate-to-w1`");
    process.exitCode = 1;
    return;
  }

  let status: WorkspaceStatus;
  try {
    status = computeWorkspaceStatus(workspaceRoot);
  } catch (error) {
    console.error(`Failed to read workspace manifest: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (context.options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  printWorkspaceStatus(status);
}

function formatRemote(remoteUrl: string | undefined): string {
  return remoteUrl ? `  ${remoteUrl}` : "";
}

function printWorkspaceStatus(status: WorkspaceStatus): void {
  console.log("First Tree Workspace Status\n");
  console.log(`  Workspace:  ${status.workspaceRoot}`);
  const treeStatusSuffix = status.treePresent ? "" : "  (missing on disk)";
  console.log(`  Tree:       ${status.manifest.tree}${formatRemote(status.treeRemoteUrl)}${treeStatusSuffix}`);
  console.log();

  if (status.boundSources.length === 0) {
    console.log("  Bound sources (0):  none\n");
  } else {
    console.log(`  Bound sources (${status.boundSources.length}):`);
    for (const source of status.boundSources) {
      const marker = source.present ? "✓" : "·";
      const suffix = source.present ? "" : "  (not cloned locally)";
      console.log(`    ${marker} ${source.name}${formatRemote(source.remoteUrl)}${suffix}`);
    }
    console.log();
  }

  if (status.missingBoundSources.length > 0) {
    console.log(`  Missing locally (${status.missingBoundSources.length}):`);
    for (const source of status.missingBoundSources) {
      console.log(`    - ${source.name}  (clone next to the tree, then run \`status\` again)`);
    }
    console.log();
  }

  if (status.unboundGitSiblings.length > 0) {
    console.log(`  Unbound git siblings (${status.unboundGitSiblings.length}):`);
    for (const sibling of status.unboundGitSiblings) {
      console.log(`    ? ${sibling.name}${formatRemote(sibling.remoteUrl)}  (add to workspace.json sources to bind)`);
    }
    console.log();
  }
}

export const statusCommand: SubcommandModule = {
  name: "status",
  alias: "",
  summary: "",
  description: "Show first-tree workspace status.",
  action: runStatusCommand,
};
