import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type RootKind = "git-repo" | "folder";

export type GitHubRemote = {
  host: string;
  owner: string;
  repo: string;
};

export type WorkspaceRepoCandidate = {
  kind: "nested-git-repo";
  name: string;
  relativePath: string;
  root: string;
};

const IGNORED_WORKSPACE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "dist",
  "build",
  "node_modules",
  ".next",
  ".turbo",
]);

export function ensureTrailingNewline(text: string): string {
  if (text !== "" && !text.endsWith("\n")) {
    return `${text}\n`;
  }

  return text;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readJson(path: string): unknown | undefined {
  try {
    if (!statSync(path).isFile()) {
      return undefined;
    }
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function parseGitHubRemoteUrl(remoteUrl: string): GitHubRemote | null {
  const trimmed = remoteUrl.trim();

  if (trimmed.length === 0) {
    return null;
  }

  const patterns = [
    /^(?:https?:\/\/)(?<host>[^/]+)\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/u,
    /^(?:ssh:\/\/)?git@(?<host>[^/:]+)[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/u,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);

    if (!match?.groups) {
      continue;
    }

    return {
      host: match.groups.host,
      owner: match.groups.owner,
      repo: match.groups.repo,
    };
  }

  return null;
}

export function normalizeRemoteForMatch(remoteUrl: string): string {
  const parsed = parseGitHubRemoteUrl(remoteUrl);

  if (parsed !== null) {
    return [parsed.host.toLowerCase(), parsed.owner.toLowerCase(), parsed.repo.toLowerCase()].join(
      "/",
    );
  }

  return remoteUrl.trim().replace(/\.git$/u, "");
}

export function slugifyToken(text: string): string {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized === "" ? "workspace" : normalized;
}

export function runCommand(command: string, args: string[], cwd: string): string {
  const env = { ...process.env };
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_WORK_TREE",
  ]) {
    delete env[key];
  }

  return execFileSync(command, args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function isGitRepoRoot(root: string): boolean {
  try {
    const stat = statSync(join(root, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

export function findGitRoot(startDir: string): string | undefined {
  let current = resolve(startDir);

  while (true) {
    if (isGitRepoRoot(current)) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

export function resolveRepoRoot(startDir: string): string {
  return findGitRoot(startDir) ?? resolve(startDir);
}

export function repoNameForRoot(root: string): string {
  return root.split("/").filter(Boolean).at(-1) ?? "repo";
}

export function readGitRemoteUrl(root: string, remote = "origin"): string | undefined {
  try {
    return runCommand("git", ["remote", "get-url", remote], root);
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function discoverNestedRepos(
  workspaceRoot: string,
  currentDir: string,
  results: Map<string, WorkspaceRepoCandidate>,
): void {
  let entries: string[] = [];

  try {
    entries = readdirSync(currentDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (IGNORED_WORKSPACE_DIRS.has(entry)) {
      continue;
    }

    const child = join(currentDir, entry);

    if (!isDirectory(child)) {
      continue;
    }

    if (isGitRepoRoot(child) && resolve(child) !== resolve(workspaceRoot)) {
      const relativePath = relative(workspaceRoot, child);

      if (!results.has(relativePath)) {
        results.set(relativePath, {
          kind: "nested-git-repo",
          name: repoNameForRoot(child),
          relativePath,
          root: resolve(child),
        });
      }
      continue;
    }

    discoverNestedRepos(workspaceRoot, child, results);
  }
}

export function discoverWorkspaceRepos(root: string): WorkspaceRepoCandidate[] {
  const results = new Map<string, WorkspaceRepoCandidate>();

  if (existsSync(root)) {
    discoverNestedRepos(resolve(root), resolve(root), results);
  }

  return [...results.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}
