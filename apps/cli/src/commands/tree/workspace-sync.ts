import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Command } from "commander";

import type { CommandContext, SubcommandModule } from "../types.js";
import { readSourceBindingContract } from "./binding-contract.js";
import { bindSourceRoot } from "./bind.js";
import { discoverWorkspaceRepos, isGitRepoRoot, repoNameForRoot, runCommand } from "./shared.js";
import { upsertLocalTreeGitIgnore } from "./source-integration.js";

type WorkspaceSyncOptions = {
  dryRun?: boolean;
  treePath?: string;
  treeUrl?: string;
  workspaceId?: string;
};

export const WORKSPACE_SYNC_USAGE = `usage: first-tree tree workspace sync [--tree-path PATH | --tree-url URL] [--workspace-id ID] [--dry-run]

Bind every discovered local child git repo under the current workspace root to the same shared Context Tree.

Options:
  --tree-path PATH   Local checkout of the shared tree repo
  --tree-url URL     Remote URL of the shared tree repo
  --workspace-id ID  Workspace identifier (default: derive from current root)
  --dry-run          Print discovered repos without modifying them
  --help             Show this help message`;

function configureWorkspaceSyncCommand(command: Command): void {
  command
    .option("--tree-path <path>", "local checkout of the shared tree repo")
    .option("--tree-url <url>", "remote URL of the shared tree repo")
    .option("--workspace-id <id>", "workspace identifier")
    .option("--dry-run", "print discovered repos without modifying them");
}

function readWorkspaceSyncOptions(command: Command): WorkspaceSyncOptions {
  const options = command.opts() as Record<string, string | boolean | undefined>;
  return {
    dryRun: options.dryRun === true,
    treePath: typeof options.treePath === "string" ? options.treePath : undefined,
    treeUrl: typeof options.treeUrl === "string" ? options.treeUrl : undefined,
    workspaceId: typeof options.workspaceId === "string" ? options.workspaceId : undefined,
  };
}

function ensureWorkspaceTreePath(
  workspaceRoot: string,
  treeRepoName: string,
  treeUrl?: string,
): string | undefined {
  const siblingRoot = join(dirname(workspaceRoot), treeRepoName);
  if (isGitRepoRoot(siblingRoot)) {
    return siblingRoot;
  }

  if (!treeUrl) {
    return undefined;
  }

  const tempRoot = join(workspaceRoot, ".first-tree", "tmp", treeRepoName);
  if (!existsSync(tempRoot)) {
    mkdirSync(dirname(tempRoot), { recursive: true });
    runCommand("git", ["clone", treeUrl, tempRoot], dirname(tempRoot));
  }

  return tempRoot;
}

function resolveWorkspacePlan(context: CommandContext): {
  members: ReturnType<typeof discoverWorkspaceRepos>;
  treePath?: string;
  treeUrl?: string;
  workspaceId: string;
  workspaceRoot: string;
} {
  const options = readWorkspaceSyncOptions(context.command);
  const workspaceRoot = resolve(process.cwd());
  const workspaceId = options.workspaceId?.trim() || repoNameForRoot(workspaceRoot);
  const rootBinding = readSourceBindingContract(workspaceRoot);
  const treeRepoName = rootBinding?.treeRepoName;
  const treeUrl = options.treeUrl ?? rootBinding?.treeRepoUrl;
  const treePath = options.treePath
    ? resolve(workspaceRoot, options.treePath)
    : treeRepoName
      ? ensureWorkspaceTreePath(workspaceRoot, treeRepoName, treeUrl)
      : undefined;

  if (!treePath && !treeUrl) {
    throw new Error(
      "Could not resolve the shared tree for this workspace. Pass --tree-path or --tree-url, or bind the workspace root first.",
    );
  }

  return {
    members: discoverWorkspaceRepos(workspaceRoot),
    treePath,
    treeUrl,
    workspaceId,
    workspaceRoot,
  };
}

function printWorkspaceDryRun(
  plan: ReturnType<typeof resolveWorkspacePlan>,
  asJson: boolean,
): void {
  const summary = {
    childRepos: plan.members,
    dryRun: true,
    treePath: plan.treePath,
    treeUrl: plan.treeUrl,
    workspaceId: plan.workspaceId,
    workspaceRoot: plan.workspaceRoot,
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("Context Tree Workspace Sync\n");
  console.log(`  Workspace root: ${plan.workspaceRoot}`);
  console.log(`  Workspace id:   ${plan.workspaceId}`);
  console.log(`  Child repos:    ${plan.members.length}\n`);
  for (const member of plan.members) {
    console.log(`  - ${member.relativePath} (${member.kind})`);
  }
}

function applyWorkspaceSync(plan: ReturnType<typeof resolveWorkspacePlan>): boolean {
  upsertLocalTreeGitIgnore(plan.workspaceRoot);

  console.log("Context Tree Workspace Sync\n");
  console.log(`  Workspace root: ${plan.workspaceRoot}`);
  console.log(`  Workspace id:   ${plan.workspaceId}`);
  console.log(`  Child repos:    ${plan.members.length}\n`);

  let hadFailure = false;

  for (const member of plan.members) {
    try {
      bindSourceRoot(
        member.root,
        {
          mode: "workspace-member",
          treeMode: "shared",
          ...(plan.treePath ? { treePath: plan.treePath } : {}),
          ...(plan.treeUrl ? { treeUrl: plan.treeUrl } : {}),
          workspaceId: plan.workspaceId,
          workspaceRoot: plan.workspaceRoot,
        },
        plan.workspaceRoot,
      );
      console.log(`  Bound ${member.relativePath}`);
    } catch (error) {
      hadFailure = true;
      console.log(
        `  Failed ${member.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return hadFailure;
}

export function syncWorkspaceMembersFromRoot(options: {
  treePath?: string;
  treeUrl?: string;
  workspaceId?: string;
  workspaceRoot: string;
}): boolean {
  const workspaceRoot = resolve(options.workspaceRoot);
  const workspaceId = options.workspaceId?.trim() || repoNameForRoot(workspaceRoot);
  const treePath = options.treePath;
  const treeUrl = options.treeUrl;

  if (!treePath && !treeUrl) {
    throw new Error(
      "Could not resolve the shared tree for this workspace. Pass --tree-path or --tree-url, or bind the workspace root first.",
    );
  }

  return applyWorkspaceSync({
    members: discoverWorkspaceRepos(workspaceRoot),
    treePath,
    treeUrl,
    workspaceId,
    workspaceRoot,
  });
}

function runWorkspaceSyncCommand(context: CommandContext): void {
  try {
    const options = readWorkspaceSyncOptions(context.command);
    const plan = resolveWorkspacePlan(context);

    if (options.dryRun || context.options.json) {
      printWorkspaceDryRun(plan, context.options.json);
      return;
    }

    if (applyWorkspaceSync(plan)) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export const workspaceSyncCommand: SubcommandModule = {
  name: "sync",
  alias: "",
  summary: "",
  description: "Bind newly added child repos to the shared tree.",
  action: runWorkspaceSyncCommand,
  configure: configureWorkspaceSyncCommand,
};
