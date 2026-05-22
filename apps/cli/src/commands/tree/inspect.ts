import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CommandContext, SubcommandModule } from "../types.js";
import { findUpwardsManagedSourceBinding, parseGitHubRepoReference } from "./binding-contract.js";
import { findUpwardsManagedTreeIdentity } from "./tree-identity.js";

type InspectClassification = "tree-repo" | "workspace-root" | "source-repo" | "git-repo" | "folder";
type InspectRole =
  | "tree-repo"
  | "workspace-root-bound"
  | "source-repo-bound"
  | "unbound-workspace-root"
  | "unbound-source-repo"
  | "unknown";

type BindingSummary = {
  bindingMode?: string;
  scope?: string;
  treeEntrypoint?: string;
  treeMode?: string;
  treeRemoteUrl?: string;
  treeRepo?: string;
  treeRepoName?: string;
};

export type InspectResult = {
  binding?: BindingSummary;
  classification: InspectClassification;
  cwd: string;
  hasMembersNode: boolean;
  hasNode: boolean;
  role: InspectRole;
  rootKind: "git-repo" | "folder";
  rootPath: string;
  sourceStatePath?: string;
  treeStatePath?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readJson(path: string | undefined): unknown | undefined {
  if (path === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function findUpwards(startDir: string, relativePath: string): string | undefined {
  let currentDir = resolve(startDir);

  while (true) {
    const candidate = join(currentDir, relativePath);

    if (existsSync(candidate)) {
      return candidate;
    }

    const parentDir = dirname(currentDir);

    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
}

function summarizeManagedBinding(
  binding: ReturnType<typeof findUpwardsManagedSourceBinding>,
): BindingSummary | undefined {
  if (binding === undefined) {
    return undefined;
  }

  return {
    ...(binding.bindingMode ? { bindingMode: binding.bindingMode } : {}),
    ...(binding.entrypoint ? { treeEntrypoint: binding.entrypoint } : {}),
    ...(binding.scope ? { scope: binding.scope } : {}),
    ...(binding.treeMode ? { treeMode: binding.treeMode } : {}),
    ...(binding.treeRepoSlug ? { treeRepo: binding.treeRepoSlug } : {}),
    ...(binding.treeRepoName ? { treeRepoName: binding.treeRepoName } : {}),
    ...(binding.treeRepoUrl ? { treeRemoteUrl: binding.treeRepoUrl } : {}),
  };
}

function summarizeManagedTreeIdentity(
  identity: ReturnType<typeof findUpwardsManagedTreeIdentity>,
): BindingSummary | undefined {
  if (identity === undefined) {
    return undefined;
  }

  return {
    ...(identity.treeMode ? { treeMode: identity.treeMode } : {}),
    ...(identity.treeRepoName ? { treeRepoName: identity.treeRepoName } : {}),
    ...(identity.publishedTreeUrl ? { treeRemoteUrl: identity.publishedTreeUrl } : {}),
  };
}

function readLegacyBindingSummary(sourceStatePath: string | undefined): BindingSummary | undefined {
  const parsed = readJson(sourceStatePath);

  if (!isRecord(parsed)) {
    return undefined;
  }

  const tree = isRecord(parsed.tree) ? parsed.tree : undefined;

  if (tree === undefined) {
    return undefined;
  }

  return {
    bindingMode: asString(parsed.bindingMode) ?? asString(parsed.mode),
    scope: asString(parsed.scope),
    treeEntrypoint: asString(tree.entrypoint),
    treeMode: asString(tree.treeMode) ?? asString(tree.mode),
    treeRemoteUrl: asString(tree.remoteUrl),
    treeRepo:
      parseGitHubRepoReference(asString(tree.repo)) ??
      parseGitHubRepoReference(asString(tree.treeRepo)) ??
      parseGitHubRepoReference(asString(parsed.treeRepo)) ??
      parseGitHubRepoReference(asString(parsed.tree_repo)) ??
      parseGitHubRepoReference(asString(tree.remoteUrl)),
    treeRepoName: asString(tree.treeRepoName),
  };
}

function readTreeRepoName(treeStatePath: string | undefined): string | undefined {
  const parsed = readJson(treeStatePath);

  if (!isRecord(parsed)) {
    return undefined;
  }

  return asString(parsed.treeRepoName);
}

function looksLikeWorkspaceRoot(rootPath: string): boolean {
  try {
    const entries = readdirSync(rootPath, { withFileTypes: true });
    let repoCount = 0;

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }

      if (existsSync(join(rootPath, entry.name, ".git"))) {
        repoCount += 1;
      }

      if (repoCount >= 2) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

function resolveInspectRootPath(
  cwd: string,
  sourceBindingRoot: string | undefined,
  sourceStatePath: string | undefined,
  treeStatePath: string | undefined,
  gitMarkerPath: string | undefined,
): string {
  if (sourceBindingRoot !== undefined) {
    return sourceBindingRoot;
  }

  if (sourceStatePath !== undefined) {
    return dirname(dirname(sourceStatePath));
  }

  if (treeStatePath !== undefined) {
    return dirname(dirname(treeStatePath));
  }

  if (gitMarkerPath !== undefined) {
    return dirname(gitMarkerPath);
  }

  return resolve(cwd);
}

function deriveClassification(
  treeStatePath: string | undefined,
  hasNode: boolean,
  hasMembersNode: boolean,
  binding: BindingSummary | undefined,
  hasSourceBinding: boolean,
  gitMarkerPath: string | undefined,
): InspectClassification {
  if (treeStatePath !== undefined || (hasNode && hasMembersNode)) {
    return "tree-repo";
  }

  if (binding?.bindingMode === "workspace-root" || binding?.scope === "workspace") {
    return "workspace-root";
  }

  if (hasSourceBinding) {
    return "source-repo";
  }

  if (gitMarkerPath !== undefined) {
    return "git-repo";
  }

  return "folder";
}

function deriveRole(
  classification: InspectClassification,
  workspaceLikeRoot: boolean,
  gitMarkerPath: string | undefined,
): InspectRole {
  if (classification === "tree-repo") {
    return "tree-repo";
  }

  if (classification === "workspace-root") {
    return "workspace-root-bound";
  }

  if (classification === "source-repo") {
    return "source-repo-bound";
  }

  if (workspaceLikeRoot) {
    return "unbound-workspace-root";
  }

  if (gitMarkerPath !== undefined) {
    return "unbound-source-repo";
  }

  return "unknown";
}

function formatInspectResult(result: InspectResult): string {
  const lines = [
    "first-tree tree inspect",
    `cwd: ${result.cwd}`,
    `root: ${result.rootPath}`,
    `role: ${result.role}`,
    `classification: ${result.classification}`,
    `root kind: ${result.rootKind}`,
  ];

  if (result.sourceStatePath !== undefined) {
    lines.push(`source state: ${result.sourceStatePath}`);
  }

  if (result.treeStatePath !== undefined) {
    lines.push(`tree state: ${result.treeStatePath}`);
  }

  if (result.hasNode || result.hasMembersNode) {
    lines.push(`tree markers: NODE.md=${result.hasNode} members/NODE.md=${result.hasMembersNode}`);
  }

  if (result.binding !== undefined) {
    if (result.binding.bindingMode !== undefined) {
      lines.push(`binding mode: ${result.binding.bindingMode}`);
    }

    if (result.binding.scope !== undefined) {
      lines.push(`scope: ${result.binding.scope}`);
    }

    if (result.binding.treeMode !== undefined) {
      lines.push(`tree mode: ${result.binding.treeMode}`);
    }

    if (result.binding.treeRepo !== undefined) {
      lines.push(`tree repo: ${result.binding.treeRepo}`);
    } else if (result.binding.treeRepoName !== undefined) {
      lines.push(`tree repo name: ${result.binding.treeRepoName}`);
    }

    if (result.binding.treeRemoteUrl !== undefined) {
      lines.push(`tree remote: ${result.binding.treeRemoteUrl}`);
    }

    if (result.binding.treeEntrypoint !== undefined) {
      lines.push(`tree entrypoint: ${result.binding.treeEntrypoint}`);
    }
  } else {
    lines.push("binding: none");
  }

  return lines.join("\n");
}

export function inspectCurrentWorkingTree(cwd = process.cwd()): InspectResult {
  const managedBinding = findUpwardsManagedSourceBinding(cwd);
  const managedTreeIdentity = findUpwardsManagedTreeIdentity(cwd);
  const sourceStatePath = findUpwards(cwd, ".first-tree/source.json");
  const treeStatePath = findUpwards(cwd, ".first-tree/tree.json");
  const gitMarkerPath = findUpwards(cwd, ".git");
  const rootPath = resolveInspectRootPath(
    cwd,
    managedBinding
      ? dirname(managedBinding.path)
      : managedTreeIdentity
        ? dirname(managedTreeIdentity.path)
        : undefined,
    sourceStatePath,
    treeStatePath,
    gitMarkerPath,
  );
  const binding =
    summarizeManagedBinding(managedBinding) ??
    summarizeManagedTreeIdentity(managedTreeIdentity) ??
    readLegacyBindingSummary(sourceStatePath);
  const hasNode = existsSync(join(rootPath, "NODE.md"));
  const hasMembersNode = existsSync(join(rootPath, "members", "NODE.md"));
  const treeRepoName = readTreeRepoName(treeStatePath);
  const workspaceLikeRoot = looksLikeWorkspaceRoot(rootPath);

  const classification = deriveClassification(
    managedTreeIdentity?.path ?? treeStatePath,
    hasNode,
    hasMembersNode,
    binding,
    managedBinding !== undefined || sourceStatePath !== undefined,
    gitMarkerPath,
  );
  const role = deriveRole(classification, workspaceLikeRoot, gitMarkerPath);

  return {
    binding: binding ?? (treeRepoName !== undefined ? { treeRepoName } : undefined),
    classification,
    cwd: resolve(cwd),
    hasMembersNode,
    hasNode,
    role,
    rootKind: gitMarkerPath !== undefined ? "git-repo" : "folder",
    rootPath,
    sourceStatePath,
    treeStatePath,
  };
}

export function runInspectCommand(context: CommandContext): void {
  const result = inspectCurrentWorkingTree();

  if (context.options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatInspectResult(result));
}

export const inspectCommand: SubcommandModule = {
  name: "inspect",
  alias: "",
  summary: "",
  description: "Inspect the current folder and report first-tree metadata.",
  action: runInspectCommand,
};
