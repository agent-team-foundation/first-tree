import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { readSourceState, type SourceBindingMode, type TreeMode } from "./binding-state.js";
import { parseGitHubRemoteUrl } from "./shared.js";

export type SourceIntegrationFile = "AGENTS.md" | "CLAUDE.md";

export const SOURCE_INTEGRATION_BEGIN = "<!-- BEGIN FIRST-TREE-SOURCE-INTEGRATION -->";
export const SOURCE_INTEGRATION_END = "<!-- END FIRST-TREE-SOURCE-INTEGRATION -->";
export const SOURCE_INTEGRATION_MARKER = "FIRST-TREE-SOURCE-INTEGRATION:";
export const BINDING_CONTRACT_MARKER = "FIRST-TREE-BINDING-CONTRACT:";
export const TREE_REPO_MARKER = "FIRST-TREE-TREE-REPO:";
export const TREE_REPO_SLUG_MARKER = "FIRST-TREE-TREE-REPO-SLUG:";
export const TREE_MODE_MARKER = "FIRST-TREE-TREE-MODE:";
export const BINDING_MODE_MARKER = "FIRST-TREE-BINDING-MODE:";
export const TREE_REPO_URL_MARKER = "FIRST-TREE-TREE-REPO-URL:";
export const ENTRYPOINT_MARKER = "FIRST-TREE-ENTRYPOINT:";
export const WORKSPACE_ID_MARKER = "FIRST-TREE-WORKSPACE-ID:";
export const SOURCE_STATE_MARKER = "FIRST-TREE-SOURCE-STATE:";
export const SOURCE_INTEGRATION_FILES: readonly SourceIntegrationFile[] = [
  "AGENTS.md",
  "CLAUDE.md",
] as const;

export type ParsedSourceBindingContract = {
  bindingContract?: string;
  bindingMode?: SourceBindingMode;
  entrypoint?: string;
  scope?: "repo" | "workspace";
  sourceStatePath?: string;
  treeMode?: TreeMode;
  treeRepoName?: string;
  treeRepoSlug?: string;
  treeRepoUrl?: string;
  workspaceId?: string;
};

export type ManagedSourceBinding = ParsedSourceBindingContract & {
  file: SourceIntegrationFile;
  path: string;
};

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MANAGED_BLOCK_VERSION = "managed-block-v1";

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function extractManagedBlock(text: string): string | undefined {
  const normalized = text.replaceAll("\r\n", "\n");
  const managedBlock = new RegExp(
    `${escapeForRegExp(SOURCE_INTEGRATION_BEGIN)}[\\s\\S]*?${escapeForRegExp(SOURCE_INTEGRATION_END)}`,
    "mu",
  );

  return normalized.match(managedBlock)?.[0];
}

