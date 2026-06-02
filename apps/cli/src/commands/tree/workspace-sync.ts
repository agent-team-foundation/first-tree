import { resolve } from "node:path";

import { bindSourceRoot } from "./bind.js";
import { discoverWorkspaceRepos, repoNameForRoot } from "./shared.js";
import { upsertLocalTreeGitIgnore } from "./source-integration.js";

type WorkspacePlan = {
  members: ReturnType<typeof discoverWorkspaceRepos>;
  treePath?: string;
  treeUrl?: string;
  workspaceId: string;
  workspaceRoot: string;
};

function applyWorkspaceSync(plan: WorkspacePlan): boolean {
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
      console.log(`  Failed ${member.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
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
