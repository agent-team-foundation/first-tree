import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { pino } from "../observability/logger.js";

const DEFAULT_CLONE_TIMEOUT_MS = 5 * 60 * 1000;

const FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
const SESSION_BRANCH_PREFIX = "hub-session";

/**
 * Per-URL bare mirror manager.
 *
 * Layout:
 *   <dataDir>/git-mirrors/<sha256(url)>/  ← bare repo (shared object store)
 *
 * Isolation model:
 * - The mirror is configured with `remote.origin.fetch = +refs/heads/*:refs/remotes/origin/*`
 *   and `remote.origin.mirror` unset. `git fetch` therefore writes only to
 *   `refs/remotes/origin/*` and never touches `refs/heads/*`.
 * - Each session owns a dedicated local branch `hub-session-<sessionHash>-<urlHash>`
 *   in the mirror. Worktrees attach to that branch, not to a remote-tracking ref,
 *   so two sessions on the same URL get disjoint branch names and cannot
 *   collide on `git worktree add` or on `git fetch` ref locks.
 *
 * Authentication strategy:
 * - Credentials are delegated to the host Git environment (credential
 *   helpers, GCM, ssh agent, on-disk keys). Every spawned `git` has
 *   `GIT_TERMINAL_PROMPT=0` so missing credentials fail fast instead of
 *   blocking on a tty that doesn't exist under systemd / launchd.
 * - When `fetch origin` fails with a credential-shaped error, we
 *   transparently retry once via the *peer* protocol (HTTPS → SSH or
 *   SSH → HTTPS, decided by the configured origin URL), using a
 *   process-scoped `git -c url.<peer-base>.insteadOf=<origin-base>`
 *   rewrite. No host gitconfig is touched and no on-disk
 *   `remote.origin.url` is mutated. Mirror dir hashes use the canonical
 *   form (host + path), so HTTPS and SSH addressing of the same repo
 *   collapse to one mirror dir on disk regardless of which protocol the
 *   admin configured.
 */
export type GitMirrorManagerOptions = {
  dataDir: string;
  cloneTimeoutMs?: number;
  log?: pino.Logger;
};

export interface GitMirrorManager {
  ensureMirror(url: string): Promise<{ mirrorPath: string; elapsedMs: number; cloned: boolean }>;
  fetchMirror(url: string): Promise<{ elapsedMs: number }>;
  createWorktree(args: {
    url: string;
    ref?: string;
    targetPath: string;
    sessionKey: string;
  }): Promise<{ worktreePath: string; headCommit: string; branchName: string }>;
  removeWorktree(args: { url: string; path: string; branchName: string }): Promise<void>;
  gcMirrors(stillReferencedUrls: Set<string>): Promise<{ removed: string[] }>;
  readonly mirrorsRoot: string;
}

/**
 * Hash a repo URL into the mirror directory name.
 *
 * The hash is computed over a *canonical* form (host + path, lowercased
 * host, no `.git` suffix, no leading/trailing slash, no protocol, no
 * `user@` prefix), so the same upstream repo addressed via any of the
 * accepted forms (HTTPS, `ssh://`, or scp-like) all land in the same
 * mirror dir. That matters because:
 *   - admins may write any of those three forms into `source_repos[].url`
 *     (the schema accepts all of them)
 *   - the `fetchOrigin` fallback below transparently swaps protocols when
 *     credentials are missing — without canonical hashing, the fallback
 *     would silently maintain a second mirror dir
 *
 * Migration cost: pre-existing mirrors created before this change use the
 * raw-URL hash and will be orphaned after the upgrade. `gcMirrors` removes
 * them on the next run; the next fetch repopulates the canonical-keyed
 * mirror. No data loss — mirror is a cache, not state.
 */
export function hashUrl(url: string): string {
  return createHash("sha256").update(canonicalizeRepoUrl(url)).digest("hex").slice(0, 32);
}

/**
 * Reduce a repo URL to `<host[:port]>/<path-without-.git>`. Used as the
 * input to the mirror dir hash and exposed for unit testing.
 *
 *   `https://github.com/foo/bar.git`         → `github.com/foo/bar`
 *   `git@github.com:foo/bar.git`             → `github.com/foo/bar`
 *   `ssh://git@github.com/foo/bar.git`       → `github.com/foo/bar`
 *   `ssh://git@gitlab.example.com:2222/x/y`  → `gitlab.example.com:2222/x/y`
 *
 * Falls back to the raw input for un-parseable strings — better to keep
 * a stable mirror than to throw mid-bootstrap.
 */
