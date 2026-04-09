import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  SOURCE_STATE,
  TREE_BINDINGS_DIR,
  TREE_STATE,
  WORKSPACE_STATE,
} from "#engine/runtime/asset-loader.js";

export type TreeMode = "dedicated" | "shared";
export type SourceBindingMode =
  | "standalone-source"
  | "shared-source"
  | "workspace-root"
  | "workspace-member";
export type RootKind = "git-repo" | "folder";
export type SourceScope = "repo" | "workspace";

const SCHEMA_VERSION = 1;

export interface BoundTreeReference {
  entrypoint: string;
  localPath?: string;
  remoteUrl?: string;
  treeId: string;
  treeMode: TreeMode;
  treeRepoName: string;
}

export interface SourceState {
  bindingMode: SourceBindingMode;
  rootKind: RootKind;
  schemaVersion: number;
  scope: SourceScope;
  sourceId: string;
  sourceName: string;
  tree: BoundTreeReference;
  workspaceId?: string;
  workspaceRootPath?: string;
}

export interface WorkspaceMember {
  bindingMode: "workspace-member";
  relativePath: string;
  rootKind: RootKind;
  sourceId: string;
  sourceName: string;
}

export interface WorkspaceState {
  rootKind: RootKind;
  schemaVersion: number;
  tree: BoundTreeReference;
  workspaceId: string;
  members: WorkspaceMember[];
}

export interface TreeState {
  published?: {
    remoteUrl: string;
  };
  schemaVersion: number;
  treeId: string;
  treeMode: TreeMode;
  treeRepoName: string;
}

