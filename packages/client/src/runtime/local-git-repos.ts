import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { LocalGitRepoSummary } from "@agent-team-foundation/first-tree-hub-shared";

/**
 * Common directories developers keep their working clones in. Scanned at
 * client startup so the Hub Step 3 onboarding picker can show "your local
 * repos" without forcing the user to type a path.
 *
 * Order matters only insofar as duplicates from later roots are dropped —
 * earlier wins. Roots that don't exist on the host are silently skipped.
 */
const SCAN_ROOTS = ["code", "github", "projects", "work", "Documents/GitHub", "Documents/code", "src", "dev"];

/** Hard cap on how deep we walk under each root. Repos almost always live one
 * or two dirs down (`~/code/foo`, `~/github/org/repo`); going deeper turns the
 * scanner into a vacuum cleaner. */
const MAX_DEPTH = 3;

/** Hard cap on total directories visited per scan to bound cost on hosts with
 * a sprawling home directory. Hit it → return what we have so far. */
const MAX_VISITED = 5_000;

/** Hard cap on entries actually returned. Wire-payload bound on the
 * `localGitRepos` we hand to Hub: even at MAX_VISITED a user with hundreds
 * of repos would balloon the metadata column on every reconnect. */
const MAX_RESULTS = 500;

/** Top-level child dirs that are never repos and burn budget if descended. */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  ".idea",
  ".vscode",
  "Library",
  "Pictures",
  "Music",
  "Movies",
  "Downloads",
  ".Trash",
]);

/**
 * Scan the host's common code roots for git repositories. Returns a
 * deduplicated list (by `localPath`) ordered as encountered.
 *
 * Errors at any layer (missing root, EACCES on a subdir, malformed
 * `.git/config`) are swallowed silently — partial results are strictly
 * better than nothing for an optional UI hint.
 */
export async function probeLocalGitRepos(): Promise<LocalGitRepoSummary[]> {
  const home = homedir();
  if (!home) return [];

  // Dedupe by canonical path so a symlink loop (`~/code` → `~/work` and
  // back) doesn't double-walk the same tree, and `seen` covers visited
  // dirs not just emitted repos. Repos themselves still dedupe on
  // canonical localPath.
  const visitedCanonical = new Set<string>();
  const seenRepos = new Set<string>();
  const results: LocalGitRepoSummary[] = [];
  let visitCount = 0;

  function walk(dir: string, depth: number): void {
    if (visitCount >= MAX_VISITED) return;
    if (results.length >= MAX_RESULTS) return;
    if (depth > MAX_DEPTH) return;

    // `lstat` so we don't follow symlinks; symlink-to-dir is intentionally
    // ignored (it would either be a duplicate of an already-walked tree or
    // a path outside the user's intended SCAN_ROOTS).
    let lst: ReturnType<typeof lstatSync>;
    try {
      lst = lstatSync(dir);
    } catch {
      return;
    }
    if (lst.isSymbolicLink() || !lst.isDirectory()) return;

    let canonical: string;
    try {
      canonical = realpathSync(dir);
    } catch {
      canonical = dir;
    }
    if (visitedCanonical.has(canonical)) return;
    visitedCanonical.add(canonical);

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    visitCount++;

    // A `.git` child means we're standing in a repo. Don't descend further:
    // submodules / nested repos under here are vanishingly rare in a
    // user's working tree and we'd just bloat the list.
    if (entries.includes(".git")) {
      if (!seenRepos.has(canonical) && results.length < MAX_RESULTS) {
        seenRepos.add(canonical);
        results.push({
          localPath: canonical,
          name: basename(canonical),
          originUrl: readGitOriginUrl(join(dir, ".git")),
        });
      }
      return;
    }

    for (const name of entries) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      if (name.startsWith(".")) continue;
      const childPath = join(dir, name);
      let childLst: ReturnType<typeof lstatSync>;
      try {
        childLst = lstatSync(childPath);
      } catch {
        continue;
      }
      // Skip symlinks at the directory-walk layer too — the recursive
      // `walk` would lstat again and bail, but doing it here saves a
      // stack frame per skipped entry.
      if (childLst.isSymbolicLink() || !childLst.isDirectory()) continue;
      walk(childPath, depth + 1);
      if (visitCount >= MAX_VISITED || results.length >= MAX_RESULTS) return;
    }
  }

  for (const rel of SCAN_ROOTS) {
    const root = join(home, rel);
    walk(root, 0);
  }

  return results;
}

/**
 * Resolve `remote.origin.url` from a working-tree `.git` (which is a directory)
 * or a worktree `.git` file (which redirects to `gitdir: …`). Returns "" when
 * the file is missing, malformed, or origin is absent.
 */
function readGitOriginUrl(gitMarker: string): string {
  let configPath: string;
  // `statSync` is fine here — the `.git` child of a repo is either a
  // directory (working tree) or a regular file (worktree pointer); both
  // resolve through one level of symlink at most and there's no cycle to
  // worry about.
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(gitMarker);
  } catch {
    return "";
  }
  if (stat.isDirectory()) {
    configPath = join(gitMarker, "config");
  } else if (stat.isFile()) {
    let pointer = "";
    try {
      pointer = readFileSync(gitMarker, "utf8");
    } catch {
      return "";
    }
    const match = pointer.match(/^gitdir:\s*(.+)$/m);
    const gitdir = match?.[1]?.trim();
    if (!gitdir) return "";
    configPath = join(gitdir, "config");
  } else {
    return "";
  }

  let raw = "";
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return "";
  }

  return parseOriginUrl(raw);
}

/**
 * Minimal git-config parser — only looks for the `[remote "origin"]` block
 * and its `url = …` line. Tolerant of mixed indentation and Windows newlines.
 * Not a general-purpose parser; we only need this single key.
 */
function parseOriginUrl(config: string): string {
  const lines = config.split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      const header = sectionMatch[1] ?? "";
      inOrigin = header.replace(/\s+/g, " ").trim().toLowerCase() === 'remote "origin"';
      continue;
    }
    if (!inOrigin) continue;
    const kv = trimmed.match(/^url\s*=\s*(.*)$/i);
    if (kv) return (kv[1] ?? "").trim();
  }
  return "";
}
