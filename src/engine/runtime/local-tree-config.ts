import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  SourceBindingMode,
  TreeMode,
} from "#engine/runtime/binding-state.js";
import {
  LOCAL_TREE_CONFIG,
  LOCAL_TREE_TEMP_ROOT,
} from "#engine/runtime/asset-loader.js";

export interface LocalTreeConfig {
  bindingMode?: SourceBindingMode;
  entrypoint?: string;
  localPath: string;
  sourceId?: string;
  treeMode?: TreeMode;
  treeRepoName: string;
  treeRepoUrl?: string;
  workspaceId?: string;
}

export interface GitIgnoreUpdate {
  action: "created" | "updated" | "unchanged";
  file: ".gitignore";
}

export interface LocalTreeConfigUpdate {
  action: "created" | "updated" | "unchanged";
  file: typeof LOCAL_TREE_CONFIG;
}

const LOCAL_TREE_GITIGNORE_ENTRIES = [
  LOCAL_TREE_CONFIG,
  `${LOCAL_TREE_TEMP_ROOT}/`,
] as const;

export function localTreeConfigPath(root: string): string {
  return join(root, LOCAL_TREE_CONFIG);
}

export function tempLocalTreeRoot(root: string, treeRepoName: string): string {
  return join(root, LOCAL_TREE_TEMP_ROOT, treeRepoName);
}

export function readLocalTreeConfig(root: string): LocalTreeConfig | null {
  try {
    const parsed = JSON.parse(
      readFileSync(localTreeConfigPath(root), "utf-8"),
    ) as Partial<LocalTreeConfig>;
    if (
      typeof parsed.localPath !== "string"
      || typeof parsed.treeRepoName !== "string"
      || (parsed.treeRepoUrl !== undefined && typeof parsed.treeRepoUrl !== "string")
      || (
        parsed.treeMode !== undefined
        && parsed.treeMode !== "dedicated"
        && parsed.treeMode !== "shared"
      )
      || (
        parsed.bindingMode !== undefined
        && parsed.bindingMode !== "standalone-source"
        && parsed.bindingMode !== "shared-source"
        && parsed.bindingMode !== "workspace-root"
        && parsed.bindingMode !== "workspace-member"
      )
      || (parsed.entrypoint !== undefined && typeof parsed.entrypoint !== "string")
      || (parsed.workspaceId !== undefined && typeof parsed.workspaceId !== "string")
      || (parsed.sourceId !== undefined && typeof parsed.sourceId !== "string")
    ) {
      return null;
    }
    return {
      bindingMode: parsed.bindingMode,
      entrypoint: parsed.entrypoint,
      localPath: parsed.localPath,
      sourceId: parsed.sourceId,
      treeMode: parsed.treeMode,
      treeRepoName: parsed.treeRepoName,
      treeRepoUrl: parsed.treeRepoUrl,
      workspaceId: parsed.workspaceId,
    };
  } catch {
    return null;
  }
}

export function resolveConfiguredLocalTreePath(root: string): string | null {
  const config = readLocalTreeConfig(root);
  if (config === null) {
    return null;
  }
  return resolve(root, config.localPath);
}

export function writeLocalTreeConfig(
  root: string,
  config: LocalTreeConfig,
): void {
  const fullPath = localTreeConfigPath(root);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function upsertLocalTreeConfig(
  root: string,
  config: LocalTreeConfig,
): LocalTreeConfigUpdate {
  const fullPath = localTreeConfigPath(root);
  const exists = existsSync(fullPath);
  const current = readLocalTreeConfig(root);
  if (
    current?.bindingMode === config.bindingMode
    && current?.entrypoint === config.entrypoint
    && current?.localPath === config.localPath
    && current?.sourceId === config.sourceId
    && current?.treeMode === config.treeMode
    && current?.treeRepoName === config.treeRepoName
    && current?.treeRepoUrl === config.treeRepoUrl
    && current?.workspaceId === config.workspaceId
  ) {
    return { action: "unchanged", file: LOCAL_TREE_CONFIG };
  }

  writeLocalTreeConfig(root, config);
  return {
    action: exists ? "updated" : "created",
    file: LOCAL_TREE_CONFIG,
  };
}

export function upsertLocalTreeGitIgnore(root: string): GitIgnoreUpdate {
  const fullPath = join(root, ".gitignore");
  const exists = existsSync(fullPath);
  const text = exists ? readFileSync(fullPath, "utf-8") : "";
  const normalized = text.replaceAll("\r\n", "\n");
  const lines = normalized === "" ? [] : normalized.split("\n");

  let changed = false;
  for (const entry of LOCAL_TREE_GITIGNORE_ENTRIES) {
    if (!lines.includes(entry)) {
      if (lines.length > 0 && lines.at(-1) === "") {
        lines.splice(lines.length - 1, 0, entry);
      } else {
        lines.push(entry);
      }
      changed = true;
    }
  }

  if (!changed) {
    return { action: "unchanged", file: ".gitignore" };
  }

  const next = ensureTrailingNewline(lines.join("\n"));
  writeFileSync(fullPath, next);
  return {
    action: exists ? "updated" : "created",
    file: ".gitignore",
  };
}

function ensureTrailingNewline(text: string): string {
  if (text !== "" && !text.endsWith("\n")) {
    return `${text}\n`;
  }
  return text;
}
