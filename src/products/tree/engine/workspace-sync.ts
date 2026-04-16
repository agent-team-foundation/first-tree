import { resolve } from "node:path";
import { runBind, type BindOptions } from "#products/tree/engine/bind.js";
import { Repo } from "#products/tree/engine/repo.js";
import {
  readSourceState,
  type SourceBindingMode,
} from "#products/tree/engine/runtime/binding-state.js";
import { discoverWorkspaceRepos } from "#products/tree/engine/workspace.js";

export const WORKSPACE_SYNC_USAGE = `usage: first-tree workspace sync [--tree-path PATH | --tree-url URL] [--workspace-id ID] [--dry-run]

Bind every discovered child repo / submodule under the current workspace root
to the same shared Context Tree.

Options:
  --tree-path PATH   Local checkout of the shared tree repo
  --tree-url URL     Remote URL of the shared tree repo
  --workspace-id ID  Workspace identifier (default: derive from current root)
  --dry-run          Print discovered repos without modifying them
  --help             Show this help message
`;

export interface ParsedWorkspaceSyncArgs {
  dryRun?: boolean;
  treePath?: string;
  treeUrl?: string;
  workspaceId?: string;
}

export interface WorkspaceSyncOptions extends ParsedWorkspaceSyncArgs {
  bindOptions?: Pick<BindOptions, "commandRunner" | "sourceRoot">;
}

export function parseWorkspaceSyncArgs(
  args: string[],
): ParsedWorkspaceSyncArgs | { error: string } {
  const parsed: ParsedWorkspaceSyncArgs = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--tree-path":
        parsed.treePath = args[index + 1];
        index += 1;
        break;
      case "--tree-url":
        parsed.treeUrl = args[index + 1];
        index += 1;
        break;
      case "--workspace-id":
        parsed.workspaceId = args[index + 1];
        index += 1;
        break;
      default:
        return { error: `Unknown workspace sync option: ${arg}` };
    }

    if (
      arg !== "--dry-run"
      && (args[index] === undefined || args[index]?.startsWith("--"))
    ) {
      return { error: `Missing value for ${arg}` };
    }
  }

  if (!parsed.treePath && !parsed.treeUrl) {
    return { error: "Missing --tree-path or --tree-url" };
  }

  return parsed;
}

function workspaceIdForRoot(repo: Repo, explicit?: string): string {
  return explicit?.trim() || repo.repoName();
}

export function runWorkspaceSync(repo?: Repo, options?: WorkspaceSyncOptions): number {
  const workspaceRoot = repo ?? new Repo();
  const members = discoverWorkspaceRepos(workspaceRoot.root);
  const workspaceId = workspaceIdForRoot(workspaceRoot, options?.workspaceId);
  const rootSourceState = readSourceState(workspaceRoot.root);
  const treePath = options?.treePath
    ?? rootSourceState?.tree.localPath
    ?? undefined;
  const treeUrl = options?.treeUrl
    ?? rootSourceState?.tree.remoteUrl
    ?? undefined;

  if (!treePath && !treeUrl) {
    console.error(
      "Error: could not resolve the shared tree for this workspace. Pass --tree-path or --tree-url, or bind the workspace root first.",
    );
    return 1;
  }

  console.log("Context Tree Workspace Sync\n");
  console.log(`  Workspace root: ${workspaceRoot.root}`);
  console.log(`  Workspace id:   ${workspaceId}`);
  console.log(`  Child repos:    ${members.length}\n`);

  if (members.length === 0) {
    console.log("No child repos or submodules were discovered.");
    return 0;
  }

  if (options?.dryRun) {
    for (const member of members) {
      console.log(`  - ${member.relativePath} (${member.kind})`);
    }
    return 0;
  }

  let hadFailure = false;
  for (const member of members) {
    console.log(`Syncing ${member.relativePath}...`);
    const exitCode = runBind(new Repo(member.root), {
      ...options?.bindOptions,
      currentCwd: workspaceRoot.root,
      mode: "workspace-member" satisfies SourceBindingMode,
      treeMode: "shared",
      treePath: treePath ? resolve(workspaceRoot.root, treePath) : undefined,
      treeUrl,
      workspaceId,
      workspaceRoot: workspaceRoot.root,
    });
    if (exitCode !== 0) {
      hadFailure = true;
    }
  }

  return hadFailure ? 1 : 0;
}

export function runWorkspaceCli(args: string[] = []): number {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(`usage: first-tree workspace <subcommand>\n\nSubcommands:\n  sync   Bind all discovered child repos to the same shared tree\n`);
    return 0;
  }

  if (subcommand !== "sync") {
    console.error(`Unknown workspace subcommand: ${subcommand}`);
    console.log(WORKSPACE_SYNC_USAGE);
    return 1;
  }

  const rest = args.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(WORKSPACE_SYNC_USAGE);
    return 0;
  }

  const parsed = parseWorkspaceSyncArgs(rest);
  if ("error" in parsed) {
    console.error(parsed.error);
    console.log(WORKSPACE_SYNC_USAGE);
    return 1;
  }

  return runWorkspaceSync(undefined, parsed);
}
