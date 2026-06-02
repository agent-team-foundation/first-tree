import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { channelConfig } from "../../core/channel.js";
import {
  type BoundTreeReference,
  buildTreeId,
  deriveDefaultEntrypoint,
  type RootKind,
  removeSourceState,
  type SourceBindingMode,
  type TreeMode,
} from "./binding-state.js";
import { bootstrapTreeRoot } from "./bootstrap.js";
import { isGitRepoRoot, parseGitHubRemoteUrl, readGitRemoteUrl, repoNameForRoot, runCommand } from "./shared.js";
import { copyCanonicalSkills } from "./skill-lib.js";
import {
  ensureWhitepaperSymlink,
  upsertLocalTreeGitIgnore,
  upsertSourceIntegrationFiles,
} from "./source-integration.js";
import { syncTreeSourceRepoIndex } from "./source-repo-index.js";
import { readTreeIdentityContract, syncTreeIdentityFiles } from "./tree-identity.js";
import { upsertTreeCodeRepoRegistry } from "./tree-repo-registry.js";

type BindModeOption = SourceBindingMode | "source";

export type BindOptions = {
  entrypoint?: string;
  mode?: BindModeOption;
  treeMode?: TreeMode;
  treePath?: string;
  treeUrl?: string;
  workspaceId?: string;
  workspaceRoot?: string;
};

type BindSummary = {
  bindingMode: SourceBindingMode;
  rootKind: RootKind;
  sourceRoot: string;
  treeMode: TreeMode;
  treeRoot: string;
  workspaceId?: string;
};

type BindingContext = {
  bindingMode: SourceBindingMode;
  entrypoint: string;
  rootKind: RootKind;
  sourceRemoteUrl?: string;
  sourceRepoName: string;
  treeMode: TreeMode;
  treeReference: BoundTreeReference;
  workspaceId?: string;
};

export function inferTreeRepoNameFromUrl(treeUrl: string): string {
  const parsed = parseGitHubRemoteUrl(treeUrl);
  if (parsed !== null) {
    return parsed.repo;
  }

  return basename(treeUrl).replace(/\.git$/u, "");
}

export function inferTreeMode(sourceRepoName: string, treeRepoName: string, explicit?: TreeMode): TreeMode {
  if (explicit !== undefined) {
    if (explicit !== "dedicated" && explicit !== "shared") {
      throw new Error(`Unsupported value for --tree-mode: ${explicit}`);
    }
    return explicit;
  }

  const defaultDedicatedNames = new Set([`${sourceRepoName}-tree`, `${sourceRepoName}-context`]);

  return defaultDedicatedNames.has(treeRepoName) ? "dedicated" : "shared";
}

export function resolveBindingMode(explicit: BindModeOption | undefined, treeMode: TreeMode): SourceBindingMode {
  if (explicit === "source") {
    return treeMode === "shared" ? "shared-source" : "standalone-source";
  }

  if (explicit !== undefined) {
    if (
      explicit !== "standalone-source" &&
      explicit !== "shared-source" &&
      explicit !== "workspace-root" &&
      explicit !== "workspace-member"
    ) {
      throw new Error(`Unsupported value for --mode: ${explicit}`);
    }
    return explicit;
  }

  return treeMode === "shared" ? "shared-source" : "standalone-source";
}

export function resolveWorkspaceId(
  sourceRoot: string,
  bindingMode: SourceBindingMode,
  explicit?: string,
): string | undefined {
  if (bindingMode !== "workspace-root" && bindingMode !== "workspace-member") {
    return undefined;
  }

  return explicit?.trim() || repoNameForRoot(sourceRoot);
}

export function ensureTreeCheckout(
  cwd: string,
  sourceRoot: string,
  options: BindOptions,
): { treeRepoName: string; treeRoot: string; treeUrl?: string } {
  let treeRoot = options.treePath ? resolve(cwd, options.treePath) : undefined;
  let treeUrl = options.treeUrl?.trim() || undefined;

  if (treeRoot === undefined && treeUrl === undefined) {
    throw new Error("Missing --tree-path or --tree-url.");
  }

  if (treeRoot === undefined && treeUrl !== undefined) {
    const inferredName = inferTreeRepoNameFromUrl(treeUrl);
    treeRoot = join(dirname(sourceRoot), inferredName);

    if (!existsSync(treeRoot)) {
      runCommand("git", ["clone", treeUrl, treeRoot], dirname(treeRoot));
    }
  }

  if (treeRoot === undefined) {
    throw new Error("Could not resolve the tree checkout.");
  }

  if (!isGitRepoRoot(treeRoot)) {
    throw new Error(
      `Tree checkout is not a git repository: ${treeRoot}. Point bind at an existing tree checkout first.`,
    );
  }

  if (resolve(treeRoot) === resolve(sourceRoot)) {
    throw new Error("The source/workspace root and tree repo resolved to the same path.");
  }

  treeUrl = treeUrl ?? readGitRemoteUrl(treeRoot) ?? readTreeIdentityContract(treeRoot)?.publishedTreeUrl;

  return {
    treeRepoName: repoNameForRoot(treeRoot),
    treeRoot,
    ...(treeUrl ? { treeUrl } : {}),
  };
}