export interface TreeBindingState {
  bindingMode: SourceBindingMode;
  entrypoint: string;
  remoteUrl?: string;
  rootKind: RootKind;
  schemaVersion: number;
  scope: SourceScope;
  sourceId: string;
  sourceName: string;
  sourceRootPath: string;
  treeMode: TreeMode;
  treeRepoName: string;
  workspaceId?: string;
  workspaceRootPath?: string;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTreeReference(value: unknown): BoundTreeReference | null {
  if (!isObject(value)) {
    return null;
  }
  if (
    typeof value.treeId !== "string"
    || typeof value.treeRepoName !== "string"
    || (value.treeMode !== "dedicated" && value.treeMode !== "shared")
    || typeof value.entrypoint !== "string"
  ) {
    return null;
  }
  if (value.localPath !== undefined && typeof value.localPath !== "string") {
    return null;
  }
  if (value.remoteUrl !== undefined && typeof value.remoteUrl !== "string") {
    return null;
  }
  return {
    entrypoint: value.entrypoint,
    localPath: value.localPath,
    remoteUrl: value.remoteUrl,
    treeId: value.treeId,
    treeMode: value.treeMode,
    treeRepoName: value.treeRepoName,
  };
}

export function sourceStatePath(root: string): string {
  return join(root, SOURCE_STATE);
}

export function readSourceState(root: string): SourceState | null {
  const parsed = readJson(sourceStatePath(root));
  if (!isObject(parsed)) {
    return null;
  }
  if (
    typeof parsed.sourceId !== "string"
    || typeof parsed.sourceName !== "string"
    || (parsed.rootKind !== "git-repo" && parsed.rootKind !== "folder")
    || (parsed.scope !== "repo" && parsed.scope !== "workspace")
    || (
      parsed.bindingMode !== "standalone-source"
      && parsed.bindingMode !== "shared-source"
      && parsed.bindingMode !== "workspace-root"
      && parsed.bindingMode !== "workspace-member"
    )
  ) {
    return null;
  }
  const tree = parseTreeReference(parsed.tree);
  if (tree === null) {
    return null;
  }
  if (parsed.workspaceId !== undefined && typeof parsed.workspaceId !== "string") {
    return null;
  }
  if (
    parsed.workspaceRootPath !== undefined
    && typeof parsed.workspaceRootPath !== "string"
  ) {
    return null;
  }
  return {
    bindingMode: parsed.bindingMode,
    rootKind: parsed.rootKind,
    schemaVersion:
      typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : SCHEMA_VERSION,
    scope: parsed.scope,
    sourceId: parsed.sourceId,
    sourceName: parsed.sourceName,
    tree,
    workspaceId: parsed.workspaceId,
    workspaceRootPath: parsed.workspaceRootPath,
  };
}

export function writeSourceState(root: string, state: Omit<SourceState, "schemaVersion">): void {
  writeJson(sourceStatePath(root), {
    ...state,
    schemaVersion: SCHEMA_VERSION,
  });
}

export function workspaceStatePath(root: string): string {
  return join(root, WORKSPACE_STATE);
}

export function readWorkspaceState(root: string): WorkspaceState | null {
  const parsed = readJson(workspaceStatePath(root));
  if (!isObject(parsed)) {
    return null;
  }
  if (
    typeof parsed.workspaceId !== "string"
    || (parsed.rootKind !== "git-repo" && parsed.rootKind !== "folder")
    || !Array.isArray(parsed.members)
  ) {
    return null;
  }
  const tree = parseTreeReference(parsed.tree);
  if (tree === null) {
    return null;
  }
  const members: WorkspaceMember[] = [];
  for (const candidate of parsed.members) {
    if (
      !isObject(candidate)
      || candidate.bindingMode !== "workspace-member"
      || typeof candidate.relativePath !== "string"
      || (candidate.rootKind !== "git-repo" && candidate.rootKind !== "folder")
      || typeof candidate.sourceId !== "string"
      || typeof candidate.sourceName !== "string"
    ) {
      return null;
    }
    members.push({
      bindingMode: "workspace-member",
      relativePath: candidate.relativePath,
      rootKind: candidate.rootKind,
      sourceId: candidate.sourceId,
      sourceName: candidate.sourceName,
    });
  }
  return {
    rootKind: parsed.rootKind,
    schemaVersion:
      typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : SCHEMA_VERSION,
    tree,
    workspaceId: parsed.workspaceId,
    members,
  };
}

export function writeWorkspaceState(
  root: string,
  state: Omit<WorkspaceState, "schemaVersion">,
): void {
  writeJson(workspaceStatePath(root), {
    ...state,
    schemaVersion: SCHEMA_VERSION,
  });
}

export function upsertWorkspaceMember(
  root: string,
  workspaceId: string,
  rootKind: RootKind,
  tree: BoundTreeReference,
  member: WorkspaceMember,
): void {
  const current = readWorkspaceState(root);
  const nextMembers = [
    ...(current?.members ?? []).filter(
      (candidate) => candidate.sourceId !== member.sourceId,
    ),
    member,
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  writeWorkspaceState(root, {
    rootKind,
    tree,
    workspaceId,
    members: nextMembers,
  });
}

export function treeStatePath(root: string): string {
  return join(root, TREE_STATE);
}

export function readTreeState(root: string): TreeState | null {
  const parsed = readJson(treeStatePath(root));
  if (!isObject(parsed)) {
    return null;
  }
  if (
    typeof parsed.treeId !== "string"
    || typeof parsed.treeRepoName !== "string"
    || (parsed.treeMode !== "dedicated" && parsed.treeMode !== "shared")
  ) {
    return null;
  }
  if (parsed.published !== undefined) {
    if (!isObject(parsed.published) || typeof parsed.published.remoteUrl !== "string") {
      return null;
    }
  }
  return {
    published: parsed.published as { remoteUrl: string } | undefined,
    schemaVersion:
      typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : SCHEMA_VERSION,
    treeId: parsed.treeId,
    treeMode: parsed.treeMode,
    treeRepoName: parsed.treeRepoName,
  };
}

export function writeTreeState(root: string, state: Omit<TreeState, "schemaVersion">): void {
  writeJson(treeStatePath(root), {
    ...state,
    schemaVersion: SCHEMA_VERSION,
  });
}

export function treeBindingsDir(root: string): string {
  return join(root, TREE_BINDINGS_DIR);
}

export function treeBindingPath(root: string, sourceId: string): string {
  return join(treeBindingsDir(root), `${sourceId}.json`);
}

export function readTreeBinding(
  root: string,
  sourceId: string,
): TreeBindingState | null {
  const parsed = readJson(treeBindingPath(root, sourceId));
  if (!isObject(parsed)) {
    return null;
  }
  if (
    typeof parsed.sourceId !== "string"
    || typeof parsed.sourceName !== "string"
    || typeof parsed.sourceRootPath !== "string"
    || typeof parsed.entrypoint !== "string"
    || typeof parsed.treeRepoName !== "string"
    || (parsed.rootKind !== "git-repo" && parsed.rootKind !== "folder")
    || (parsed.scope !== "repo" && parsed.scope !== "workspace")
    || (parsed.treeMode !== "dedicated" && parsed.treeMode !== "shared")
    || (
      parsed.bindingMode !== "standalone-source"
      && parsed.bindingMode !== "shared-source"
      && parsed.bindingMode !== "workspace-root"
      && parsed.bindingMode !== "workspace-member"
    )
  ) {
    return null;
  }
  if (parsed.remoteUrl !== undefined && typeof parsed.remoteUrl !== "string") {
    return null;
  }
  if (parsed.workspaceId !== undefined && typeof parsed.workspaceId !== "string") {
    return null;
  }
  if (
    parsed.workspaceRootPath !== undefined
    && typeof parsed.workspaceRootPath !== "string"
  ) {
    return null;
  }
  return {
    bindingMode: parsed.bindingMode,
    entrypoint: parsed.entrypoint,
    remoteUrl: parsed.remoteUrl,
    rootKind: parsed.rootKind,
    schemaVersion:
      typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : SCHEMA_VERSION,
    scope: parsed.scope,
    sourceId: parsed.sourceId,
    sourceName: parsed.sourceName,
    sourceRootPath: parsed.sourceRootPath,
    treeMode: parsed.treeMode,
    treeRepoName: parsed.treeRepoName,
    workspaceId: parsed.workspaceId,
    workspaceRootPath: parsed.workspaceRootPath,
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

export function slugifyToken(text: string): string {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized === "" ? "workspace" : normalized;
}

export function buildStableSourceId(root: string, label?: string): string {
  const base = slugifyToken(label ?? basename(root));
  const digest = createHash("sha1").update(root).digest("hex").slice(0, 8);
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