function readMarker(block: string, marker: string): string | undefined {
  const match = block.match(
    new RegExp(`^${escapeForRegExp(marker)}\\s+(?:\`(.+?)\`|(.+?))\\s*$`, "mu"),
  );
  const value = match?.[1] ?? match?.[2];
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseBindingMode(value: string | undefined): SourceBindingMode | undefined {
  switch (value) {
    case "standalone-source":
    case "shared-source":
    case "workspace-root":
    case "workspace-member":
      return value;
    default:
      return undefined;
  }
}

function parseTreeMode(value: string | undefined): TreeMode | undefined {
  return value === "dedicated" || value === "shared" ? value : undefined;
}

function deriveScope(bindingMode: SourceBindingMode | undefined): "repo" | "workspace" | undefined {
  if (bindingMode === undefined) {
    return undefined;
  }

  return bindingMode === "workspace-root" || bindingMode === "workspace-member"
    ? "workspace"
    : "repo";
}

export function parseGitHubRepoReference(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  if (GITHUB_REPO_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const parsed = parseGitHubRemoteUrl(trimmed);

  if (parsed === null || parsed.host.toLowerCase() !== "github.com") {
    return undefined;
  }

  return `${parsed.owner}/${parsed.repo}`;
}

export function parseManagedSourceBindingText(
  text: string,
): ParsedSourceBindingContract | undefined {
  const block = extractManagedBlock(text);

  if (block === undefined) {
    return undefined;
  }

  const bindingMode = parseBindingMode(readMarker(block, BINDING_MODE_MARKER));
  const treeMode = parseTreeMode(readMarker(block, TREE_MODE_MARKER));
  const treeRepoName = readMarker(block, TREE_REPO_MARKER);
  const treeRepoUrl = (() => {
    const value = readMarker(block, TREE_REPO_URL_MARKER);
    return value === "pending publish" ? undefined : value;
  })();
  const treeRepoSlug =
    parseGitHubRepoReference(readMarker(block, TREE_REPO_SLUG_MARKER)) ??
    parseGitHubRepoReference(treeRepoUrl);
  const entrypoint = readMarker(block, ENTRYPOINT_MARKER);
  const sourceStatePath = readMarker(block, SOURCE_STATE_MARKER);
  const workspaceId = readMarker(block, WORKSPACE_ID_MARKER);

  if (
    bindingMode === undefined &&
    treeMode === undefined &&
    treeRepoName === undefined &&
    treeRepoUrl === undefined &&
    treeRepoSlug === undefined &&
    entrypoint === undefined &&
    workspaceId === undefined
  ) {
    return undefined;
  }

  return {
    bindingContract: readMarker(block, BINDING_CONTRACT_MARKER) ?? MANAGED_BLOCK_VERSION,
    ...(bindingMode ? { bindingMode } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    ...(sourceStatePath ? { sourceStatePath } : {}),
    ...(treeMode ? { treeMode } : {}),
    ...(treeRepoName ? { treeRepoName } : {}),
    ...(treeRepoSlug ? { treeRepoSlug } : {}),
    ...(treeRepoUrl ? { treeRepoUrl } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(deriveScope(bindingMode) ? { scope: deriveScope(bindingMode) } : {}),
  };
}

export function readManagedSourceBinding(root: string): ManagedSourceBinding | undefined {
  for (const file of SOURCE_INTEGRATION_FILES) {
    const path = join(root, file);

    if (!existsSync(path)) {
      continue;
    }

    const parsed = parseManagedSourceBindingText(readFileSync(path, "utf-8"));

    if (parsed !== undefined) {
      return {
        ...parsed,
        file,
        path,
      };
    }
  }

  return undefined;
}

export function findUpwardsManagedSourceBinding(
  startDir: string,
): ManagedSourceBinding | undefined {
  let currentDir = resolve(startDir);

  while (true) {
    const binding = readManagedSourceBinding(currentDir);

    if (binding !== undefined) {
      return binding;
    }

    const parentDir = dirname(currentDir);

    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
}

export function readSourceBindingContract(root: string): ParsedSourceBindingContract | undefined {
  const managedBinding = readManagedSourceBinding(root);

  if (managedBinding !== undefined) {
    return managedBinding;
  }

  const sourceState = readSourceState(root);

  if (sourceState === null) {
    return undefined;
  }

  const treeRepoSlug = parseGitHubRepoReference(sourceState.tree.remoteUrl);

  return {
    bindingContract: "legacy-source-state",
    bindingMode: sourceState.bindingMode,
    entrypoint: sourceState.tree.entrypoint,
    scope: sourceState.scope,
    sourceStatePath: ".first-tree/source.json",
    treeMode: sourceState.tree.treeMode,
    treeRepoName: sourceState.tree.treeRepoName,
    ...(treeRepoSlug ? { treeRepoSlug } : {}),
    ...(sourceState.tree.remoteUrl ? { treeRepoUrl: sourceState.tree.remoteUrl } : {}),
    ...(sourceState.workspaceId ? { workspaceId: sourceState.workspaceId } : {}),
  };
}
