import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { WorkspaceHealthReason } from "@first-tree/shared";
import type { pino } from "../observability/logger.js";
import { getChildProcessRegistry } from "./child-process-registry.js";
import { redactErrorPreview } from "./redact-error-preview.js";
import { isUnderManagedRoot, killProcessesHoldingPath } from "./worktree-cleanup.js";

const DEFAULT_CLONE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Backoff schedule for retrying a remote-talking git op (`clone`, `fetch`)
 * on a transient network-layer failure. Each entry is the wait BEFORE the
 * next attempt, so this lays out 4 attempts total (1 initial + 3 retries)
 * with a worst-case sleep budget of ~5s **per protocol attempt**.
 *
 * Tuned for the operator-visible case of session start/resume hitting a
 * proxy / VPN that flips a rule, restarts a TUN, or drops a TLS handshake
 * mid-flight. The user's own manual workaround in those cases is "@-mention
 * the agent again 2 seconds later" — this is that, automated.
 *
 * Per-step jitter (up to 25% of the delay) prevents thundering-herd retries
 * when several agents resume in lockstep against the same flaky proxy.
 */
const NETWORK_RETRY_DELAYS_MS: readonly number[] = [500, 1500, 3000];

/**
 * Per-agent standalone source-repo manager.
 *
 * Layout (post per-agent-source-repo refactor):
 *   <workspaces>/<agent>/<repo>/      ← a real, standalone `git clone` with its
 *                                       own `.git` dir and full object store.
 *
 * There is NO shared `<dataDir>/git-mirrors/` bare-mirror layer anymore. Each
 * agent home owns its own clone of every configured source repo and is
 * responsible for keeping it current. The clone the agent greps for
 * orientation IS the clone that gets fetched+updated IS the clone that on-demand
 * worktrees (`<agent>/worktrees/<task>/`) branch from — one fresh source of
 * truth per agent.
 *
 * Update model (per session / dialog):
 * - `git fetch --prune origin` always runs (fresh remote refs).
 * - The working checkout is brought to the latest default branch (or the
 *   pinned `ref`) with a hard `checkout -B`, but ONLY when it is safe:
 *     · the working tree is clean (no uncommitted/untracked changes), and
 *     · no other live chat of this agent is currently using the checkout
 *       (the `activelyInUse` flag — see source-repos.ts live-use registry).
 *   A dirty or in-use checkout is left at its current commit and a warning is
 *   logged. We never silently `reset --hard` over local work or yank the
 *   ground out from under a running session's `grep`.
 *
 * Authentication strategy (unchanged from the mirror era):
 * - Credentials are delegated to the host Git environment (credential
 *   helpers, GCM, ssh agent, on-disk keys). Every spawned `git` has
 *   `GIT_TERMINAL_PROMPT=0` so missing credentials fail fast instead of
 *   blocking on a tty that doesn't exist under systemd / launchd.
 * - When `clone` / `fetch origin` fails with a credential-shaped error, we
 *   transparently retry once via the *peer* protocol (HTTPS → SSH or
 *   SSH → HTTPS, decided by the configured URL), using a process-scoped
 *   `git -c url.<peer-base>.insteadOf=<origin-base>` rewrite. No host
 *   gitconfig is touched and no on-disk `remote.origin.url` is mutated.
 */
export type GitMirrorManagerOptions = {
  dataDir: string;
  cloneTimeoutMs?: number;
  log?: pino.Logger;
  /**
   * Paths under which First Tree owns the directory tree end-to-end (typically
   * `<dataDir>/workspaces`). When a source-repo target sits inside one of these
   * roots and a stale non-managed leftover (or a legacy shared-mirror worktree)
   * is found at session start, the manager auto-recovers — kill any process
   * still holding the path, `rm -rf` the leftover, then re-clone.
   *
   * Targets OUTSIDE every managed root still fail loud: those are
   * operator-supplied paths and we refuse to silently delete user data.
   *
   * Omit to disable self-healing (throws on conflict instead). The production
   * runtimes always pass the workspaces root; tests opt in explicitly to
   * exercise the recovery path.
   */
  hubManagedRoots?: readonly string[];
};

/**
 * Outcome of an `ensureSourceRepo` call, for logging / test assertions.
 *   - `cloned`            fresh clone created
 *   - `migrated-recloned` legacy shared-mirror worktree replaced with a clone
 *   - `updated`           existing clone fast-forwarded to a new commit
 *   - `unchanged`         existing clone fetched but already at target commit
 *   - `skipped-dirty`         left as-is: working tree had local changes
 *   - `skipped-local-commits` left as-is: branch has local commits ahead of upstream
 *   - `skipped-in-use`        left as-is: another live session is using it
 *   - `stale-offline`         left as-is: fetch failed with a transient network
 *                             error on an existing usable checkout — degraded to
 *                             the last-good local source instead of aborting the
 *                             session (see step (4) in `ensureSourceRepo`)
 *   - `stale-unreachable`     left as-is: fetch failed with a PERMISSION-shaped
 *                             error (auth rejected on both transports, or 404)
 *                             on an existing usable checkout. Same freeze
 *                             contract as `stale-offline`, but it will NOT
 *                             self-heal — the checkout stays at its last-good
 *                             commit until credentials are fixed on the host.
 *                             Carries `degraded` for the workspace-health report.
 *   - `skipped-unreachable`   no usable local clone AND the clone failed with a
 *                             permission-shaped error — the repo is skipped
 *                             entirely (nothing materialised on disk; `cloneRepo`
 *                             removes any partial clone) so the session can
 *                             still start degraded. Carries `degraded`.
 */
export type SourceRepoOutcome =
  | "cloned"
  | "migrated-recloned"
  | "updated"
  | "unchanged"
  | "skipped-dirty"
  | "skipped-local-commits"
  | "skipped-in-use"
  | "stale-offline"
  | "stale-unreachable"
  | "skipped-unreachable";

/**
 * Degradation descriptor attached to the `*-unreachable` outcomes and consumed
 * by the `workspace:health` report (see shared/src/schemas/workspace-health.ts).
 * `errorPreview` has ALREADY been passed through `redactErrorPreview` — safe
 * for chat-visible / DB-persisted surfaces.
 */
export type SourceRepoDegradedInfo = {
  reasonCode: WorkspaceHealthReason;
  errorPreview: string;
};

export interface GitMirrorManager {
  /**
   * Ensure a standalone clone exists at `clonePath` and (when safe) is brought
   * up to the latest default branch / pinned `ref`. Idempotent.
   */
  ensureSourceRepo(args: {
    url: string;
    ref?: string;
    clonePath: string;
    /**
     * True when another live chat of this agent is currently using this
     * checkout. The destructive `checkout -B` update is skipped when set, so a
     * running chat's working tree never shifts mid-task. The caller owns the
     * live-use registry (see source-repos.ts).
     */
    activelyInUse?: boolean;
  }): Promise<{
    clonePath: string;
    /** HEAD of the local checkout. Absent only for `skipped-unreachable` (nothing on disk). */
    headCommit?: string;
    /** Short name of the checked-out branch, or undefined when detached (pinned SHA). */
    branch?: string;
    outcome: SourceRepoOutcome;
    /** Present only on the `*-unreachable` outcomes (permission-shaped degradation). */
    degraded?: SourceRepoDegradedInfo;
  }>;

