import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DEFAULT_CLONE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — overridable via env

/**
 * Per-URL bare mirror manager (Step 5).
 *
 * Layout:
 *   <dataDir>/git-mirrors/<sha256(url)>/  ← bare clone
 *
 * - `ensureMirror` is idempotent: clones only when the directory is absent.
 * - `fetchMirror` runs `git fetch --prune` against an existing mirror.
 * - `createWorktree` allocates a `--detach`'d worktree at `targetPath`.
 * - `removeWorktree` reverses the above.
 * - `gcMirrors` keeps only mirrors whose URL appears in the supplied set —
 *   used by Step 7 on agent unbind / delete.
 *
 * Authentication is delegated to the host Git environment (PRD §D12) — no
 * env vars or credential helpers are injected.
 */
export type GitMirrorManagerOptions = {
  dataDir: string;
  /** Override clone timeout (ms). Defaults to env `FIRST_TREE_HUB_GIT_CLONE_TIMEOUT_MS` or 5 minutes. */
  cloneTimeoutMs?: number;
  /** Optional structured logger — see plan §5.5. */
  log?: (event: string, fields: Record<string, unknown>) => void;
};

export interface GitMirrorManager {
  ensureMirror(url: string): Promise<{ mirrorPath: string; elapsedMs: number; cloned: boolean }>;
  fetchMirror(url: string): Promise<{ elapsedMs: number }>;
  createWorktree(args: {
    url: string;
    ref?: string;
    targetPath: string;
  }): Promise<{ worktreePath: string; headCommit: string }>;
  removeWorktree(path: string): Promise<void>;
  gcMirrors(stillReferencedUrls: Set<string>): Promise<{ removed: string[] }>;
  /** Internal: directory holding all mirrors (test helper). */
  readonly mirrorsRoot: string;
}

export function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

