/**
 * Phase 3c: workspace manager for agent task execution.
 *
 * Port of `first-tree-breeze/breeze-runner/src/workspace.rs`.
 *
 * Each dispatched task gets a detached-HEAD git worktree at
 * `<workspacesDir>/<slug>/<kind>-<stableId>`, backed by a bare mirror
 * at `<reposDir>/<slug>.git`. The mirror is kept up-to-date via
 * `git remote update --prune`; PR-targeted tasks additionally fetch
 * `refs/pull/<n>/head` into a local tracking ref.
 *
 * We shell out to `git` and `gh` exactly like the Rust version. All
 * auth-ish commands (`clone`, `fetch`, `remote update`) are run with
 * `GIT_TERMINAL_PROMPT=0` and the `credential.helper=!gh auth
 * git-credential` trick so they work against `github.com` without
 * requiring the user's global git config to know about `gh`.
 *
 * Tests use an injected `runGit` to avoid hitting the network.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

export interface WorkspaceCandidate {
  repo: string;
  /** "issue" | "pr" | "review" | "mention" | ... */
  kind: string;
  /** Derived id safe for filesystem use. */
  stableId: string;
  /** Optional PR number (numbers only; 0 or undefined for non-PR). */
  prNumber?: number;
  /** Workspace repo (defaults to `repo` when absent). */
  workspaceRepo?: string;
}

export interface WorkspaceIdentity {
  host: string;
  login: string;
}

export interface WorkspaceLease {
  mirrorDir: string;
  workspaceDir: string;
  repoUrl: string;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  statusCode: number;
}

export type GitRunner = (args: {
  args: string[];
  env?: Record<string, string>;
}) => Promise<GitRunResult>;

export interface WorkspaceManagerOptions {
  reposDir: string;
  workspacesDir: string;
  identity: WorkspaceIdentity;
  /** Injected git runner. Production uses `defaultGitRunner`. */
  runGit?: GitRunner;
}

export class WorkspaceManager {
  private readonly reposDir: string;
  private readonly workspacesDir: string;
  private readonly identity: WorkspaceIdentity;
  private readonly runGit: GitRunner;

  constructor(options: WorkspaceManagerOptions) {
    this.reposDir = options.reposDir;
    this.workspacesDir = options.workspacesDir;
    this.identity = options.identity;
    this.runGit = options.runGit ?? defaultGitRunner;
  }