  /** Remove a standalone source-repo clone (best-effort, kills holders first). */
  removeSourceRepo(args: { clonePath: string }): Promise<void>;

  /**
   * One-time cleanup: delete the legacy shared `<dataDir>/git-mirrors/` tree
   * left behind by the pre-refactor bare-mirror model. Pure cache, no state —
   * safe to remove wholesale. Called once at runtime boot.
   */
  sweepLegacyMirrors(): Promise<{ removed: string[] }>;

  /** Absolute path of the legacy shared-mirror root (for logging / tests). */
  readonly legacyMirrorsRoot: string;
}

/**
 * Hash a repo URL into a stable short id over a *canonical* form (host + path,
 * lowercased host, no `.git` suffix, no protocol, no `user@` prefix), so the
 * same upstream repo addressed via any accepted form (HTTPS, `ssh://`, or
 * scp-like) collapses to the same id. Retained for the legacy-mirror sweep and
 * for any URL-keyed bookkeeping callers still want. Exported for unit testing.
 */
export function hashUrl(url: string): string {
  return createHash("sha256").update(canonicalizeRepoUrl(url)).digest("hex").slice(0, 32);
}

/**
 * Reduce a repo URL to `<host[:port]>/<path-without-.git>`. Exposed for unit
 * testing.
 *
 *   `https://github.com/foo/bar.git`         → `github.com/foo/bar`
 *   `git@github.com:foo/bar.git`             → `github.com/foo/bar`
 *   `ssh://git@github.com/foo/bar.git`       → `github.com/foo/bar`
 *   `ssh://git@gitlab.example.com:2222/x/y`  → `gitlab.example.com:2222/x/y`
 *
 * Falls back to the raw input for un-parseable strings.
 */
export function canonicalizeRepoUrl(url: string): string {
  // scp-like: `[user@]host:path` (no `://`, exactly one `:` between host and
  // path, path doesn't look like a port number).
  if (!url.includes("://")) {
    const m = url.match(/^(?:[A-Za-z0-9_.-]+@)?([A-Za-z0-9.-]+):([^/@:\s][^@:\s]*)$/);
    const host = m?.[1];
    const rawPath = m?.[2];
    if (host && rawPath && !/^\d+(?:\/|$)/.test(rawPath)) {
      const path = normalizePath(rawPath);
      return `${host.toLowerCase()}/${path}`;
    }
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const portIsDefault =
      parsed.port === "" ||
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "ssh:" && parsed.port === "22");
    const hostPort = portIsDefault ? host : `${host}:${parsed.port}`;
    const path = normalizePath(parsed.pathname);
    return `${hostPort}/${path}`;
  } catch {
    return url;
  }
}

/**
 * Strip leading slashes, trailing slashes, and a trailing `.git`.
 */