export function canonicalizeRepoUrl(url: string): string {
  // scp-like: `[user@]host:path` (no `://`, exactly one `:` between host
  // and path, path doesn't look like a port number, path forbids leading
  // `/` and any `:`/`@` — same rules as `SCP_LIKE_SSH_RE` in the shared
  // schema, so what passes input validation is also what we can canonicalise.
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
    // Drop the port when it matches the protocol's default — keeps `https`
    // and `ssh` (port 22) addressing the same upstream collapse to one dir.
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
 * Strip leading slashes, trailing slashes, and a trailing `.git`. Used by
 * `canonicalizeRepoUrl` so that `…/foo/bar`, `…/foo/bar/`, and `…/foo/bar.git`
 * all collapse to the same canonical path (and therefore the same mirror dir).
 */
function normalizePath(rawPath: string): string {
  return rawPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

export function deriveSessionBranchName(sessionKey: string, url: string): string {
  return `${SESSION_BRANCH_PREFIX}-${shortHash(sessionKey)}-${shortHash(url)}`;
}

/**
 * A value is SHA-like when it's a 7–40 character hex string. Used to decide
 * whether `ref` should be resolved via the remote namespace (branch name) or
 * used as-is (commit hash).
 */
function looksLikeCommitSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

export function createGitMirrorManager(opts: GitMirrorManagerOptions): GitMirrorManager {
  const mirrorsRoot = join(opts.dataDir, "git-mirrors");
  const cloneTimeoutMs =
    opts.cloneTimeoutMs ?? Number(process.env.FIRST_TREE_HUB_GIT_CLONE_TIMEOUT_MS ?? DEFAULT_CLONE_TIMEOUT_MS);
  const log = opts.log;

  // Per-URL serial queue. Prevents concurrent ensureMirror / fetchMirror /
  // gcMirrors for the same URL from racing on the same directory.
  const urlLocks = new Map<string, Promise<unknown>>();

  function withUrlLock<T>(url: string, op: () => Promise<T>): Promise<T> {
    const key = hashUrl(url);
    const prev = urlLocks.get(key) ?? Promise.resolve();
    const next = prev.then(op, op);
    urlLocks.set(key, next);
    // Drop the map entry once the tail resolves so a long-lived manager doesn't
    // leak one entry per URL forever. Silently swallow errors on this side
    // channel — the real rejection is delivered via the returned `next`.
    next.then(
      () => {
        if (urlLocks.get(key) === next) urlLocks.delete(key);
      },
      () => {
        if (urlLocks.get(key) === next) urlLocks.delete(key);
      },
    );
    return next;
  }

  function mirrorDir(url: string): string {
    return join(mirrorsRoot, hashUrl(url));
  }

  async function git(args: string[], cwd: string | null, timeoutMs: number, env?: NodeJS.ProcessEnv) {
    const start = Date.now();
    // Always disable git's tty prompt — under systemd / launchd the tty open
    // returns ENXIO ("No such device or address") which manifests as a confusing
    // `could not read Username for '<realm>'` line in stderr; under interactive
    // shells it would block the request indefinitely instead of failing fast
    // (defeating the ssh-fallback path below). Callers can still override by
    // passing an `env` that sets `GIT_TERMINAL_PROMPT` explicitly.
    const baseEnv = env ?? process.env;
    const finalEnv = { GIT_TERMINAL_PROMPT: "0", ...baseEnv };
    return await new Promise<{ stdout: string; stderr: string; elapsedMs: number }>((resolveExec, rejectExec) => {
      const proc = spawn("git", args, {
        cwd: cwd ?? undefined,
        env: finalEnv,
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

  async function gitOk(args: string[], cwd: string, timeoutMs: number): Promise<boolean> {
    try {
      await git(args, cwd, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `git fetch --prune origin` with one-shot bidirectional protocol fallback.
   *
   * Decides direction from `originUrl`'s protocol:
   *   - HTTPS origin → on credential-shaped failure, retry as SSH
   *   - SSH   origin → on credential-shaped failure, retry as HTTPS
   * The fallback fires only when **all** hold:
   *   1. The first attempt failed with a credential-shaped error in the
   *      direction-appropriate sense (`isLikelyHttpsAuthFailure` /
   *      `isLikelySshAuthFailure`). Network failures, missing-ref errors,
   *      and TLS/host-key surprises propagate as-is — those won't be cured
   *      by switching transports and silently retrying would mask real bugs.
   *   2. The origin URL maps to a usable peer-protocol form
   *      (see `httpsToSshBaseRewrite` / `sshToHttpsBaseRewrite`). Custom
   *      ports beyond the protocol default disable the rewrite — there's no
   *      universal mapping between `https://host:8443` and an SSH peer.
   *
   * Implementation: the retry uses `git -c url.<peer-base>.insteadOf=<origin-base>`
   * — git resolves origin's URL through that rewrite for the duration of
   * one subprocess and never persists anything to disk. The mirror's
   * `remote.origin.url` stays as configured, so the next fetch starts back
   * at the original protocol unless this fallback fires again.
   */
  /**
   * `remote set-head --auto` is a remote-talking op too — under the same
   * credential rules as `fetch`. If we don't apply the same fallback,
   * mirrors whose HTTPS creds are missing end up with `refs/remotes/origin/HEAD`
   * unset, which then breaks `resolveBase()` for callers without an explicit
   * `ref` (the default-branch lookup throws).
   *
   * Strategy mirrors `fetchOrigin`: try the configured protocol first, fall
   * back to the peer protocol once via `-c url.<peer>.insteadOf=<origin>`.
   * Returns true on either success, false if both attempts failed (which
   * mirrors the historical `gitOk` semantics — non-fatal). No `GitMirrorAuthError`
   * here: callers that need origin/HEAD already get a clear
   * `GitMirrorError("Cannot resolve default branch …")` if both attempts fail.
   */
  async function setHeadAuto(mirrorPath: string, originUrl: string): Promise<boolean> {
    if (await gitOk(["remote", "set-head", "origin", "--auto"], mirrorPath, 30_000)) return true;
    const direction = pickFallbackDirection(originUrl);
    if (!direction) return false;
    return await gitOk(
      ["-c", `url.${direction.peerBase}.insteadOf=${direction.originBase}`, "remote", "set-head", "origin", "--auto"],
      mirrorPath,
      30_000,
    );
  }

  async function readOriginUrl(mirrorPath: string): Promise<string | null> {
    try {
      const { stdout } = await git(["config", "--get", "remote.origin.url"], mirrorPath, 10_000);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async function fetchOrigin(
    mirrorPath: string,
    originUrl: string,
  ): Promise<{ elapsedMs: number; usedFallback: boolean }> {
    const direction = pickFallbackDirection(originUrl);
    try {
      const { elapsedMs } = await git(["fetch", "--prune", "origin"], mirrorPath, cloneTimeoutMs);
      return { elapsedMs, usedFallback: false };
    } catch (primaryErr) {
      const primaryMessage = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      if (!direction || !direction.shouldRetry(primaryMessage)) {
        throw primaryErr;
      }
      log?.info(
        {
          gitUrl: originUrl,
          fromProtocol: direction.fromProtocol,
          toProtocol: direction.toProtocol,
          peerBase: direction.peerBase,
        },
        "fetch failed with credential-shaped error; retrying with peer-protocol insteadOf rewrite",
      );
      try {
        const { elapsedMs } = await git(
          ["-c", `url.${direction.peerBase}.insteadOf=${direction.originBase}`, "fetch", "--prune", "origin"],
          mirrorPath,
          cloneTimeoutMs,
        );
        log?.info({ gitUrl: originUrl, toProtocol: direction.toProtocol }, "protocol-fallback fetch succeeded");
        return { elapsedMs, usedFallback: true };
      } catch (peerErr) {
        const peerMessage = peerErr instanceof Error ? peerErr.message : String(peerErr);
        throw new GitMirrorAuthError(
          `Could not fetch ${originUrl} over ${direction.fromProtocol.toUpperCase()} or ${direction.toProtocol.toUpperCase()}. ` +
            `${direction.fromProtocol.toUpperCase()} attempt failed: ${truncate(primaryMessage)} ` +
            `${direction.toProtocol.toUpperCase()} retry (${direction.peerBase}) failed: ${truncate(peerMessage)}`,
        );
      }
    }
  }

  /**
   * Bring the mirror's config to the invariant expected by this module:
   * fetch refspec = `+refs/heads/*:refs/remotes/origin/*`, `remote.origin.mirror`
   * absent, `refs/remotes/origin/HEAD` resolvable.
   *
   * Called from `ensureMirror` on every invocation — both the fresh-clone path
   * (ensures our own bootstrap wrote the right values) and the pre-existing
   * mirror path (repairs drift from the legacy `--mirror` config).
   */
  async function assertMirrorConfig(mirrorPath: string, url: string): Promise<{ migrated: boolean }> {
    let migrated = false;

    // Read current fetch spec. `--get-all` returns every value on its own line;
    // empty stdout means the key is absent.
    let currentFetch = "";
    try {
      const { stdout } = await git(["config", "--get-all", "remote.origin.fetch"], mirrorPath, 10_000);
      currentFetch = stdout.trim();
    } catch {
      currentFetch = "";
    }

    if (currentFetch !== FETCH_REFSPEC) {
      // Replace whatever is there with exactly our refspec.
      await git(["config", "--replace-all", "remote.origin.fetch", FETCH_REFSPEC], mirrorPath, 10_000);
      migrated = true;
    }

    // `mirror = true` forces every fetch to prune & force-update every ref —
    // must be unset for our refspec to behave as intended.
    const mirrorFlag = await gitOk(["config", "--get", "remote.origin.mirror"], mirrorPath, 10_000);
    if (mirrorFlag) {
      await git(["config", "--unset-all", "remote.origin.mirror"], mirrorPath, 10_000);
      migrated = true;
    }

    // Ensure origin URL matches (a mismatched URL would make migration silently
    // pick up from the wrong upstream — refuse).
    try {
      const { stdout } = await git(["config", "--get", "remote.origin.url"], mirrorPath, 10_000);
      const currentUrl = stdout.trim();
      if (currentUrl !== url) {
        await git(["config", "--replace-all", "remote.origin.url", url], mirrorPath, 10_000);
        migrated = true;
      }
    } catch {
      await git(["remote", "add", "origin", url], mirrorPath, 10_000);
      migrated = true;
    }

    if (migrated) {
      // Populate `refs/remotes/origin/*` and set `origin/HEAD`. Without this,
      // newly-migrated mirrors have no remote-tracking refs to base worktrees on.
      await fetchOrigin(mirrorPath, url);
      await setHeadAuto(mirrorPath, url);
      log?.info({ gitUrl: url }, "mirror config migrated");
    }

    return { migrated };
  }

  /**
   * Bootstrap a fresh mirror at `mirrorPath`. Uses `git init --bare` +
   * manual remote setup rather than `git clone --mirror` / `git clone --bare`,
   * so we never transiently have the mirror configured to force-write
   * `refs/heads/*` on fetch.
   */
  async function bootstrapMirror(mirrorPath: string, url: string): Promise<void> {
    mkdirSync(dirname(mirrorPath), { recursive: true });
    await git(["init", "--bare", mirrorPath], null, cloneTimeoutMs);
    await git(["remote", "add", "origin", url], mirrorPath, 10_000);
    await git(["config", "--replace-all", "remote.origin.fetch", FETCH_REFSPEC], mirrorPath, 10_000);
    await fetchOrigin(mirrorPath, url);
    await setHeadAuto(mirrorPath, url);
  }

  async function branchExists(mirrorPath: string, branchName: string): Promise<boolean> {
    return await gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], mirrorPath, 10_000);
  }

  /**
   * Resolve the commit-ish to base a new session branch on.
   *
   * - explicit SHA → use as-is
   * - explicit branch name → prefer `refs/remotes/origin/<ref>`, fall back to
   *   a literal SHA resolution in case the caller handed us a short commit
   * - `ref` absent → `refs/remotes/origin/HEAD`
   */
  async function resolveBase(mirrorPath: string, ref: string | undefined): Promise<string> {
    if (!ref) {
      if (await gitOk(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD"], mirrorPath, 10_000)) {
        return "refs/remotes/origin/HEAD";
      }
      // Self-heal: mirrors created before the bidirectional-fallback fix may
      // have had `set-head --auto` run over a broken protocol and skipped
      // silently, leaving origin/HEAD unset. Try once now via the same
      // fallback-aware path. No-op if it succeeds-then-fails-again.
      const url = await readOriginUrl(mirrorPath);
      if (url && (await setHeadAuto(mirrorPath, url))) {
        if (await gitOk(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD"], mirrorPath, 10_000)) {
          log?.info({ mirrorPath, gitUrl: url }, "origin/HEAD self-healed via setHeadAuto");
          return "refs/remotes/origin/HEAD";
        }
      }
      throw new GitMirrorError(
        "Cannot resolve default branch: refs/remotes/origin/HEAD is missing. Re-run with an explicit `ref`.",
      );
    }
    if (looksLikeCommitSha(ref)) {
      if (await gitOk(["cat-file", "-e", ref], mirrorPath, 10_000)) return ref;
    }
    const remoteRef = `refs/remotes/origin/${ref}`;
    if (await gitOk(["rev-parse", "--verify", "--quiet", remoteRef], mirrorPath, 10_000)) {
      return remoteRef;
    }
    // Last resort: let git resolve `ref` against whatever it can find (tags,
    // local heads, etc.). If this fails the error surfaces to the caller.
    return ref;
  }

  return {
    get mirrorsRoot() {
      return mirrorsRoot;
    },

    ensureMirror(url) {
      return withUrlLock(url, async () => {
        mkdirSync(mirrorsRoot, { recursive: true });
        const path = mirrorDir(url);
        if (existsSync(join(path, "HEAD"))) {
          const { migrated } = await assertMirrorConfig(path, url);
          if (migrated) {
            // migration fetched already; report elapsed as 0 to preserve the
            // existing "cloned === false => fast path" contract.
          }
          return { mirrorPath: path, elapsedMs: 0, cloned: false };
        }
        const start = Date.now();
        try {
          await bootstrapMirror(path, url);
          const elapsedMs = Date.now() - start;
          log?.debug({ gitUrl: url, elapsedMs, cloned: true }, "mirror ensured");
          return { mirrorPath: path, elapsedMs, cloned: true };
        } catch (err) {
          if (err instanceof GitMirrorTimeoutError) {
            log?.warn({ gitUrl: url, timeoutMs: cloneTimeoutMs, elapsedMs: cloneTimeoutMs }, "mirror clone timeout");
          }
          if (existsSync(path)) rmSync(path, { recursive: true, force: true });
          throw err;
        }
      });
    },

    fetchMirror(url) {
      return withUrlLock(url, async () => {
        const path = mirrorDir(url);
        if (!existsSync(join(path, "HEAD"))) {
          throw new GitMirrorError(`Cannot fetch — no mirror exists for "${url}"`);
        }
        try {
          const { elapsedMs } = await fetchOrigin(path, url);
          return { elapsedMs };
        } catch (err) {
          log?.warn(
            {
              gitUrl: url,
              errorCode:
                err instanceof GitMirrorAuthError
                  ? "auth-failed"
                  : err instanceof GitMirrorTimeoutError
                    ? "timeout"
                    : err instanceof GitMirrorError
                      ? "git-failed"
                      : "unknown",
              stderr: err instanceof Error ? err.message.slice(0, 1024) : String(err).slice(0, 1024),
            },
            "mirror fetch failed",
          );
          throw err;
        }
      });
    },

    createWorktree({ url, ref, targetPath, sessionKey }) {
      return withUrlLock(url, async () => {
        const mirror = mirrorDir(url);
        if (!existsSync(join(mirror, "HEAD"))) {
          throw new GitMirrorError(`Cannot create worktree — no mirror exists for "${url}"`);
        }
        const absTarget = resolve(targetPath);
        const branchName = deriveSessionBranchName(sessionKey, url);

        // D13: target path must be free OR a Hub-managed worktree we can reuse.
        if (existsSync(absTarget) && !isHubManagedWorktree(absTarget)) {
          log?.warn(
            {
              gitUrl: url,
              targetPath: absTarget,
              occupantKind: classifyOccupant(absTarget),
            },
            "worktree create conflict",
          );
          throw new GitMirrorWorktreeConflictError(
            `Worktree target "${absTarget}" is already occupied by ${classifyOccupant(absTarget)} — aborting (D13)`,
          );
        }

        const pathExists = existsSync(absTarget);
        const hasBranch = await branchExists(mirror, branchName);

        mkdirSync(dirname(absTarget), { recursive: true });

        // Crash-recovery matrix (see refactor plan §5.3):
        //   path + branch    → reuse (short-circuit here even though callers also
        //                       short-circuit; defensive, cheap)
        //   !path + !branch  → `worktree add -b <branch> <path> <base>`
        //   !path + branch   → `worktree add <path> <branch>` (attach existing)
        //   path + !branch   → corruption; refuse rather than guess
        if (pathExists && hasBranch) {
          // Already wired up — treat as successful reuse.
        } else if (pathExists && !hasBranch) {
          throw new GitMirrorError(
            `Worktree directory "${absTarget}" exists as a Hub worktree but the expected session branch "${branchName}" is missing in the mirror — manual cleanup required`,
          );
        } else if (!pathExists && hasBranch) {
          await git(["worktree", "add", absTarget, branchName], mirror, cloneTimeoutMs);
        } else {
          const base = await resolveBase(mirror, ref);
          await git(["worktree", "add", "-b", branchName, absTarget, base], mirror, cloneTimeoutMs);
        }

        const head = await git(["rev-parse", "HEAD"], absTarget, 30_000);
        return { worktreePath: absTarget, headCommit: head.stdout.trim(), branchName };
      });
    },

    removeWorktree({ url, path, branchName }) {
      return withUrlLock(url, async () => {
        const absTarget = resolve(path);
        const mirror = mirrorDir(url);
        if (!isBareRepo(mirror)) {
          // Mirror was already GC'd; just rm the orphan dir if it exists.
          if (existsSync(absTarget)) rmSync(absTarget, { recursive: true, force: true });
          return;
        }
        if (existsSync(absTarget)) {
          await gitOk(["worktree", "remove", "--force", absTarget], mirror, 30_000);
        } else {
          // Path is already gone — let git prune its bookkeeping so later
          // worktree-add calls don't hit the stale admin record.
          await gitOk(["worktree", "prune"], mirror, 30_000);
        }
        if (existsSync(absTarget)) {
          // Worktree wasn't git-registered (orphan dir) — rm for tidiness.
          rmSync(absTarget, { recursive: true, force: true });
        }
        if (await branchExists(mirror, branchName)) {
          await gitOk(["branch", "-D", branchName], mirror, 10_000);
        }
      });
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

/**
 * Thrown when both the HTTPS fetch and the SSH fallback fail. The message
 * carries trimmed stderr from both attempts so the operator can see whether
 * the host's HTTPS credentials are missing, the SSH key is missing, or both.
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
 * Negative space (intentionally NOT matched): network errors
 * (`Could not resolve host`, `connection refused`), repo errors
 * (`Repository not found`, `couldn't find remote ref`), TLS errors
 * (`SSL certificate problem`). Those won't be cured by switching transports
 * and silently retrying would mask the real bug.
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
 * Heuristic for SSH-side credential failures (no key on disk, key not
 * accepted by remote, agent has nothing usable, host key mismatch).
 *
 * Negative space (intentionally NOT matched): SSH-level network errors
 * (`Could not resolve hostname`, `Connection refused`, `Connection timed out`).
 * Those are network reachability issues — switching to HTTPS won't help
 * unless the network policy specifically blocks port 22, which is rare
 * enough that we'd rather surface the original error than guess.
 *
 * Exported for unit testing.
 */
export function isLikelySshAuthFailure(message: string): boolean {
  if (!message) return false;
  // `Permission denied (<method-list>)` covers publickey-only rejects,
  // mixed-method rejects (e.g. `publickey,password`), and gssapi-with-mic;
  // `Permission denied, please try again.` covers the password-prompt
  // rejection path. We collapse them into one disjunction since both
  // forms only occur in ssh auth failure context.
  return (
    /Permission denied\s*(?:\(|,)/i.test(message) ||
    /Could not read from remote repository/i.test(message) ||
    /Host key verification failed/i.test(message) ||
    /no matching host key type/i.test(message) ||
    /no mutual signature algorithm/i.test(message)
  );
}

/**
 * Back-compat alias — matches *either* HTTPS or SSH credential failures.
 * Internal callers prefer the direction-specific predicates so a misfired
 * fallback doesn't classify an SSH host-key failure as an "HTTPS auth"
 * problem (or vice versa). This union form is kept for ad-hoc use sites.
 */
export function isLikelyAuthFailure(message: string): boolean {
  return isLikelyHttpsAuthFailure(message) || isLikelySshAuthFailure(message);
}

/**
 * Map an HTTPS git URL to the `insteadOf` rewrite needed to make git resolve
 * it through SSH. Returns *base* strings (suitable for
 * `git -c url.<sshBase>.insteadOf=<httpsBase>`) — git's `insteadOf` is a
 * prefix match, so we only need the host segment.
 *
 *   `https://github.com/owner/repo.git` → `git@github.com:` / `https://github.com/`
 *
 * Returns `null` for inputs that should NOT trigger fallback:
 *   - non-HTTPS URLs (already SSH, `git://`, `file://`, etc.)
 *   - URLs with embedded credentials (schema rejects these on input;
 *     belt-and-braces — never silently downgrade auth strength)
 *   - HTTPS URLs with a non-default port — there is no portable mapping to
 *     an SSH port (HTTPS:8443 ↔ SSH:???), so we refuse to guess
 *   - URLs that fail to parse
 *
 * Exported for unit testing.
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
  // Reject non-default HTTPS ports — see docstring.
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
 *   `git@github.com:owner/repo.git`           → `git@github.com:` / `https://github.com/`
 *   `ssh://git@github.com/owner/repo.git`     → `ssh://git@github.com/` / `https://github.com/`
 *   `ssh://git@gitlab.example.com:22/x/y.git` → `ssh://git@gitlab.example.com:22/` / `https://gitlab.example.com/`
 *
 * Returns `null` when:
 *   - URL is not SSH-shaped
 *   - URL has an embedded password (`user:pass@`)
 *   - SSH URL has a non-default port (≠ 22) — no portable mapping to HTTPS
 *
 * Exported for unit testing.
 */
export function sshToHttpsBaseRewrite(url: string): { sshBase: string; httpsBase: string } | null {
  if (!url) return null;
  // scp-like: `[user@]host:path` (no `://`). Mirrors `SCP_LIKE_SSH_RE` in
  // the shared schema — path forbids leading `/`, any `:` or `@` (so inputs
  // like `git:secret@github.com:owner/repo.git`, which superficially fit a
  // greedy first-colon split, are rejected).
  if (!url.includes("://")) {
    const m = url.match(/^((?:[A-Za-z0-9_.-]+@)?)([A-Za-z0-9.-]+):([^/@:\s][^@:\s]*)$/);
    const userAt = m?.[1];
    const host = m?.[2];
    const path = m?.[3];
    if (userAt === undefined || !host || !path) return null;
    // Path that is purely digits (optionally followed by `/` or end) means
    // git would parse it as `host:port` via ssh:// — refuse the ambiguous
    // case rather than fabricate a base.
    if (/^\d+(?:\/|$)/.test(path)) return null;
    return {
      sshBase: `${userAt}${host}:`,
      httpsBase: `https://${host}/`,
    };
  }
  // ssh:// form
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
  // The on-config origin URL contains either `ssh://user@host/...` or
  // `ssh://user@host:22/...` — match whichever the input actually used so
  // git's prefix matcher hits.
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
  /** The base prefix git will see in the on-disk `remote.origin.url`. */
  originBase: string;
  /** The base prefix to rewrite to (the peer-protocol form). */
  peerBase: string;
  /** Direction-specific failure classifier. */
  shouldRetry(stderr: string): boolean;
};

/**
 * Same shape as `SCP_LIKE_SSH_RE` in the shared schema — kept in sync so
 * what the schema accepts is exactly what we route through the SSH-side
 * fallback. Single source of truth would be ideal, but cross-package import
 * for a regex isn't worth the build coupling.
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