export function bindSourceRoot(sourceRoot: string, options: BindOptions, commandCwd = process.cwd()): BindSummary {
  const treeResolution = ensureTreeCheckout(commandCwd, sourceRoot, options);
  const binding = deriveBindingContext(sourceRoot, treeResolution, options);

  if (readTreeIdentityContract(treeResolution.treeRoot) === undefined) {
    bootstrapTreeRoot(treeResolution.treeRoot, {
      treeMode: binding.treeMode,
    });
  }

  copyCanonicalSkills(sourceRoot);
  copyCanonicalSkills(treeResolution.treeRoot);
  ensureWhitepaperSymlink(sourceRoot);
  upsertLocalTreeGitIgnore(sourceRoot);
  upsertSourceIntegrationFiles(sourceRoot, treeResolution.treeRepoName, {
    binName: channelConfig.binName,
    bindingMode: binding.bindingMode,
    entrypoint: binding.entrypoint,
    treeMode: binding.treeMode,
    treeRepoUrl: treeResolution.treeUrl,
    workspaceId: binding.workspaceId,
  });
  removeSourceState(sourceRoot);

  writeBoundTreeState(treeResolution.treeRoot, treeResolution.treeRepoName, binding.treeMode, treeResolution.treeUrl);

  if (binding.sourceRemoteUrl && parseGitHubRemoteUrl(binding.sourceRemoteUrl) !== null) {
    upsertTreeCodeRepoRegistry(treeResolution.treeRoot, binding.sourceRemoteUrl);
  }

  syncTreeSourceRepoIndex(treeResolution.treeRoot);

  return {
    bindingMode: binding.bindingMode,
    rootKind: binding.rootKind,
    sourceRoot,
    treeMode: binding.treeMode,
    treeRoot: treeResolution.treeRoot,
    ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}),
  };
}

export function deriveBindingContext(
  sourceRoot: string,
  treeResolution: { treeRepoName: string; treeRoot: string; treeUrl?: string },
  options: BindOptions,
): BindingContext {
  const sourceRepoName = repoNameForRoot(sourceRoot);
  const treeMode = inferTreeMode(sourceRepoName, treeResolution.treeRepoName, options.treeMode);
  const bindingMode = resolveBindingMode(options.mode, treeMode);
  const workspaceId = resolveWorkspaceId(sourceRoot, bindingMode, options.workspaceId);
  const sourceRemoteUrl = isGitRepoRoot(sourceRoot) ? readGitRemoteUrl(sourceRoot) : undefined;
  const entrypoint = options.entrypoint ?? deriveDefaultEntrypoint(bindingMode, sourceRepoName, workspaceId);

  return {
    bindingMode,
    entrypoint,
    rootKind: isGitRepoRoot(sourceRoot) ? "git-repo" : "folder",
    ...(sourceRemoteUrl ? { sourceRemoteUrl } : {}),
    sourceRepoName,
    treeMode,
    treeReference: {
      entrypoint,
      ...(treeResolution.treeUrl ? { remoteUrl: treeResolution.treeUrl } : {}),
      treeId: buildTreeId(treeResolution.treeRepoName),
      treeMode,
      treeRepoName: treeResolution.treeRepoName,
    },
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export function writeBoundTreeState(
  treeRoot: string,
  treeRepoName: string,
  treeMode: TreeMode,
  resolvedTreeUrl?: string,
): void {
  const existingIdentity = readTreeIdentityContract(treeRoot);
  const publishedTreeUrl = resolvedTreeUrl ?? existingIdentity?.publishedTreeUrl;

  syncTreeIdentityFiles(treeRoot, {
    ...(publishedTreeUrl ? { publishedTreeUrl } : {}),
    treeMode,
    treeRepoName,
  });
}