  async prepare(task: WorkspaceCandidate): Promise<WorkspaceLease> {
    const workspaceRepo = task.workspaceRepo ?? task.repo;
    if (!workspaceRepo) {
      throw new Error("task does not include a repository");
    }
    mkdirSync(this.reposDir, { recursive: true });
    mkdirSync(this.workspacesDir, { recursive: true });

    const slug = sanitizeFilename(workspaceRepo.replace(/\//g, "__"));
    const mirrorDir = join(this.reposDir, `${slug}.git`);
    const repoUrl = `https://${this.identity.host}/${workspaceRepo}.git`;
    await this.ensureMirror(mirrorDir, repoUrl);
    const checkoutRef = await this.prepareRef(mirrorDir, task);

    const workspaceDir = join(
      this.workspacesDir,
      slug,
      `${task.kind}-${task.stableId}`,
    );
    await this.pruneStaleWorktreeEntry(mirrorDir, workspaceDir);
    if (existsSync(workspaceDir)) {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
    mkdirSync(dirname(workspaceDir), { recursive: true });

    await this.runChecked({
      args: [
        "--git-dir",
        mirrorDir,
        "worktree",
        "add",
        "--force",
        "--detach",
        workspaceDir,
        checkoutRef,
      ],
      context: "create task workspace",
    });

    await this.seedGitIdentity(workspaceDir);

    return { mirrorDir, workspaceDir, repoUrl };
  }

  private async ensureMirror(
    mirrorDir: string,
    repoUrl: string,
  ): Promise<void> {
    if (!existsSync(mirrorDir)) {
      await this.runChecked({
        args: this.authArgs([
          "clone",
          "--bare",
          repoUrl,
          mirrorDir,
        ]),
        env: AUTH_ENV,
        context: "clone bare mirror",
      });
    }
    await this.normalizeRepositoryCache(mirrorDir);
    await this.runChecked({
      args: this.authArgs([
        "--git-dir",
        mirrorDir,
        "remote",
        "update",
        "--prune",
      ]),
      env: AUTH_ENV,
      context: "update bare mirror",
    });
  }

  private async prepareRef(
    mirrorDir: string,
    task: WorkspaceCandidate,
  ): Promise<string> {
    if (task.prNumber && task.prNumber > 0) {
      const refName = `refs/remotes/origin/breeze-runner-pr-${task.prNumber}`;
      await this.runChecked({
        args: this.authArgs([
          "--git-dir",
          mirrorDir,
          "fetch",
          "origin",
          `+refs/pull/${task.prNumber}/head:${refName}`,
        ]),
        env: AUTH_ENV,
        context: "fetch pull request head",
      });
      return refName;
    }
    const { stdout } = await this.runChecked({
      args: ["--git-dir", mirrorDir, "rev-parse", "HEAD"],
      context: "resolve mirror HEAD",
    });
    const revision = stdout.split("\n", 1)[0]?.trim() ?? "";
    if (!revision) throw new Error("mirror HEAD could not be resolved");
    return revision;
  }

  private async seedGitIdentity(workspaceDir: string): Promise<void> {
    await this.runGit({
      args: [
        "-C",
        workspaceDir,
        "config",
        "user.name",
        `${this.identity.login} via breeze-runner`,
      ],
    });
    await this.runGit({
      args: [
        "-C",
        workspaceDir,
        "config",
        "user.email",
        `${this.identity.login}@users.noreply.github.com`,
      ],
    });
  }

  private async normalizeRepositoryCache(mirrorDir: string): Promise<void> {
    await this.runGit({
      args: [
        "--git-dir",
        mirrorDir,
        "config",
        "--unset-all",
        "remote.origin.mirror",
      ],
    });
    await this.runGit({
      args: [
        "--git-dir",
        mirrorDir,
        "config",
        "--unset-all",
        "remote.origin.fetch",
      ],
    });
    for (const fetch of [
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/tags/*:refs/tags/*",
    ]) {
      await this.runChecked({
        args: [
          "--git-dir",
          mirrorDir,
          "config",
          "--add",
          "remote.origin.fetch",
          fetch,
        ],
        context: "configure repository cache fetch refspec",
      });
    }
  }

  private async pruneStaleWorktreeEntry(
    mirrorDir: string,
    workspaceDir: string,
  ): Promise<void> {
    await this.runGit({
      args: ["--git-dir", mirrorDir, "worktree", "prune"],
    });
    await this.runGit({
      args: [
        "--git-dir",
        mirrorDir,
        "worktree",
        "remove",
        "--force",
        workspaceDir,
      ],
    });
  }

  private authArgs(base: string[]): string[] {
    return ["-c", "credential.helper=!gh auth git-credential", ...base];
  }

  private async runChecked(opts: {
    args: string[];
    env?: Record<string, string>;
    context: string;
  }): Promise<GitRunResult> {
    const result = await this.runGit({ args: opts.args, env: opts.env });
    if (result.statusCode !== 0) {
      throw new Error(
        `${opts.context} failed (exit ${result.statusCode}): ${result.stderr || result.stdout}`,
      );
    }
    return result;
  }
}

const AUTH_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };

/** Strip filesystem-unsafe characters from a slug (matches Rust util). */
export function sanitizeFilename(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length === 0 ? "_" : cleaned;
}

/** Default git runner; spawns real `git`. */
export const defaultGitRunner: GitRunner = async ({ args, env }) => {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env: { ...process.env, ...(env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, statusCode: code ?? 1 });
    });
  });
};
