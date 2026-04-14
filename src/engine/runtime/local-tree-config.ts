import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  readSourceState,
} from "#engine/runtime/binding-state.js";
import {
  LOCAL_TREE_TEMP_ROOT,
  SOURCE_LOCAL_STATE,
} from "#engine/runtime/asset-loader.js";

export interface LocalTreeConfig {
  bindingMode?: import("#engine/runtime/binding-state.js").SourceBindingMode;
  entrypoint?: string;
  localPath: string;
  sourceId?: string;
  treeMode?: import("#engine/runtime/binding-state.js").TreeMode;
  treeRepoName: string;
  treeRepoUrl?: string;
  workspaceId?: string;
}

export interface GitIgnoreUpdate {
  action: "created" | "updated" | "unchanged";
  file: ".gitignore";
}

const LOCAL_TREE_GITIGNORE_ENTRIES = [
  `${LOCAL_TREE_TEMP_ROOT}/`,
  SOURCE_LOCAL_STATE,
] as const;

export function tempLocalTreeRoot(root: string, treeRepoName: string): string {
  return join(root, LOCAL_TREE_TEMP_ROOT, treeRepoName);
}

/**
 * Read local overrides from `.first-tree/source.local.json`.
 * This file is gitignored and only needed when the user's local tree
 * checkout path differs from the team-shared relative path in source.json.
 * Returns only the `localPath` override, or null if the file doesn't exist.
 */
function readSourceLocalOverride(root: string): { localPath: string } | null {
  const fullPath = join(root, SOURCE_LOCAL_STATE);
  try {
    const parsed = JSON.parse(readFileSync(fullPath, "utf-8")) as Record<string, unknown>;
    if (typeof parsed.localPath === "string" && parsed.localPath.length > 0) {
      return { localPath: parsed.localPath };
    }
    return null;
  } catch {
    return null;
  }
}

export function readLocalTreeConfig(root: string): LocalTreeConfig | null {
  const state = readSourceState(root);
  if (state === null) {
    return null;
  }
  if (typeof state.tree.localPath !== "string" || typeof state.tree.treeRepoName !== "string") {
    return null;
  }

  // source.local.json overrides localPath when present
  const localOverride = readSourceLocalOverride(root);

  return {
    bindingMode: state.bindingMode,
    entrypoint: state.tree.entrypoint,
    localPath: localOverride?.localPath ?? state.tree.localPath,
    sourceId: state.sourceId,
    treeMode: state.tree.treeMode,
    treeRepoName: state.tree.treeRepoName,
    treeRepoUrl: state.tree.remoteUrl,
    workspaceId: state.workspaceId,
  };
}

export function resolveConfiguredLocalTreePath(root: string): string | null {
  const config = readLocalTreeConfig(root);
  if (config === null) {
    return null;
  }
  return resolve(root, config.localPath);
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
