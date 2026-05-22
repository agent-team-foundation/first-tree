import { createHash } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { basename, join, relative } from "node:path";

import {
  RootKind,
  asString,
  isRecord,
  normalizeRemoteForMatch,
  parseGitHubRemoteUrl,
  readJson,
  slugifyToken,
  writeJson,
} from "./shared.js";

export type { RootKind } from "./shared.js";

export type TreeMode = "dedicated" | "shared";

export type SourceBindingMode =
  | "standalone-source"
  | "shared-source"
  | "workspace-root"
  | "workspace-member";

export type SourceScope = "repo" | "workspace";

const SCHEMA_VERSION = 1;

export const TREE_RUNTIME_ROOT = ".first-tree";
export const TREE_VERSION_FILE = join(TREE_RUNTIME_ROOT, "VERSION");
export const TREE_PROGRESS_FILE = join(TREE_RUNTIME_ROOT, "progress.md");
export const SOURCE_STATE_FILE = join(TREE_RUNTIME_ROOT, "source.json");
export const TREE_STATE_FILE = join(TREE_RUNTIME_ROOT, "tree.json");
export const TREE_BINDINGS_DIR = join(TREE_RUNTIME_ROOT, "bindings");
export const TREE_SOURCE_REPOS_FILE = "source-repos.md";

export type BoundTreeReference = {
  entrypoint: string;
  remoteUrl?: string;
  treeId: string;
  treeMode: TreeMode;
  treeRepoName: string;
};

export type WorkspaceMember = {
  bindingMode: "workspace-member";
  entrypoint: string;
  relativePath?: string;
  remoteUrl?: string;
  rootKind: RootKind;
  sourceId: string;
  sourceName: string;
};

export type SourceState = {
  bindingMode: SourceBindingMode;
  members?: WorkspaceMember[];
  rootKind: RootKind;
  schemaVersion: number;
  scope: SourceScope;
  sourceId: string;
  sourceName: string;
  tree: BoundTreeReference;
  workspaceId?: string;
};

export type TreeState = {
  published?: {
    remoteUrl: string;
  };
  schemaVersion: number;
  treeId: string;
  treeMode: TreeMode;
  treeRepoName: string;
};

export type TreeBindingState = {
  bindingMode: SourceBindingMode;
  entrypoint: string;
  remoteUrl?: string;
  rootKind: RootKind;
  schemaVersion: number;
  scope: SourceScope;
  sourceId: string;
  sourceName: string;
  treeMode: TreeMode;
  treeRepoName: string;
  workspaceId?: string;
};

function parseTreeReference(value: unknown): BoundTreeReference | null {
  if (!isRecord(value)) {
    return null;
  }

  const treeId = asString(value.treeId);
  const treeRepoName = asString(value.treeRepoName);
  const entrypoint = asString(value.entrypoint);
  const treeMode = value.treeMode;
  const remoteUrl = asString(value.remoteUrl);

  if (
    treeId === undefined ||
    treeRepoName === undefined ||
    entrypoint === undefined ||
    (treeMode !== "dedicated" && treeMode !== "shared")
  ) {
    return null;
  }

  return {
    entrypoint,
    ...(remoteUrl ? { remoteUrl } : {}),
    treeId,
    treeMode,
    treeRepoName,
  };
}

export function sourceStatePath(root: string): string {
  return join(root, SOURCE_STATE_FILE);
}

export function treeStatePath(root: string): string {
  return join(root, TREE_STATE_FILE);
}

export function treeBindingsDir(root: string): string {
  return join(root, TREE_BINDINGS_DIR);
}

export function treeBindingPath(root: string, sourceId: string): string {
  return join(treeBindingsDir(root), `${sourceId}.json`);
}

