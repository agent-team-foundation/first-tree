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
} from "#products/tree/engine/runtime/asset-loader.js";

export type TreeMode = "dedicated" | "shared";
export type SourceBindingMode =
  | "standalone-source"
  | "shared-source"
  | "workspace-root"
  | "workspace-member";
export type RootKind = "git-repo" | "folder";
export type SourceScope = "repo" | "workspace";

const SCHEMA_VERSION = 2;

export interface BoundTreeReference {
  entrypoint: string;
  lastReconciledAt?: string;
  lastReconciledSourceCommit?: string;
  localPath?: string;
  remoteUrl?: string;
  treeId: string;
  treeMode: TreeMode;
  treeRepoName: string;
}

export interface SourceState {
  bindingMode: SourceBindingMode;
  members?: WorkspaceMember[];
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
  lastReconciledAt?: string;
  lastReconciledSourceCommit?: string;
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
  if (
    value.lastReconciledSourceCommit !== undefined
    && typeof value.lastReconciledSourceCommit !== "string"
  ) {
    return null;
  }
  if (
    value.lastReconciledAt !== undefined
    && typeof value.lastReconciledAt !== "string"
  ) {
    return null;
  }
  return {
    entrypoint: value.entrypoint,
    lastReconciledAt:
      typeof value.lastReconciledAt === "string" ? value.lastReconciledAt : undefined,
    lastReconciledSourceCommit:
      typeof value.lastReconciledSourceCommit === "string"
        ? value.lastReconciledSourceCommit
        : undefined,
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
  let members: WorkspaceMember[] | undefined;
  if (Array.isArray(parsed.members)) {
    const parsedMembers: WorkspaceMember[] = [];
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
      parsedMembers.push({
        bindingMode: "workspace-member",
        relativePath: candidate.relativePath,
        rootKind: candidate.rootKind,
        sourceId: candidate.sourceId,
        sourceName: candidate.sourceName,
      });
    }
    members = parsedMembers;
  }

  return {
    bindingMode: parsed.bindingMode,
    members,
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
  const { members, ...rest } = state;
  writeJson(sourceStatePath(root), {
    ...rest,
    ...(members !== undefined ? { members } : {}),
    schemaVersion: SCHEMA_VERSION,
  });
}

export function readWorkspaceState(root: string): WorkspaceState | null {
  const source = readSourceState(root);
  if (source === null || source.workspaceId === undefined || !Array.isArray(source.members)) {
    return null;
  }
  return {
    rootKind: source.rootKind,
    schemaVersion: source.schemaVersion,
    tree: source.tree,
    workspaceId: source.workspaceId,
    members: source.members,
  };
}

export function writeWorkspaceState(
  root: string,
  state: Omit<WorkspaceState, "schemaVersion">,
): void {
  const existing = readSourceState(root);
  if (existing === null) {
    throw new Error("Cannot write workspace state without an existing source state");
  }
  writeSourceState(root, {
    ...existing,
    members: state.members,
    tree: state.tree,
    workspaceId: state.workspaceId,
    rootKind: state.rootKind,
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
  const existing = readSourceState(root);
  if (existing === null) {
    throw new Error("Cannot upsert workspace member without an existing source state");
  }
  writeSourceState(root, {
    ...existing,
    members: nextMembers,
    tree,
    workspaceId,
    rootKind,
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
  if (
    parsed.lastReconciledSourceCommit !== undefined
    && typeof parsed.lastReconciledSourceCommit !== "string"
  ) {
    return null;
  }
  if (
    parsed.lastReconciledAt !== undefined
    && typeof parsed.lastReconciledAt !== "string"
  ) {
    return null;
  }
  return {
    bindingMode: parsed.bindingMode,
    entrypoint: parsed.entrypoint,
    lastReconciledAt:
      typeof parsed.lastReconciledAt === "string" ? parsed.lastReconciledAt : undefined,
    lastReconciledSourceCommit:
      typeof parsed.lastReconciledSourceCommit === "string"
        ? parsed.lastReconciledSourceCommit
        : undefined,
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
