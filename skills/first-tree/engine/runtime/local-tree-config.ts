import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  LOCAL_TREE_CONFIG,
  LOCAL_TREE_TEMP_ROOT,
} from "#skill/engine/runtime/asset-loader.js";

export interface LocalTreeConfig {
  localPath: string;
  treeRepoName: string;
  treeRepoUrl?: string;
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
    ) {
      return null;
    }
    return {
      localPath: parsed.localPath,
      treeRepoName: parsed.treeRepoName,
      treeRepoUrl: parsed.treeRepoUrl,
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
    current?.localPath === config.localPath
    && current.treeRepoName === config.treeRepoName
    && current.treeRepoUrl === config.treeRepoUrl
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