function normalizePath(rawPath: string): string {
  return rawPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

/**
 * A value is SHA-like when it's a 7–40 character hex string. Used to decide
 * whether `ref` is a pinned commit (checkout detached, do not chase the
 * default branch) or a branch name (track + update to latest).
 */
function looksLikeCommitSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

export function createGitMirrorManager(opts: GitMirrorManagerOptions): GitMirrorManager {
  const legacyMirrorsRoot = join(opts.dataDir, "git-mirrors");
  const cloneTimeoutMs =
    opts.cloneTimeoutMs ?? Number(process.env.FIRST_TREE_GIT_CLONE_TIMEOUT_MS ?? DEFAULT_CLONE_TIMEOUT_MS);
  const log = opts.log;
  const resolvedDataDir = resolve(opts.dataDir);
  const hubManagedRoots = (opts.hubManagedRoots ?? []).map((p) => resolve(p));
  // Fail loud at construction if any managed root would let the self-heal
  // rm -rf escape `<dataDir>`. Strict subdir: the root itself MUST sit inside
  // `dataDir` and MUST NOT equal `dataDir`.
  const badRoots = hubManagedRoots.filter((root) => !isUnderManagedRoot(root, [resolvedDataDir]));
  if (badRoots.length > 0) {
    throw new GitMirrorError(
      `hubManagedRoots contains ${badRoots.length} entr${badRoots.length === 1 ? "y" : "ies"} not strictly inside dataDir "${resolvedDataDir}" — refusing to construct manager (would let self-heal rm -rf escape the First Tree data dir): ${badRoots.map((p) => `"${p}"`).join(", ")}`,
    );
  }

  // Per-clonePath serial queue. Prevents concurrent ensureSourceRepo /
  // removeSourceRepo for the same checkout from racing on the same directory.
  const pathLocks = new Map<string, Promise<unknown>>();

  function withPathLock<T>(clonePath: string, op: () => Promise<T>): Promise<T> {
    const key = resolve(clonePath);
    const prev = pathLocks.get(key) ?? Promise.resolve();
    const next = prev.then(op, op);
    pathLocks.set(key, next);
    next.then(
      () => {
        if (pathLocks.get(key) === next) pathLocks.delete(key);
      },
      () => {
        if (pathLocks.get(key) === next) pathLocks.delete(key);
      },
    );
    return next;
  }

  async function git(args: string[], cwd: string | null, timeoutMs: number, env?: NodeJS.ProcessEnv) {
    const start = Date.now();
    // Always disable git's tty prompt — under systemd / launchd the tty open
    // returns ENXIO which manifests as a confusing `could not read Username`
    // line in stderr; under interactive shells it would block indefinitely
    // (defeating the protocol-fallback path below). Force `LC_ALL=C` so
    // git/ssh stderr stays English regardless of locale — the credential-shape
    // and transient-network heuristics match against stderr substrings.
    const baseEnv = env ?? process.env;
    const finalEnv = { GIT_TERMINAL_PROMPT: "0", ...baseEnv, LC_ALL: "C" };
    return await new Promise<{ stdout: string; stderr: string; elapsedMs: number }>((resolveExec, rejectExec) => {
      // Track every git subprocess in the ChildProcessRegistry so the lifecycle
      // shutdown hook can kill stragglers if systemd SIGTERMs us mid-fetch.
      const { child: proc } = getChildProcessRegistry().spawn("git", args, {
        category: "git",
        label: `git ${args.join(" ").slice(0, 120)}`,
        cwd: cwd ?? undefined,
        env: finalEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (d) => {
        stdout += String(d);
      });
      proc.stderr?.on("data", (d) => {
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

  async function gitOk(args: string[], cwd: string, timeoutMs: number): Promise<boolean> {
    try {
      await git(args, cwd, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async function gitWithNetworkRetry(
    args: string[],
    cwd: string | null,
    timeoutMs: number,
    opLabel: string,
  ): Promise<{ stdout: string; stderr: string; elapsedMs: number }> {
    return retryOnTransientNetwork(() => git(args, cwd, timeoutMs), {
      delaysMs: NETWORK_RETRY_DELAYS_MS,
      isRetryable: isLikelyTransientNetworkError,
      onRetry: ({ attempt, nextDelayMs, message }) => {
        log?.warn(
          { op: opLabel, attempt, nextDelayMs, stderr: message.slice(0, 512) },
          "git remote op hit transient network error — retrying",
        );
      },
    });
  }

  /**
   * Run a remote-talking git op (`clone` / `fetch`) with one-shot bidirectional
   * protocol fallback. Decides direction from `url`'s protocol:
   *   - HTTPS → on credential-shaped failure, retry as SSH
   *   - SSH   → on credential-shaped failure, retry as HTTPS
   * Network failures, missing-ref errors, and TLS surprises propagate as-is.
   *
   * The retry uses `git -c url.<peer-base>.insteadOf=<origin-base>` — git
   * resolves the URL through that rewrite for one subprocess and never persists
   * anything. `partialCleanup` is invoked between attempts so a half-written
   * clone dir is removed before the fallback retries the same target.
   */
  async function remoteGitWithProtocolFallback(args: {
    gitArgs: string[];
    cwd: string | null;
    url: string;
    opLabel: string;
    partialCleanup?: () => void;
  }): Promise<{ elapsedMs: number; usedFallback: boolean }> {
    const { gitArgs, cwd, url, opLabel, partialCleanup } = args;
    const direction = pickFallbackDirection(url);
    try {
      const { elapsedMs } = await gitWithNetworkRetry(gitArgs, cwd, cloneTimeoutMs, `${opLabel}:primary`);
      return { elapsedMs, usedFallback: false };
    } catch (primaryErr) {
      const primaryMessage = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      if (!direction || !direction.shouldRetry(primaryMessage)) {
        throw primaryErr;
      }
      log?.info(
        {
          gitUrl: url,
          fromProtocol: direction.fromProtocol,
          toProtocol: direction.toProtocol,
          peerBase: direction.peerBase,
        },
        `${opLabel} failed with credential-shaped error; retrying with peer-protocol insteadOf rewrite`,
      );
      partialCleanup?.();
      try {
        const { elapsedMs } = await gitWithNetworkRetry(
          ["-c", `url.${direction.peerBase}.insteadOf=${direction.originBase}`, ...gitArgs],
          cwd,
          cloneTimeoutMs,
          `${opLabel}:fallback`,
        );
        log?.info({ gitUrl: url, toProtocol: direction.toProtocol }, `protocol-fallback ${opLabel} succeeded`);
        return { elapsedMs, usedFallback: true };
      } catch (peerErr) {
        const peerMessage = peerErr instanceof Error ? peerErr.message : String(peerErr);
        throw protocolFallbackFailure(
          `Could not ${opLabel} ${url} over ${direction.fromProtocol.toUpperCase()} or ${direction.toProtocol.toUpperCase()}. ` +
            `${direction.fromProtocol.toUpperCase()} attempt failed: ${truncate(primaryMessage)} ` +
            `${direction.toProtocol.toUpperCase()} retry (${direction.peerBase}) failed: ${truncate(peerMessage)}`,
          peerMessage,
        );
      }
    }
  }

  /** Fresh `git clone <url> <clonePath>` with protocol fallback. `clonePath` must not yet exist / be empty. */
  async function cloneRepo(absTarget: string, url: string): Promise<void> {
    mkdirSync(dirname(absTarget), { recursive: true });
    try {
      await remoteGitWithProtocolFallback({
        gitArgs: ["clone", url, absTarget],
        cwd: null,
        url,
        opLabel: "clone",
        partialCleanup: () => {
          if (existsSync(absTarget)) rmSync(absTarget, { recursive: true, force: true });
        },
      });
    } catch (err) {
      // Leave no half-written clone behind for the next session to trip over.
      if (existsSync(absTarget)) rmSync(absTarget, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Reconcile an existing clone's `remote.origin.url` with the configured `url`.
   * An operator may have repointed this localPath at a different repo, or
   * switched protocols (HTTPS ↔ SSH). Compared canonically so an equivalent
   * re-addressing of the same upstream is a no-op; a genuine change is written
   * so the subsequent fetch + `checkout -B` track the configured upstream
   * instead of silently serving the old one.
   */
  /**
   * True when `absTarget`'s current `remote.origin.url` already canonically
   * matches the configured `url` — i.e. reconcileOrigin would NOT repoint origin
   * to a different repo. Mirrors reconcileOrigin's own canonical comparison.
   * Gates the transient `stale-offline` degrade: serving the local checkout is
   * only safe when it is the SAME repo. Treats an unreadable / missing origin as
   * "not matching" (fail closed).
   */
  async function originCanonicallyMatches(absTarget: string, url: string): Promise<boolean> {
    try {
      const { stdout } = await git(["config", "--get", "remote.origin.url"], absTarget, 10_000);
      const current = stdout.trim();
      return current.length > 0 && canonicalizeRepoUrl(current) === canonicalizeRepoUrl(url);
    } catch {
      return false;
    }
  }

  async function reconcileOrigin(absTarget: string, url: string): Promise<void> {
    let current = "";
    try {
      const { stdout } = await git(["config", "--get", "remote.origin.url"], absTarget, 10_000);
      current = stdout.trim();
    } catch {
      current = "";
    }
    if (!current) {
      await git(["remote", "add", "origin", url], absTarget, 10_000);
      return;
    }
    if (canonicalizeRepoUrl(current) !== canonicalizeRepoUrl(url)) {
      await git(["remote", "set-url", "origin", url], absTarget, 10_000);
      // The new upstream may have a different default branch name (e.g.
      // master → main), leaving `refs/remotes/origin/HEAD` pointing at the OLD
      // default. `defaultBranchShort` detects + refreshes that staleness AFTER
      // the fetch (refreshing it here, pre-fetch, is unreliable — the target
      // remote-tracking ref doesn't exist yet on some git versions).
      log?.info(
        { clonePath: absTarget, from: current, to: url },
        "source-repo origin URL reconciled to configured url",
      );
    }
  }

  /** `git fetch --prune origin` against an existing clone, with protocol fallback. */
  async function fetchClone(absTarget: string, url: string): Promise<{ elapsedMs: number }> {
    const { elapsedMs } = await remoteGitWithProtocolFallback({
      gitArgs: ["fetch", "--prune", "origin"],
      cwd: absTarget,
      url,
      opLabel: "fetch",
    });
    return { elapsedMs };
  }

  async function headCommit(absTarget: string): Promise<string> {
    const head = await git(["rev-parse", "HEAD"], absTarget, 30_000);
    return head.stdout.trim();
  }

  /**
   * Resolve `ref` (branch / tag / commit) to a commit SHA in the LOCAL clone, or
   * null when it does not resolve locally. Used to confirm a configured `ref` is
   * already the checked-out HEAD before degrading to `stale-offline`.
   */
  async function localRefCommit(absTarget: string, ref: string): Promise<string | null> {
    try {
      const { stdout } = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], absTarget, 10_000);
      const sha = stdout.trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  /** Short branch name, or undefined when detached (`git rev-parse --abbrev-ref HEAD` → `HEAD`). */
  async function currentBranch(absTarget: string): Promise<string | undefined> {
    try {
      const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"], absTarget, 10_000);
      const name = stdout.trim();
      return name && name !== "HEAD" ? name : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A working tree is "dirty" when `git status --porcelain` reports anything —
   * staged, unstaged, or untracked (gitignored paths like `node_modules` /
   * build caches do NOT appear, so a freshly-cloned, never-installed repo reads
   * clean). Dirty checkouts are left untouched by the update path.
   */
  async function isDirty(absTarget: string): Promise<boolean> {
    const { stdout } = await git(["status", "--porcelain", "--untracked-files=normal"], absTarget, 30_000);
    return stdout.trim().length > 0;
  }

  /** Short name of the remote default branch, e.g. `main`. Null if unresolved. */
  async function defaultBranchShort(absTarget: string): Promise<string | null> {
    // `git symbolic-ref refs/remotes/origin/HEAD` → `refs/remotes/origin/main`.
    // Only TRUST it when its target remote-tracking ref actually exists — after
    // an origin repoint to a repo with a different default branch name,
    // origin/HEAD can be STALE (still points at the old default, whose ref no
    // longer exists post-fetch). A stale or missing HEAD falls through to the
    // refresh below.
    try {
      const { stdout } = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], absTarget, 10_000);
      const m = stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
      if (
        m?.[1] &&
        (await gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${m[1]}`], absTarget, 10_000))
      ) {
        return m[1];
      }
    } catch {
      // origin/HEAD not set — fall through to the repair below.
    }
    // Self-heal: ask the remote which branch HEAD points at and set it locally.
    if (await gitOk(["remote", "set-head", "origin", "--auto"], absTarget, 30_000)) {
      try {
        const { stdout } = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], absTarget, 10_000);
        const m = stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
        if (m?.[1]) return m[1];
      } catch {
        // give up below
      }
    }
    return null;
  }

  /**
   * Is `absTarget` a First Tree-managed standalone clone? True when it has a real
   * `.git` *directory* (not the `.git` *file* of a legacy shared-mirror
   * worktree, and not a non-git directory an operator dropped there).
   */
  function isStandaloneClone(absTarget: string): boolean {
    const gitPath = join(absTarget, ".git");
    if (!existsSync(gitPath)) return false;
    try {
      return statSync(gitPath).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Is `absTarget` a legacy shared-mirror worktree (the pre-refactor layout)?
   * Those have a `.git` *file* that points back into `<dataDir>/git-mirrors/`.
   * Detected so the first post-upgrade session can migrate it to a standalone
   * clone in place.
   */
  function isLegacyWorktreeCheckout(absTarget: string): boolean {
    const gitPath = join(absTarget, ".git");
    if (!existsSync(gitPath)) return false;
    try {
      return statSync(gitPath).isFile();
    } catch {
      return false;
    }
  }

  /** Wipe a leftover at `absTarget` (killing holders if under a managed root) so a clone can take its place. */
  async function reclaimTarget(absTarget: string, reason: string): Promise<void> {
    if (hubManagedRoots.length > 0 && isUnderManagedRoot(absTarget, hubManagedRoots)) {
      log?.warn({ targetPath: absTarget, reason }, "reclaiming source-repo target (kill holders + rm -rf)");
      await killProcessesHoldingPath(absTarget, log);
      rmSync(absTarget, { recursive: true, force: true });
      if (existsSync(absTarget)) {
        throw new GitMirrorWorktreeConflictError(
          `Source-repo target "${absTarget}" still occupied after reclaim (${reason}) — aborting`,
        );
      }
      return;
    }
    throw new GitMirrorWorktreeConflictError(
      `Source-repo target "${absTarget}" occupied by ${classifyOccupant(absTarget)} (${reason}) and not inside a First Tree-managed root — aborting (refusing to delete operator data)`,
    );
  }

  /**
   * Bring a clean, not-in-use clone to the requested commit-ish.
   * - explicit SHA `ref`   → detached checkout at that commit (pinned; no chase)
   * - explicit branch `ref`→ `checkout -B <ref> origin/<ref>`
   * - no `ref`             → `checkout -B <default> origin/<default>`
   *
   * Returns `"skipped-local-commits"` (and makes NO change) when the checkout's
   * current HEAD is strictly ahead of the resolved branch tip on the *same*
   * lineage — i.e. someone committed local work on top of the tracked branch.
   * `checkout -B` would orphan those commits, so we refuse and leave the
   * checkout as-is. A diverged/unrelated HEAD (e.g. after an origin repoint) is
   * NOT ahead-on-the-same-lineage, so it still resets cleanly. A pinned SHA
   * `ref` is explicit operator intent and is always applied.
   */
  async function updateToLatest(
    absTarget: string,
    ref: string | undefined,
  ): Promise<"applied" | "skipped-local-commits"> {
    if (ref && looksLikeCommitSha(ref)) {
      if (await gitOk(["cat-file", "-e", ref], absTarget, 10_000)) {
        await git(["checkout", "--force", "--detach", ref], absTarget, cloneTimeoutMs);
        return "applied";
      }
      // Not a known object — fall through to treat it as a branch name.
    }
    const branch = ref ?? (await defaultBranchShort(absTarget));
    if (!branch) {
      throw new GitMirrorError(
        `Cannot update "${absTarget}": no ref given and refs/remotes/origin/HEAD is unresolvable. Re-run with an explicit ref.`,
      );
    }
    const remoteRef = `refs/remotes/origin/${branch}`;
    if (!(await gitOk(["rev-parse", "--verify", "--quiet", remoteRef], absTarget, 10_000))) {
      throw new GitMirrorError(
        `Cannot update "${absTarget}": remote-tracking ref "${remoteRef}" not found after fetch.`,
      );
    }
    // Data-loss guard: skip the destructive reset when HEAD carries commits the
    // remote tip does NOT contain, on a *shared* history — i.e. local work
    // committed on top of (or diverged from) the tracked branch. `checkout -B`
    // would orphan those commits.
    //   - related (common ancestor exists) AND HEAD not an ancestor of remote
    //     → HEAD has its own commits → SKIP.
    //   - HEAD is an ancestor of remote (fast-forward, incl. equal)        → reset.
    //   - unrelated history (no common ancestor, e.g. origin repointed at a
    //     different repo)                                                  → reset.
    const related = await gitOk(["merge-base", remoteRef, "HEAD"], absTarget, 10_000);
    const headIsAncestorOfRemote = await gitOk(["merge-base", "--is-ancestor", "HEAD", remoteRef], absTarget, 10_000);
    if (related && !headIsAncestorOfRemote) {
      return "skipped-local-commits";
    }
    // `checkout -B` with a clean tree moves the local branch to the remote tip
    // and updates the working tree. Force-guards against a transient index lock.
    await git(["checkout", "-B", branch, remoteRef], absTarget, cloneTimeoutMs);
    return "applied";
  }

  return {
    get legacyMirrorsRoot() {
      return legacyMirrorsRoot;
    },

    ensureSourceRepo({ url, ref, clonePath, activelyInUse }) {
      return withPathLock(clonePath, async () => {
        const absTarget = resolve(clonePath);
        const finish = async (outcome: SourceRepoOutcome) => ({
          clonePath: absTarget,
          headCommit: await headCommit(absTarget),
          branch: await currentBranch(absTarget),
          outcome,
        });

        // Clone, or — when the failure is permission-shaped (host git identity
        // cannot see the repo) — skip the repo so the session still starts
        // degraded instead of aborting. `cloneRepo` already guarantees no
        // half-written clone survives a failure, so a skip leaves nothing on
        // disk. Every non-permission failure keeps today's fail-loud path.
        const cloneOrSkip = async (): Promise<SourceRepoDegradedInfo | null> => {
          try {
            await cloneRepo(absTarget, url);
            return null;
          } catch (err) {
            const degraded = classifyPermissionShapedGitError(err);
            if (!degraded) throw err;
            const stderr = err instanceof Error ? err.message : String(err);
            log?.warn(
              { gitUrl: url, clonePath: absTarget, reasonCode: degraded.reasonCode, stderr: stderr.slice(0, 1024) },
              "source-repo clone failed (permission-shaped) — skipping repo, session starts degraded",
            );
            return degraded;
          }
        };

        // (0) A symlink at the target is never one of our clones — `existsSync`
        // / `statSync` follow links, so without this guard a symlink pointing at
        // some real `.git` dir would be adopted and fetched/`checkout -B`'d
        // against the operator's link target. Reclaim it (inside a managed root)
        // or fail loud. `lstat` so a dangling link is caught too.
        let linkStat: ReturnType<typeof lstatSync> | null = null;
        try {
          linkStat = lstatSync(absTarget);
        } catch {
          linkStat = null;
        }
        if (linkStat?.isSymbolicLink()) {
          await reclaimTarget(absTarget, "symlink occupant");
        }

        // (1) Migration: a legacy shared-mirror worktree (`.git` is a FILE) →
        // replace in place with a standalone clone.
        if (existsSync(absTarget) && isLegacyWorktreeCheckout(absTarget)) {
          await reclaimTarget(absTarget, "legacy shared-mirror worktree");
          {
            const degraded = await cloneOrSkip();
            if (degraded) return { clonePath: absTarget, outcome: "skipped-unreachable", degraded };
          }
          if (ref) await updateToLatest(absTarget, ref);
          return finish("migrated-recloned");
        }

        // (2) Existing path occupied by a non-managed directory → reclaim or fail.
        if (existsSync(absTarget) && !isStandaloneClone(absTarget)) {
          await reclaimTarget(absTarget, "non-managed directory");
        }

        // (3) Fresh clone.
        if (!existsSync(absTarget)) {
          {
            const degraded = await cloneOrSkip();
            if (degraded) return { clonePath: absTarget, outcome: "skipped-unreachable", degraded };
          }
          if (ref) await updateToLatest(absTarget, ref);
          return finish("cloned");
        }

        // (4) Managed standalone clone → reconcile origin, fetch, then update when safe.
        //
        // Capture whether origin ALREADY canonically matched the configured
        // upstream *before* reconcileOrigin can repoint it. The transient
        // degrade below is only safe for the SAME repo: if this call is
        // repointing origin to a different repo and the confirming fetch then
        // fails, the local checkout is the OLD repo's content and must NOT be
        // served as the newly-configured source.
        const originMatchedBeforeFetch = await originCanonicallyMatches(absTarget, url);
        try {
          await reconcileOrigin(absTarget, url);
          await fetchClone(absTarget, url);
        } catch (err) {
          const stderr = err instanceof Error ? err.message : String(err);

          // Degrade-on-transient-fetch-failure: when GitHub is briefly
          // unreachable (a network blip, not an auth/corrupt/TLS-trust fault)
          // and a usable checkout of the SAME repo already exists on disk, do
          // NOT abort session start/resume — leave the clone at its current
          // commit and continue on the last-good source. The agent stays
          // answerable (e.g. to debug the very outage that broke the network),
          // and the next session's fetch recovers it implicitly. Same "left at
          // current commit" contract as the skipped-* outcomes; the only new
          // thing is that the fetch itself didn't succeed.
          //
          // Strictly gated — every one of these must hold, else fail closed:
          //   • high-confidence transient *network* error (not auth / corrupt /
          //     TLS-trust / our own timeout / repo-not-found);
          //   • `absTarget` is a real standalone clone with a resolvable HEAD;
          //   • origin already matched the configured upstream (no repoint —
          //     "configured repo changed but fetch could not confirm it" fails
          //     closed);
          //   • any configured `ref` is ALREADY the checked-out HEAD. It is not
          //     enough that `ref` merely resolves locally: prepareSourceRepos
          //     surfaces the configured `ref` to the runtime/briefing, so
          //     returning a HEAD that differs from `ref` would advertise the
          //     repo as being at `ref` while serving another commit — and for a
          //     pinned commit, break the honor-as-is contract. When `ref` has
          //     just changed to something the current HEAD is not at, fail
          //     closed (we cannot move to it safely without a confirmed fetch).
          // Silently serving a stale checkout otherwise would mask a real,
          // non-self-healing problem.
          // Shared safety gate for both stale degrades (`stale-offline` and
          // `stale-unreachable` below): returns the frozen HEAD sha when ALL
          // gates hold, null otherwise (fail closed → fall through to throw).
          const frozenHeadIfSafe = async (): Promise<string | null> => {
            if (!isStandaloneClone(absTarget) || !originMatchedBeforeFetch) return null;
            let headSha: string | null = null;
            try {
              headSha = await headCommit(absTarget);
            } catch {
              headSha = null;
            }
            if (headSha === null) return null;
            const refSatisfiedByHead = !ref || (await localRefCommit(absTarget, ref)) === headSha;
            return refSatisfiedByHead ? headSha : null;
          };

          if (isLikelyTransientNetworkError(stderr) && (await frozenHeadIfSafe()) !== null) {
            log?.warn(
              { gitUrl: url, clonePath: absTarget, stderr: stderr.slice(0, 1024) },
              "source-repo fetch failed (transient network) — using existing local checkout, left at current commit (stale)",
            );
            return finish("stale-offline");
          }

          // Degrade-on-permission-shaped-fetch-failure: the host's git identity
          // cannot see the repo anymore (credentials revoked / expired, or the
          // repo went private-invisible — GitHub serves 404 for those). Unlike
          // the transient branch above this will NOT self-heal, so the outcome
          // is distinct (`stale-unreachable`) and carries `degraded` for the
          // workspace-health report: the checkout is served frozen at its
          // last-good commit until credentials are fixed on the host. Same
          // strict safety gates as `stale-offline`; any gate failing falls
          // through to the fail-loud throw below (error-taxonomy fallback).
          const degraded = classifyPermissionShapedGitError(err);
          if (degraded) {
            const headSha = await frozenHeadIfSafe();
            if (headSha !== null) {
              log?.warn(
                { gitUrl: url, clonePath: absTarget, reasonCode: degraded.reasonCode, stderr: stderr.slice(0, 1024) },
                "source-repo fetch failed (permission-shaped) — serving existing checkout frozen at current commit (stale-unreachable)",
              );
              return { ...(await finish("stale-unreachable")), degraded };
            }
          }

          log?.warn(
            {
              gitUrl: url,
              clonePath: absTarget,
              errorCode:
                err instanceof GitMirrorAuthError
                  ? "auth-failed"
                  : err instanceof GitMirrorTimeoutError
                    ? "timeout"
                    : err instanceof GitMirrorError
                      ? "git-failed"
                      : "unknown",
              stderr: stderr.slice(0, 1024),
            },
            "source-repo fetch failed",
          );
          throw err;
        }

        if (activelyInUse) {
          log?.debug({ clonePath: absTarget }, "source-repo update skipped — another live session is using it");
          return finish("skipped-in-use");
        }
        if (await isDirty(absTarget)) {
          log?.warn(
            { clonePath: absTarget },
            "source-repo has local changes — leaving at current commit, not updating to latest",
          );
          return finish("skipped-dirty");
        }

        const before = await headCommit(absTarget);
        const update = await updateToLatest(absTarget, ref);
        if (update === "skipped-local-commits") {
          log?.warn(
            { clonePath: absTarget },
            "source-repo has local commits ahead of upstream — leaving at current commit, not resetting to latest",
          );
          return finish("skipped-local-commits");
        }
        const after = await headCommit(absTarget);
        return finish(after === before ? "unchanged" : "updated");
      });
    },

    removeSourceRepo({ clonePath }) {
      return withPathLock(clonePath, async () => {
        const absTarget = resolve(clonePath);
        // Kill any daemonised child the previous session left behind (vite,
        // esbuild, test watcher, ...) BEFORE rmdir — otherwise it keeps writing
        // under `absTarget` and repopulates the dir between rm and the next
        // session's clone. Gated by `hubManagedRoots` so we never signal
        // processes whose cwd is an operator path.
        if (hubManagedRoots.length > 0 && isUnderManagedRoot(absTarget, hubManagedRoots) && existsSync(absTarget)) {
          await killProcessesHoldingPath(absTarget, log);
        }
        if (existsSync(absTarget)) rmSync(absTarget, { recursive: true, force: true });
      });
    },

    async sweepLegacyMirrors() {
      // `lstat` (NOT `existsSync`, which follows links): if `git-mirrors` was
      // replaced by a symlink, `readdirSync` would enumerate the link TARGET and
      // the per-child `rm -rf` would delete contents OUTSIDE `<dataDir>` — an
      // escape past every other guard in this module. We only ever recurse into
      // a real directory we own; a symlink / non-directory at the cache root is
      // not something First Tree created, so we unlink the entry itself (never
      // descend into a symlink target) and stop.
      let rootStat: ReturnType<typeof lstatSync>;
      try {
        rootStat = lstatSync(legacyMirrorsRoot);
      } catch {
        return { removed: [] }; // absent
      }
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        try {
          // `unlinkSync` removes the symlink (or stray file) itself and never
          // follows into / deletes a symlink target's contents.
          unlinkSync(legacyMirrorsRoot);
        } catch (err) {
          log?.warn(
            { legacyMirrorsRoot, err: err instanceof Error ? err.message : String(err) },
            "sweepLegacyMirrors: cache root is a symlink/non-directory — removed the entry itself, did not descend",
          );
        }
        return { removed: [] };
      }
      const removed: string[] = [];
      try {
        for (const entry of readdirSync(legacyMirrorsRoot)) {
          const path = join(legacyMirrorsRoot, entry);
          rmSync(path, { recursive: true, force: true });
          removed.push(entry);
        }
        rmSync(legacyMirrorsRoot, { recursive: true, force: true });
      } catch (err) {
        log?.warn(
          { legacyMirrorsRoot, err: err instanceof Error ? err.message : String(err) },
          "sweepLegacyMirrors: partial failure removing legacy shared-mirror tree",
        );
      }
      if (removed.length > 0) {
        log?.info({ legacyMirrorsRoot, removed: removed.length }, "swept legacy shared git-mirrors tree");
      }
      return { removed };
    },
  };
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

/**
 * Thrown when both the primary protocol and the peer-protocol fallback fail.
 * The message carries trimmed stderr from both attempts so the operator can see
 * whether the host's HTTPS credentials are missing, the SSH key is missing, or
 * both.
 */
export class GitMirrorAuthError extends GitMirrorError {
  constructor(message: string) {
    super(message);
    this.name = "GitMirrorAuthError";
  }
}

/**
 * Heuristic for HTTPS-side credential failures. Matches the indicators git
 * itself emits over libcurl / git-credential helpers, regardless of platform.
 *
 * Negative space (intentionally NOT matched): network errors, repo errors,
 * TLS errors — those won't be cured by switching transports.
 *
 * Exported for unit testing.
 */
export function isLikelyHttpsAuthFailure(message: string): boolean {
  if (!message) return false;
  return (
    /could not read Username/i.test(message) ||
    /could not read Password/i.test(message) ||
    /Authentication failed/i.test(message) ||
    /terminal prompts disabled/i.test(message) ||
    /HTTP\s*(?:Basic:\s*)?Access denied/i.test(message) ||
    /\bHTTP[/ ]?(1\.[01]|2|2\.0)?\s*40[13]\b/i.test(message) ||
    /\bfatal:\s*unable to access\b.*\b(401|403)\b/i.test(message) ||
    /\bremote: Invalid username or password\b/i.test(message)
  );
}

/**
 * Heuristic for SSH-side credential failures (no key on disk, key not accepted
 * by remote, agent has nothing usable, host key mismatch).
 *
 * Negative space (intentionally NOT matched): SSH-level network errors, and the
 * generic `fatal: Could not read from remote repository.` line (git appends it
 * to *every* SSH transport failure regardless of cause).
 *
 * Exported for unit testing.
 */
export function isLikelySshAuthFailure(message: string): boolean {
  if (!message) return false;
  return (
    /Permission denied\s*(?:\(|,)/i.test(message) ||
    /Host key verification failed/i.test(message) ||
    /no matching host key type/i.test(message) ||
    /no mutual signature algorithm/i.test(message)
  );
}

/**
 * Back-compat alias — matches *either* HTTPS or SSH credential failures.
 * Internal callers prefer the direction-specific predicates.
 */
export function isLikelyAuthFailure(message: string): boolean {
  return isLikelyHttpsAuthFailure(message) || isLikelySshAuthFailure(message);
}

/**
 * Heuristic for "the remote refused because the repository does not exist /
 * is no longer accessible to this identity". A pure-configuration fault: a
 * typo'd URL, a deleted/renamed repo, or a private repo the host's git
 * identity cannot see — none of which `gitWithNetworkRetry`'s in-process
 * backoff or the peer-protocol fallback can ever cure. Classified as
 * `permanent` so session start fails loud and the operator gets a clear
 * "fix the source repo URL" prompt instead of an endless `unknown`-bucket
 * retry storm.
 *
 * Negative space (intentionally NOT matched): credential failures (covered by
 * `isLikelyHttpsAuthFailure` / `isLikelySshAuthFailure` and treated as
 * degraded), missing *refs* in an otherwise-reachable repo (covered by
 * `isLikelyRefNotFound`), and transient 404s served by a flaky proxy (these
 * don't carry the `Repository not found` / `remote: Not Found` markers git
 * emits when the upstream itself reports 404).
 *
 * Exported for unit testing.
 */
export function isLikelyRepoNotFound(message: string): boolean {
  if (!message) return false;
  return (
    /remote:\s*Repository not found/i.test(message) ||
    /\bfatal:\s*repository\s+'[^']*'\s+not found/i.test(message) ||
    /\bremote:\s*Not Found\b/i.test(message) ||
    /\brequested URL returned error:\s*404\b/i.test(message) ||
    // GitLab's "The project you were looking for could not be found".
    /The project you were looking for could not be found/i.test(message)
  );
}

/**
 * Classify a clone/fetch failure as "permission-shaped" — the host's git
 * identity cannot see the repo. This is the (deliberately conservative)
 * skippable set behind the degraded-workspace start: only these two shapes
 * degrade to `skipped-unreachable` / `stale-unreachable`; every other failure
 * keeps today's fail-loud behaviour with the error-taxonomy as fallback.
 *
 *  - `GitMirrorAuthError` → `git_clone_auth_failed`. Thrown only when BOTH the
 *    primary protocol and the peer-protocol fallback failed with credential-
 *    shaped errors — checked FIRST since it extends `GitMirrorError`.
 *  - plain `GitMirrorError` matching `isLikelyRepoNotFound` →
 *    `git_repo_not_found`. GitHub deliberately serves 404 for private repos
 *    the identity cannot see, so "no permission" usually LOOKS like not-found.
 *    `GitMirrorTimeoutError` is excluded (a timeout is never permission-shaped,
 *    even if its message happened to quote a 404).
 *  - spawn-level `ENOENT` (NOT a `GitMirrorError` — the `git` binary itself is
 *    missing from the host) → `git_not_installed`. The single most common
 *    all-repos-unreachable cause: a fresh machine where gh/git was never
 *    installed. Caveat: `spawn` also reports ENOENT for a missing *cwd*, but
 *    every caller verifies the cwd exists (or passes none) before spawning.
 *
 * The returned `errorPreview` is already passed through `redactErrorPreview`
 * (host-side redaction contract: credentials never reach the DB / console).
 * Exported for unit testing.
 */
export function classifyPermissionShapedGitError(err: unknown): SourceRepoDegradedInfo | null {
  if (err instanceof GitMirrorAuthError) {
    return { reasonCode: "git_clone_auth_failed", errorPreview: redactErrorPreview(err.message) };
  }
  if (err instanceof GitMirrorError) {
    if (!(err instanceof GitMirrorTimeoutError) && isLikelyRepoNotFound(err.message)) {
      return { reasonCode: "git_repo_not_found", errorPreview: redactErrorPreview(err.message) };
    }
    return null;
  }
  if (err instanceof Error && "code" in err && err.code === "ENOENT") {
    return { reasonCode: "git_not_installed", errorPreview: redactErrorPreview(err.message) };
  }
  return null;
}

/**
 * Heuristic for "the repository is reachable but the configured branch / tag /
 * commit does not exist on it". Permanent for the same reason as
 * `isLikelyRepoNotFound`: only an operator can fix the ref, retrying churns.
 *
 * Distinct from `isLikelyRepoNotFound` because the remediation is different —
 * here the URL is fine, only `ref` (or origin/HEAD when no ref is set) is wrong.
 *
 * Exported for unit testing.
 */
export function isLikelyRefNotFound(message: string): boolean {
  if (!message) return false;
  return (
    /couldn'?t find remote ref/i.test(message) ||
    /Could not find remote branch/i.test(message) ||
    /Remote branch\s+\S+\s+not found in upstream/i.test(message) ||
    /\bdid not match any file\(s\) known to git\b/i.test(message) ||
    // git 2.x: `fatal: invalid reference: <name>` from `checkout -B` against
    // a remote-tracking ref that never showed up after fetch.
    /\bfatal:\s*invalid reference:\s/i.test(message) ||
    // `git symbolic-ref refs/remotes/origin/HEAD` / `remote set-head --auto`
    // failed because the remote has no HEAD — already a GitMirrorError; matched
    // here for classification.
    /no\s+matching\s+remote\s+head/i.test(message)
  );
}

/**
 * Heuristic for "TLS verification failed against the configured remote". A
 * host-level trust-store fault: missing CA bundle, system clock skew past a
 * cert's notAfter, self-signed cert without explicit `http.sslCAInfo`, or
 * MITM by a corporate proxy whose root CA isn't installed. Retrying with the
 * same machine state cannot cure any of these — `permanent` + operator action.
 *
 * Mirror of the negative-space cases already excluded from
 * `isLikelyTransientNetworkError`, lifted to a positive predicate so the
 * taxonomy can attach a specific `reasonCode` instead of falling through to
 * `git_unknown`.
 *
 * Exported for unit testing.
 */
export function isLikelyTlsTrustFailure(message: string): boolean {
  if (!message) return false;
  return (
    /SSL certificate problem/i.test(message) ||
    /server certificate verification failed/i.test(message) ||
    /certificate verify failed/i.test(message) ||
    /self.signed certificate/i.test(message) ||
    /unable to get local issuer certificate/i.test(message) ||
    /certificate has expired/i.test(message) ||
    // libcurl `CURLE_PEER_FAILED_VERIFICATION` and friends sometimes surface
    // as a bare `SSL peer certificate or SSH remote key was not OK`.
    /SSL peer certificate or SSH remote key was not OK/i.test(message)
  );
}

/**
 * Heuristic for "local disk failure interrupted the git op" — out-of-space,
 * read-only mount, or quota exceeded. Degraded rather than permanent: the
 * runtime as a whole is healthy and other agents whose clones already fit on
 * disk keep working; only this one source-repo target is unusable until the
 * operator frees space / fixes the mount.
 *
 * Exported for unit testing.
 */
export function isLikelyGitDiskError(message: string): boolean {
  if (!message) return false;
  return (
    /\bENOSPC\b/.test(message) ||
    /\bEROFS\b/.test(message) ||
    /\bEDQUOT\b/.test(message) ||
    /no space left on device/i.test(message) ||
    /Disk quota exceeded/i.test(message) ||
    /Read-only file system/i.test(message) ||
    // Pack-write side: git surfaces ENOSPC as `fatal: write error: No space
    // left on device` during `clone`/`fetch` index-pack.
    /\bfatal:\s*write error:\s*No space left on device/i.test(message)
  );
}

/**
 * Heuristic for transient network-layer failures emitted by `git` over HTTPS or
 * SSH — a brief proxy/VPN hiccup, TLS handshake blip, or peer connection reset
 * mid-fetch. Used by `gitWithNetworkRetry` around `clone` and `fetch`.
 *
 * Negative space (intentionally NOT matched): credential failures (handled by
 * the protocol-fallback path), deterministic content errors, TLS trust
 * failures, and our own per-call timeout.
 *
 * On localhost-proxy specifically, `ECONNREFUSED` IS a transient signal — when
 * Surge / Clash bounces the listener, the next attempt sees it back up within
 * seconds.
 *
 * Exported for unit testing.
 */
export function isLikelyTransientNetworkError(message: string): boolean {
  if (!message) return false;
  if (isLikelyHttpsAuthFailure(message) || isLikelySshAuthFailure(message)) return false;
  // TLS trust failures (cert verify / self-signed / expired CA / etc) are
  // host-configuration faults — retrying with the same machine state cannot
  // cure them. Delegated to `isLikelyTlsTrustFailure` so the pattern set
  // stays single-source; previously this inlined ~6 cert-* regexes that
  // duplicated and drifted from the dedicated helper.
  if (isLikelyTlsTrustFailure(message)) return false;
  return (
    /SSL_ERROR_SYSCALL/i.test(message) ||
    /unexpected eof while reading/i.test(message) ||
    /TLS handshake|gnutls_handshake|gnutls\s+recv\s+error/i.test(message) ||
    /\bConnection reset(?:\s+by\s+peer)?\b/i.test(message) ||
    /\bConnection refused\b/i.test(message) ||
    /\bConnection timed out\b/i.test(message) ||
    /\bOperation timed out\b/i.test(message) ||
    /\bNetwork is unreachable\b/i.test(message) ||
    /Could not resolve host(?:name)?/i.test(message) ||
    /Temporary failure in name resolution/i.test(message) ||
    // curl 7: `Failed to connect to <host> port <n> ...` and curl 28's
    // `Couldn't connect to server` — a server unreachable / connect timeout.
    /Failed to connect to\s+\S+\s+port\s+\d+/i.test(message) ||
    /Couldn't connect to server/i.test(message) ||
    // curl 56 via a local proxy (Surge / Clash): the proxy accepted the
    // connection but tore down the CONNECT tunnel — same bounce class as
    // the localhost ECONNREFUSED case above.
    /Proxy CONNECT aborted/i.test(message) ||
    // HTTP/2 transport framing fault (libcurl `CURLE_HTTP2`) seen as a
    // mid-handshake `Error in the HTTP2 framing layer` against github.com.
    /Error in the HTTP[/]?2 framing layer/i.test(message) ||
    /\bRPC failed\b/i.test(message) ||
    /\bearly EOF\b/i.test(message) ||
    /the remote end hung up unexpectedly/i.test(message) ||
    /transfer closed with outstanding read data remaining/i.test(message) ||
    /HTTP\/2 stream\s+\d+\s+was\s+(?:not\s+)?(?:reset|closed)/i.test(message) ||
    /HTTP\/2 stream was reset/i.test(message) ||
    /unexpected disconnect while reading sideband packet/i.test(message) ||
    /fetch-pack: unexpected disconnect/i.test(message) ||
    /\bsend-pack:\s+unexpected\s+disconnect\b/i.test(message)
  );
}

/**
 * Decide the error shape when the primary protocol failed credential-shaped
 * AND the peer-protocol `insteadOf` fallback also failed.
 *
 * Only the primary side is known to be credential-shaped at this point. When
 * the peer attempt died for a transient network reason (a DNS / VPN / proxy
 * outage that outlasted `gitWithNetworkRetry`'s short in-process budget), the
 * combined failure is NOT evidence that both transports' credentials are
 * broken — `GitMirrorAuthError` here would let the error taxonomy classify
 * the session failure as degraded/no-retry and turn a temporary outage into a
 * terminal chat error. Keep that case a plain (session-retryable)
 * `GitMirrorError`; reserve `GitMirrorAuthError` for peers that failed
 * non-transiently.
 *
 * Exported for unit testing.
 */
export function protocolFallbackFailure(combinedMessage: string, peerMessage: string): GitMirrorError {
  return isLikelyTransientNetworkError(peerMessage)
    ? new GitMirrorError(combinedMessage)
    : new GitMirrorAuthError(combinedMessage);
}

/**
 * Map an HTTPS git URL to the `insteadOf` rewrite needed to make git resolve it
 * through SSH. Returns *base* strings (suitable for
 * `git -c url.<sshBase>.insteadOf=<httpsBase>`).
 *
 *   `https://github.com/owner/repo.git` → `git@github.com:` / `https://github.com/`
 *
 * Returns `null` for inputs that should NOT trigger fallback (non-HTTPS,
 * embedded creds, non-default port, unparseable). Exported for unit testing.
 */
export function httpsToSshBaseRewrite(url: string): { httpsBase: string; sshBase: string } | null {
  if (!url || !/^https:\/\//i.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  if (!parsed.hostname) return null;
  if (parsed.port && parsed.port !== "443") return null;
  return {
    httpsBase: `https://${parsed.hostname}/`,
    sshBase: `git@${parsed.hostname}:`,
  };
}

/**
 * Map an SSH git URL (either `ssh://` or scp-like `[user@]host:path`) to the
 * `insteadOf` rewrite for resolving via HTTPS. Mirror of
 * `httpsToSshBaseRewrite`.
 *
 * Returns `null` when not SSH-shaped, embedded password, or non-default port.
 * Exported for unit testing.
 */
export function sshToHttpsBaseRewrite(url: string): { sshBase: string; httpsBase: string } | null {
  if (!url) return null;
  if (!url.includes("://")) {
    const m = url.match(/^((?:[A-Za-z0-9_.-]+@)?)([A-Za-z0-9.-]+):([^/@:\s][^@:\s]*)$/);
    const userAt = m?.[1];
    const host = m?.[2];
    const path = m?.[3];
    if (userAt === undefined || !host || !path) return null;
    if (/^\d+(?:\/|$)/.test(path)) return null;
    return {
      sshBase: `${userAt}${host}:`,
      httpsBase: `https://${host}/`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ssh:") return null;
  if (parsed.password.length > 0) return null;
  if (!parsed.hostname) return null;
  if (parsed.port && parsed.port !== "22") return null;
  const userAt = parsed.username.length > 0 ? `${parsed.username}@` : "";
  const sshBase = parsed.port
    ? `ssh://${userAt}${parsed.hostname}:${parsed.port}/`
    : `ssh://${userAt}${parsed.hostname}/`;
  return {
    sshBase,
    httpsBase: `https://${parsed.hostname}/`,
  };
}

type FallbackDirection = {
  fromProtocol: "https" | "ssh";
  toProtocol: "https" | "ssh";
  /** The base prefix git will see in the on-disk URL. */
  originBase: string;
  /** The base prefix to rewrite to (the peer-protocol form). */
  peerBase: string;
  /** Direction-specific failure classifier. */
  shouldRetry(stderr: string): boolean;
};

/**
 * Same shape as `SCP_LIKE_SSH_RE` in the shared schema — kept in sync so what
 * the schema accepts is exactly what we route through the SSH-side fallback.
 */
const SCP_LIKE_RE = /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9.-]+:(?!\d+(?:\/|$))[^/:@\s][^:@\s]*$/;

function pickFallbackDirection(originUrl: string): FallbackDirection | null {
  if (/^https:\/\//i.test(originUrl)) {
    const r = httpsToSshBaseRewrite(originUrl);
    if (!r) return null;
    return {
      fromProtocol: "https",
      toProtocol: "ssh",
      originBase: r.httpsBase,
      peerBase: r.sshBase,
      shouldRetry: isLikelyHttpsAuthFailure,
    };
  }
  if (/^ssh:\/\//i.test(originUrl) || SCP_LIKE_RE.test(originUrl)) {
    const r = sshToHttpsBaseRewrite(originUrl);
    if (!r) return null;
    return {
      fromProtocol: "ssh",
      toProtocol: "https",
      originBase: r.sshBase,
      peerBase: r.httpsBase,
      shouldRetry: isLikelySshAuthFailure,
    };
  }
  return null;
}

function truncate(text: string, max = 512): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated]`;
}

/**
 * Run `op` once, and on a `isRetryable`-classified failure replay it on the
 * given backoff schedule. Non-retryable failures propagate immediately.
 *
 * Per-attempt timeouts (when `op` enforces one of its own) are NOT reset across
 * attempts: each attempt gets its own full budget.
 *
 * Exported so unit tests can drive the retry policy with a mock `op`.
 */
export async function retryOnTransientNetwork<T>(
  op: (attempt: number) => Promise<T>,
  options: {
    delaysMs: readonly number[];
    isRetryable: (message: string) => boolean;
    onRetry?: (info: { attempt: number; nextDelayMs: number; message: string }) => void;
  },
): Promise<T> {
  const { delaysMs, isRetryable, onRetry } = options;
  const maxAttempts = delaysMs.length + 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op(attempt);
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!isRetryable(message)) throw err;
      if (attempt === maxAttempts) throw err;
      const baseDelay = delaysMs[attempt - 1];
      if (baseDelay === undefined) throw err;
      const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseDelay / 4)));
      const delayMs = baseDelay + jitter;
      onRetry?.({ attempt, nextDelayMs: delayMs, message });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
