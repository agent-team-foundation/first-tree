import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Repo } from "#products/tree/engine/repo.js";
import { parseGitHubRemoteUrl } from "#products/tree/engine/member-seeding.js";
import { readSourceState } from "#products/tree/engine/runtime/binding-state.js";
import { LOCAL_TREE_TEMP_ROOT } from "#products/tree/engine/runtime/asset-loader.js";

export interface LocalTreeConfig {
  bindingMode?: import("#products/tree/engine/runtime/binding-state.js").SourceBindingMode;
  entrypoint?: string;
  sourceId?: string;
  treeMode?: import("#products/tree/engine/runtime/binding-state.js").TreeMode;
  treeRepoName: string;
  treeRepoUrl?: string;
  workspaceId?: string;
}

export interface GitIgnoreUpdate {
  action: "created" | "updated" | "unchanged";
  file: ".gitignore";
}

export interface ResolvedLocalTreeCheckout {
  path: string;
  source: "sibling" | "temp";
}

export interface ResolveLocalTreeCheckoutOptions {
  materialize?: boolean;
  refresh?: boolean;
}

export type ExecRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => string;

const LOCAL_TREE_GITIGNORE_ENTRIES = [
  `${LOCAL_TREE_TEMP_ROOT}/`,
] as const;

export function defaultExecRunner(
  command: string,
  args: string[],
  options: { cwd: string },
): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function tempLocalTreeRoot(root: string, treeRepoName: string): string {
  return join(root, LOCAL_TREE_TEMP_ROOT, treeRepoName);
}

export function readLocalTreeConfig(root: string): LocalTreeConfig | null {
  const state = readSourceState(root);
  if (state === null || typeof state.tree.treeRepoName !== "string") {
    return null;
  }

  return {
    bindingMode: state.bindingMode,
    entrypoint: state.tree.entrypoint,
    sourceId: state.sourceId,
    treeMode: state.tree.treeMode,
    treeRepoName: state.tree.treeRepoName,
    treeRepoUrl: state.tree.remoteUrl,
    workspaceId: state.workspaceId,
  };
}

function readGitRemoteUrl(
  runner: ExecRunner,
  root: string,
  remote = "origin",
): string | null {
  try {
    return runner("git", ["remote", "get-url", remote], { cwd: root });
  } catch {
    return null;
  }
}

function normalizeRemoteUrl(remoteUrl: string): string {
  const parsed = parseGitHubRemoteUrl(remoteUrl);
  if (parsed !== null) {
    return [
      parsed.host.toLowerCase(),
      parsed.owner.toLowerCase(),
      parsed.repo.toLowerCase(),
    ].join("/");
  }
  return remoteUrl.trim().replace(/\.git$/u, "");
}

function remoteMatches(
  expectedRemoteUrl: string | undefined,
  actualRemoteUrl: string | null,
): boolean {
  if (!expectedRemoteUrl) {
    return true;
  }
  if (!actualRemoteUrl) {
    return false;
  }
  return normalizeRemoteUrl(expectedRemoteUrl) === normalizeRemoteUrl(actualRemoteUrl);
}

function isUsableTreeCheckout(
  candidateRoot: string,
  expectedRemoteUrl: string | undefined,
  runner: ExecRunner,
): boolean {
  const repo = new Repo(candidateRoot);
  if (!repo.isGitRepo()) {
    return false;
  }
  return remoteMatches(expectedRemoteUrl, readGitRemoteUrl(runner, candidateRoot));
}

function fetchTreeCheckout(root: string, runner: ExecRunner): void {
  try {
    runner("git", ["fetch", "origin"], { cwd: root });
  } catch {
    // Best-effort refresh: callers can still use the existing checkout.
  }
}

export function resolveLocalTreeCheckout(
  root: string,
  runner: ExecRunner = defaultExecRunner,
  options?: ResolveLocalTreeCheckoutOptions,
): ResolvedLocalTreeCheckout | null {
  const config = readLocalTreeConfig(root);
  if (config === null) {
    return null;
  }
  const materialize = options?.materialize ?? true;
  const refresh = options?.refresh ?? true;

  const siblingRoot = join(dirname(root), config.treeRepoName);
  if (isUsableTreeCheckout(siblingRoot, config.treeRepoUrl, runner)) {
    if (refresh) {
      fetchTreeCheckout(siblingRoot, runner);
    }
    return { path: siblingRoot, source: "sibling" };
  }

  const tempRoot = tempLocalTreeRoot(root, config.treeRepoName);
  if (isUsableTreeCheckout(tempRoot, config.treeRepoUrl, runner)) {
    if (refresh) {
      fetchTreeCheckout(tempRoot, runner);
    }
    return { path: tempRoot, source: "temp" };
  }

  if (!materialize || !config.treeRepoUrl) {
    return null;
  }

  if (!existsSync(tempRoot)) {
    mkdirSync(dirname(tempRoot), { recursive: true });
    runner("git", ["clone", config.treeRepoUrl, tempRoot], {
      cwd: dirname(tempRoot),
    });
    return { path: tempRoot, source: "temp" };
  }

  if (!isUsableTreeCheckout(tempRoot, config.treeRepoUrl, runner)) {
    return null;
  }

  fetchTreeCheckout(tempRoot, runner);
  return { path: tempRoot, source: "temp" };
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
