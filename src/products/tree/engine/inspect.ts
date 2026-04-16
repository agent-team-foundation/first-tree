import { resolve } from "node:path";
import { Repo } from "#products/tree/engine/repo.js";
import {
  readSourceState,
  readTreeState,
  readWorkspaceState,
} from "#products/tree/engine/runtime/binding-state.js";
import { readLocalTreeConfig } from "#products/tree/engine/runtime/local-tree-config.js";
import { discoverWorkspaceRepos } from "#products/tree/engine/workspace.js";

export const INSPECT_USAGE = `usage: first-tree inspect [--json]

Inspect the current folder and report how first-tree would classify it.

Output includes:
  - resolved root and whether it is a git repo or plain folder
  - whether the root looks like a tree repo, source repo, or workspace root
  - discovered child repos / submodules for workspace onboarding
  - any existing first-tree binding metadata

Options:
  --json   Emit machine-readable JSON
  --help   Show this help message
`;

export interface InspectionResult {
  childRepos: ReturnType<typeof discoverWorkspaceRepos>;
  classification:
    | "ambiguous-folder"
    | "ambiguous-repo"
    | "source-repo"
    | "tree-repo"
    | "workspace-folder"
    | "workspace-repo";
  currentCwd: string;
  hasSourceIntegration: boolean;
  root: string;
  rootKind: "folder" | "git-repo";
  sourceState: ReturnType<typeof readSourceState>;
  treeState: ReturnType<typeof readTreeState>;
  workspaceState: ReturnType<typeof readWorkspaceState>;
  localTreeConfig: ReturnType<typeof readLocalTreeConfig>;
}

export function inspectRepo(repo?: Repo): InspectionResult {
  const workingRepo = repo ?? new Repo();
  const childRepos = discoverWorkspaceRepos(workingRepo.root);
  const rootKind = workingRepo.isGitRepo() ? "git-repo" : "folder";

  let classification: InspectionResult["classification"];
  if (workingRepo.looksLikeTreeRepo()) {
    classification = "tree-repo";
  } else if (rootKind === "folder") {
    classification = childRepos.length > 0 ? "workspace-folder" : "ambiguous-folder";
  } else if (childRepos.length > 0) {
    classification = "workspace-repo";
  } else if (workingRepo.isLikelySourceRepo() || workingRepo.hasSourceWorkspaceIntegration()) {
    classification = "source-repo";
  } else {
    classification = "ambiguous-repo";
  }

  return {
    childRepos,
    classification,
    currentCwd: resolve(process.cwd()),
    hasSourceIntegration: workingRepo.hasSourceWorkspaceIntegration(),
    localTreeConfig: readLocalTreeConfig(workingRepo.root),
    root: workingRepo.root,
    rootKind,
    sourceState: readSourceState(workingRepo.root),
    treeState: readTreeState(workingRepo.root),
    workspaceState: readWorkspaceState(workingRepo.root),
  };
}

export function runInspect(repo?: Repo, json = false): number {
  const inspection = inspectRepo(repo);
  if (json) {
    console.log(JSON.stringify(inspection, null, 2));
    return 0;
  }

  console.log("first-tree inspect\n");
  console.log(`  Root:           ${inspection.root}`);
  console.log(`  Root kind:      ${inspection.rootKind}`);
  console.log(`  Classification: ${inspection.classification}`);
  console.log(`  Child repos:    ${inspection.childRepos.length}`);
  if (inspection.sourceState !== null) {
    console.log(`  Binding mode:   ${inspection.sourceState.bindingMode}`);
    console.log(`  Tree repo:      ${inspection.sourceState.tree.treeRepoName}`);
  } else if (inspection.treeState !== null) {
    console.log(`  Tree mode:      ${inspection.treeState.treeMode}`);
    console.log(`  Tree repo:      ${inspection.treeState.treeRepoName}`);
  }
  if (inspection.childRepos.length > 0) {
    console.log();
    for (const childRepo of inspection.childRepos) {
      console.log(`  - ${childRepo.relativePath} (${childRepo.kind})`);
    }
  }
  return 0;
}

export function runInspectCli(args: string[] = []): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(INSPECT_USAGE);
    return 0;
  }
  const json = args.includes("--json");
  if (args.length > (json ? 1 : 0)) {
    const unknown = args.find((arg) => arg !== "--json");
    if (unknown !== undefined) {
      console.error(`Unknown inspect option: ${unknown}`);
      console.log(INSPECT_USAGE);
      return 1;
    }
  }
  return runInspect(undefined, json);
}