export function createGitMirrorManager(opts: GitMirrorManagerOptions): GitMirrorManager {
  const mirrorsRoot = join(opts.dataDir, "git-mirrors");
  const cloneTimeoutMs =
    opts.cloneTimeoutMs ?? Number(process.env.FIRST_TREE_HUB_GIT_CLONE_TIMEOUT_MS ?? DEFAULT_CLONE_TIMEOUT_MS);
  const log = opts.log ?? (() => {});

  function mirrorDir(url: string): string {
    return join(mirrorsRoot, hashUrl(url));
  }

  async function git(args: string[], cwd: string | null, timeoutMs: number, env?: NodeJS.ProcessEnv) {
    const start = Date.now();
    return await new Promise<{ stdout: string; stderr: string; elapsedMs: number }>((resolveExec, rejectExec) => {
      const proc = spawn("git", args, {
        cwd: cwd ?? undefined,
        env: env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => {
        stdout += String(d);
      });
      proc.stderr.on("data", (d) => {
        stderr += String(d);
      });
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        rejectExec(new GitMirrorTimeoutError(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      proc.on("error", (err) => {
        clearTimeout(timer);
        rejectExec(err);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        const elapsedMs = Date.now() - start;
        if (code === 0) resolveExec({ stdout, stderr, elapsedMs });
        else rejectExec(new GitMirrorError(`git ${args.join(" ")} exited with code ${code}: ${stderr.slice(0, 1024)}`));
      });
    });
  }

  return {
    get mirrorsRoot() {
      return mirrorsRoot;
    },

    async ensureMirror(url) {
      mkdirSync(mirrorsRoot, { recursive: true });
      const path = mirrorDir(url);
      if (existsSync(join(path, "HEAD"))) {
        // Already a bare repo — fast return.
        return { mirrorPath: path, elapsedMs: 0, cloned: false };
      }
      try {
        const { elapsedMs } = await git(["clone", "--mirror", url, path], null, cloneTimeoutMs);
        log("ensureMirror", { gitUrl: url, elapsedMs, cloned: true });
        return { mirrorPath: path, elapsedMs, cloned: true };
      } catch (err) {
        if (err instanceof GitMirrorTimeoutError) {
          log("mirrorCloneTimeout", { gitUrl: url, timeoutMs: cloneTimeoutMs, elapsedMs: cloneTimeoutMs });
        }
        // Clean up partial clone on failure to keep `ensureMirror` idempotent
        // on the next attempt.
        if (existsSync(path)) rmSync(path, { recursive: true, force: true });
        throw err;
      }
    },

    async fetchMirror(url) {
      const path = mirrorDir(url);
      if (!existsSync(join(path, "HEAD"))) {
        throw new GitMirrorError(`Cannot fetch — no mirror exists for "${url}"`);
      }
      try {
        const { elapsedMs } = await git(["fetch", "--prune"], path, cloneTimeoutMs);
        return { elapsedMs };
      } catch (err) {
        log("mirrorFetchFailed", {
          gitUrl: url,
          errorCode: err instanceof GitMirrorError ? "git-failed" : "unknown",
          stderr: err instanceof Error ? err.message.slice(0, 1024) : String(err).slice(0, 1024),
        });
        throw err;
      }
    },

    async createWorktree({ url, ref, targetPath }) {
      const mirror = mirrorDir(url);
      if (!existsSync(join(mirror, "HEAD"))) {
        throw new GitMirrorError(`Cannot create worktree — no mirror exists for "${url}"`);
      }
      const absTarget = resolve(targetPath);
      // D13: target path must be free OR a Hub-managed worktree we can reuse.
      if (existsSync(absTarget) && !isHubManagedWorktree(absTarget)) {
        log("worktreeCreateConflict", {
          gitUrl: url,
          targetPath: absTarget,
          occupantKind: classifyOccupant(absTarget),
        });
        throw new GitMirrorWorktreeConflictError(
          `Worktree target "${absTarget}" is already occupied by ${classifyOccupant(absTarget)} — aborting (D13)`,
        );
      }
      mkdirSync(dirname(absTarget), { recursive: true });
      const args = ["worktree", "add", "--detach", absTarget];
      if (ref) args.push(ref);
      await git(args, mirror, cloneTimeoutMs);
      const head = await git(["rev-parse", "HEAD"], absTarget, 30_000);
      return { worktreePath: absTarget, headCommit: head.stdout.trim() };
    },

    async removeWorktree(path) {
      const absTarget = resolve(path);
      if (!existsSync(absTarget)) return;
      // Find the mirror that owns this worktree by walking each mirror's
      // `worktree list` — cheap because the set of mirrors is small.
      if (!existsSync(mirrorsRoot)) return;
      let removed = false;
      for (const entry of readdirSync(mirrorsRoot)) {
        const mirror = join(mirrorsRoot, entry);
        if (!isBareRepo(mirror)) continue;
        try {
          await git(["worktree", "remove", "--force", absTarget], mirror, 30_000);
          removed = true;
          break;
        } catch {
          // Try the next mirror — only one will own this worktree path.
        }
      }
      if (!removed && existsSync(absTarget)) {
        // Worktree was never registered (e.g. orphan); just rm.
        rmSync(absTarget, { recursive: true, force: true });
      }
    },

    async gcMirrors(stillReferencedUrls) {
      if (!existsSync(mirrorsRoot)) return { removed: [] };
      const wantedHashes = new Set([...stillReferencedUrls].map(hashUrl));
      const removed: string[] = [];
      for (const entry of readdirSync(mirrorsRoot)) {
        if (wantedHashes.has(entry)) continue;
        const path = join(mirrorsRoot, entry);
        if (!isBareRepo(path)) continue;
        rmSync(path, { recursive: true, force: true });
        removed.push(entry);
      }
      return { removed };
    },
  };
}

function isBareRepo(p: string): boolean {
  return existsSync(join(p, "HEAD")) && existsSync(join(p, "objects"));
}

function isHubManagedWorktree(p: string): boolean {
  // A Hub-managed worktree has a `.git` file (not directory) pointing back
  // into the bare mirror's `worktrees/` dir.
  const gitMarker = join(p, ".git");
  if (!existsSync(gitMarker)) return false;
  try {
    return statSync(gitMarker).isFile();
  } catch {
    return false;
  }
}

function classifyOccupant(p: string): string {
  try {
    const stat = statSync(p);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) {
      if (existsSync(join(p, ".git"))) return "git-repo";
      return "directory";
    }
    if (stat.isFile()) return "file";
    return "other";
  } catch {
    return "unknown";
  }
}

export class GitMirrorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitMirrorError";
  }
}

export class GitMirrorTimeoutError extends GitMirrorError {
  constructor(message: string) {
    super(message);
    this.name = "GitMirrorTimeoutError";
  }
}

export class GitMirrorWorktreeConflictError extends GitMirrorError {
  constructor(message: string) {
    super(message);
    this.name = "GitMirrorWorktreeConflictError";
  }
}