export function readSourceState(root: string): SourceState | null {
  const parsed = readJson(sourceStatePath(root));

  if (!isRecord(parsed)) {
    return null;
  }

  const bindingMode = parsed.bindingMode;
  const rootKind = parsed.rootKind;
  const scope = parsed.scope;
  const sourceId = asString(parsed.sourceId);
  const sourceName = asString(parsed.sourceName);
  const tree = parseTreeReference(parsed.tree);
  const workspaceId = asString(parsed.workspaceId);

  if (
    sourceId === undefined ||
    sourceName === undefined ||
    tree === null ||
    (bindingMode !== "standalone-source" &&
      bindingMode !== "shared-source" &&
      bindingMode !== "workspace-root" &&
      bindingMode !== "workspace-member") ||
    (rootKind !== "git-repo" && rootKind !== "folder") ||
    (scope !== "repo" && scope !== "workspace")
  ) {
    return null;
  }

  const members = Array.isArray(parsed.members)
    ? parsed.members
        .map((value) => {
          if (!isRecord(value)) {
            return null;
          }

          const memberSourceId = asString(value.sourceId);
          const memberSourceName = asString(value.sourceName);
          const memberEntrypoint = asString(value.entrypoint);
          const memberRelativePath = asString(value.relativePath);
          const memberRemoteUrl = asString(value.remoteUrl);
          const memberRootKind = value.rootKind;

          if (
            memberSourceId === undefined ||
            memberSourceName === undefined ||
            memberEntrypoint === undefined ||
            (memberRootKind !== "git-repo" && memberRootKind !== "folder")
          ) {
            return null;
          }

          return {
            bindingMode: "workspace-member" as const,
            entrypoint: memberEntrypoint,
            ...(memberRelativePath ? { relativePath: memberRelativePath } : {}),
            ...(memberRemoteUrl ? { remoteUrl: memberRemoteUrl } : {}),
            rootKind: memberRootKind,
            sourceId: memberSourceId,
            sourceName: memberSourceName,
          };
        })
        .filter((value): value is WorkspaceMember => value !== null)
    : undefined;

  return {
    bindingMode,
    ...(members ? { members } : {}),
    rootKind,
    schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : SCHEMA_VERSION,
    scope,
    sourceId,
    sourceName,
    tree,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export function writeSourceState(root: string, state: Omit<SourceState, "schemaVersion">): void {
  writeJson(sourceStatePath(root), {
    ...state,
    schemaVersion: SCHEMA_VERSION,
  });
}

export function removeSourceState(root: string): void {
  rmSync(sourceStatePath(root), { force: true });
}

export function readTreeState(root: string): TreeState | null {
  const parsed = readJson(treeStatePath(root));

  if (!isRecord(parsed)) {
    return null;
  }

  const treeId = asString(parsed.treeId);
  const treeRepoName = asString(parsed.treeRepoName);
  const treeMode = parsed.treeMode;
  const published =
    isRecord(parsed.published) && asString(parsed.published.remoteUrl)
      ? { remoteUrl: parsed.published.remoteUrl as string }
      : undefined;

  if (
    treeId === undefined ||
    treeRepoName === undefined ||
    (treeMode !== "dedicated" && treeMode !== "shared")
  ) {
    return null;
  }

  return {
    ...(published ? { published } : {}),
    schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : SCHEMA_VERSION,
    treeId,
    treeMode,
    treeRepoName,
  };
}

export function writeTreeState(root: string, state: Omit<TreeState, "schemaVersion">): void {
  writeJson(treeStatePath(root), {
    ...state,
    schemaVersion: SCHEMA_VERSION,
  });
}

export function readTreeBinding(root: string, sourceId: string): TreeBindingState | null {
  const parsed = readJson(treeBindingPath(root, sourceId));

  if (!isRecord(parsed)) {
    return null;
  }

  const bindingMode = parsed.bindingMode;
  const entrypoint = asString(parsed.entrypoint);
  const remoteUrl = asString(parsed.remoteUrl);
  const rootKind = parsed.rootKind;
  const scope = parsed.scope;
  const parsedSourceId = asString(parsed.sourceId);
  const sourceName = asString(parsed.sourceName);
  const treeMode = parsed.treeMode;
  const treeRepoName = asString(parsed.treeRepoName);
  const workspaceId = asString(parsed.workspaceId);

  if (
    entrypoint === undefined ||
    parsedSourceId === undefined ||
    sourceName === undefined ||
    treeRepoName === undefined ||
    (bindingMode !== "standalone-source" &&
      bindingMode !== "shared-source" &&
      bindingMode !== "workspace-root" &&
      bindingMode !== "workspace-member") ||
    (rootKind !== "git-repo" && rootKind !== "folder") ||
    (scope !== "repo" && scope !== "workspace") ||
    (treeMode !== "dedicated" && treeMode !== "shared")
  ) {
    return null;
  }

  return {
    bindingMode,
    entrypoint,
    ...(remoteUrl ? { remoteUrl } : {}),
    rootKind,
    schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : SCHEMA_VERSION,
    scope,
    sourceId: parsedSourceId,
    sourceName,
    treeMode,
    treeRepoName,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export function writeTreeBinding(
  root: string,
  sourceId: string,
  binding: Omit<TreeBindingState, "schemaVersion">,
): void {
  writeJson(treeBindingPath(root, sourceId), {
    ...binding,
    schemaVersion: SCHEMA_VERSION,
  });
}

export function listTreeBindings(root: string): TreeBindingState[] {
  try {
    return readdirSync(treeBindingsDir(root))
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readTreeBinding(root, entry.slice(0, -".json".length)))
      .filter((entry): entry is TreeBindingState => entry !== null)
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  } catch {
    return [];
  }
}

export function determineScope(bindingMode: SourceBindingMode): SourceScope {
  return bindingMode === "workspace-root" || bindingMode === "workspace-member"
    ? "workspace"
    : "repo";
}

export function buildStableSourceId(
  sourceName: string,
  options?: {
    fallbackRoot?: string;
    remoteUrl?: string;
  },
): string {
  if (options?.remoteUrl?.trim()) {
    const normalizedRemote = normalizeRemoteForMatch(options.remoteUrl);
    const parsed = parseGitHubRemoteUrl(options.remoteUrl);

    if (parsed !== null) {
      return slugifyToken(`${parsed.host}-${parsed.owner}-${parsed.repo}`);
    }

    const base = slugifyToken(sourceName);
    const digest = createHash("sha1").update(normalizedRemote).digest("hex").slice(0, 8);
    return `${base}-${digest}`;
  }

  const base = slugifyToken(sourceName || basename(options?.fallbackRoot ?? ""));
  const digest = createHash("sha1")
    .update(options?.fallbackRoot ?? sourceName)
    .digest("hex")
    .slice(0, 8);

  return `${base}-${digest}`;
}

export function buildTreeId(treeRepoName: string): string {
  return slugifyToken(treeRepoName);
}

export function deriveDefaultEntrypoint(
  bindingMode: SourceBindingMode,
  sourceName: string,
  workspaceId?: string,
): string {
  switch (bindingMode) {
    case "workspace-root":
      return `/workspaces/${slugifyToken(workspaceId ?? sourceName)}`;
    case "workspace-member":
      return `/workspaces/${slugifyToken(workspaceId ?? "workspace")}/repos/${slugifyToken(sourceName)}`;
    case "shared-source":
      return `/repos/${slugifyToken(sourceName)}`;
    default:
      return "/";
  }
}

export function upsertWorkspaceMember(
  workspaceRoot: string,
  workspaceId: string,
  tree: BoundTreeReference,
  member: WorkspaceMember,
): void {
  const current = readSourceState(workspaceRoot);

  if (current === null) {
    throw new Error("Cannot upsert workspace member without an existing workspace source state.");
  }

  const nextMembers = [
    ...(current.members ?? []).filter((candidate) => candidate.sourceId !== member.sourceId),
    member,
  ].sort((left, right) => {
    const nameOrder = left.sourceName.localeCompare(right.sourceName);
    return nameOrder === 0 ? left.sourceId.localeCompare(right.sourceId) : nameOrder;
  });

  // The `tree` argument carries the *member's* entrypoint (e.g.
  // `/workspaces/<id>/repos/<repo>`). The workspace root has its own entrypoint
  // (e.g. `/workspaces/<id>`) that must be preserved here — otherwise binding a
  // child member silently overwrites the root's entrypoint with the member's
  // address, breaking any downstream consumer that keys off the root binding.
  const mergedTree: BoundTreeReference = {
    ...tree,
    entrypoint: current.tree?.entrypoint ?? tree.entrypoint,
  };

  writeSourceState(workspaceRoot, {
    ...current,
    members: nextMembers,
    tree: mergedTree,
    workspaceId,
  });
}

export function relativePathWithin(root: string, target: string): string {
  return relative(root, target).replace(/\\/gu, "/");
}
