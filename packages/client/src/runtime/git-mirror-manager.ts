import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { pino } from "../observability/logger.js";
import { getChildProcessRegistry } from "./child-process-registry.js";
import { isUnderManagedRoot, killProcessesHoldingPath } from "./worktree-cleanup.js";

const DEFAULT_CLONE_TIMEOUT_MS = 5 * 60 * 1000;

const FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
const SESSION_BRANCH_PREFIX = "hub-session";

/**
 * Backoff schedule for retrying a remote-talking git op (`fetch`,
 * `remote set-head --auto`) on a transient network-layer failure. Each entry
 * is the wait BEFORE the next attempt, so this lays out 4 attempts total
 * (1 initial + 3 retries) with a worst-case sleep budget of ~5s **per
 * protocol attempt**.
 *
 * Per-call totals depend on whether the helper chains a primary + fallback:
 *   - `fetchOrigin` ≤ 5s sleep budget: the SSH fallback only fires when
 *     the primary's terminal failure is credential-shaped, which a transient
 *     stderr will never be. So a transient-only failure burns ~5s.
 *   - `setHeadAuto` ≤ 10s sleep budget: the fallback fires on ANY terminal
 *     primary failure, so a doubly-transient run burns ~5s + ~5s ≈ 10s.
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
  /**
   * Paths under which Hub owns the directory tree end-to-end (typically
   * `<dataDir>/workspaces`). When a worktree target sits inside one of these
   * roots and a stale non-managed leftover is found at session start, the
   * manager auto-recovers — kill any process still holding the path, `rm -rf`
   * the leftover, then proceed with the normal `git worktree add` flow.
   *
   * Targets OUTSIDE every managed root still fail loud with D13: those are
   * operator-supplied paths and we refuse to silently delete user data.
   *
   * Omit to disable self-healing (current D13-always-throws behaviour). The
   * production runtimes always pass the workspaces root; tests opt in
   * explicitly to exercise the recovery path.
   */
  hubManagedRoots?: readonly string[];
};

export interface GitMirrorManager {
  ensureMirror(url: string): Promise<{ mirrorPath: string; elapsedMs: number; cloned: boolean }>;
  fetchMirror(url: string): Promise<{ elapsedMs: number }>;
  createWorktree(args: {
    url: string;
    ref?: string;
    targetPath: string;
    sessionKey: string;
    /**
     * Identifier for the agent owning this worktree. Required so the derived
     * branch name does not collide with peer agents in the same chat — see
     * `deriveSessionBranchName` docblock.
     */
    agentName: string;
  }): Promise<{ worktreePath: string; headCommit: string; branchName: string }>;
  removeWorktree(args: { url: string; path: string; branchName: string }): Promise<void>;
  gcMirrors(stillReferencedUrls: Set<string>): Promise<{ removed: string[] }>;
  /**
   * Sweep `hub-session-*` branch refs (and their `[branch "..."]` config
   * segments) that no live worktree holds across every mirror.
   *
   * Intra-process safety: callers must invoke this when no slot is mid-way
   * through `createWorktree` on the same runtime — i.e. at runtime boot,
   * before any slot starts. No `withUrlLock` is taken; the caller's timing
   * is the guarantee.
   *
   * Cross-process caveat: a peer hub client (rare — happens during in-place
   * upgrades or when an old install still runs in parallel) creating a
   * worktree in its own `add` sequence has a microsecond window where the
   * branch ref exists but its worktree admin record doesn't yet. If our
   * scan lands in that window, we may delete a branch the peer is about to
   * attach. The peer's next step then fails with "no such ref" (visible in
   * their stderr), so the operator notices — but the failure is theirs, not
   * data loss on our side. Not worth a cross-process lock for that window.
   */
  gcOrphanSessionBranches(): Promise<{ scanned: number; deleted: number; failed: number }>;
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

/**
 * Branch name a session's worktree attaches to. The hash inputs include the
 * agent dimension because `(chat, url)` alone is not unique: two agents that
 * share a chat each open their own worktree at
 * `<workspaces>/<agent>/<chatId>/...`, and git refuses to point two worktrees
 * at the same branch (`fatal: '<branch>' is already used by worktree at …`).
 * Hash inputs are joined with `:` so `(chatA, agentB)` cannot collide with
 * `(chatAB, "")`.
 *
 * The caller picks `agentName`. Prefer the operator-stable name
 * (`config.yaml::agents.<name>`); fall back to `agent.agentId` (a UUID,
 * globally unique) when the stable name isn't available. Anything stable
 * across `start` and `resume` for the same `(agent, chat)` pair will do —
 * the contract is "no collision with a peer agent in the same chat", not
 * "human-readable in the branch name".
 *
 * See docs/workspace-session-branch-collision-fix-design.md §3.2.
 */
export function deriveSessionBranchName(sessionKey: string, agentName: string, url: string): string {
  return `${SESSION_BRANCH_PREFIX}-${shortHash(`${sessionKey}:${agentName}`)}-${shortHash(url)}`;
}

/**
 * A value is SHA-like when it's a 7–40 character hex string. Used to decide
 * whether `ref` should be resolved via the remote namespace (branch name) or
 * used as-is (commit hash).
 */
function looksLikeCommitSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

/**
 * Identifies the cross-process `<gitdir>/config.lock` contention that
 * `git worktree add -b` surfaces as exit code 255 with stderr containing
 * `error: could not lock config file …`. Triggered when a peer git process
 * (e.g. a second hub client running an old install in parallel) is mid-way
 * through writing the same shared bare mirror's `config`. Safe to retry —
 * see the createWorktree retry loop for the recovery argument.
 */
export function isConfigLockError(err: unknown): boolean {
  if (!(err instanceof GitMirrorError)) return false;
  return /could not lock config file/i.test(err.message);
}

export function createGitMirrorManager(opts: GitMirrorManagerOptions): GitMirrorManager {
  const mirrorsRoot = join(opts.dataDir, "git-mirrors");
  const cloneTimeoutMs =
    opts.cloneTimeoutMs ?? Number(process.env.FIRST_TREE_GIT_CLONE_TIMEOUT_MS ?? DEFAULT_CLONE_TIMEOUT_MS);
  const log = opts.log;
  const resolvedDataDir = resolve(opts.dataDir);
  const hubManagedRoots = (opts.hubManagedRoots ?? []).map((p) => resolve(p));
  // Fail loud at construction if any managed root would let the self-heal
  // branch escape `<dataDir>`. Without this guard a misconfigured caller
  // (`hubManagedRoots: ["/"]`, `[os.homedir()]`, etc.) would weaponise the
  // `createWorktree` rm -rf path against arbitrary host paths. Strict subdir:
  // the root itself MUST sit inside `dataDir` and MUST NOT equal `dataDir`
  // (so we never grant "the whole hub data dir is fair game").
  //
  // Aggregate every bad root into one error so an operator who misconfigured
  // multiple entries sees the whole picture on their first startup attempt
  // instead of grinding through one-fix-then-restart cycles.
  const badRoots = hubManagedRoots.filter((root) => !isUnderManagedRoot(root, [resolvedDataDir]));
  if (badRoots.length > 0) {
    throw new GitMirrorError(
      `hubManagedRoots contains ${badRoots.length} entr${badRoots.length === 1 ? "y" : "ies"} not strictly inside dataDir "${resolvedDataDir}" — refusing to construct manager (would let self-heal rm -rf escape the hub data dir): ${badRoots.map((p) => `"${p}"`).join(", ")}`,
    );
  }

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
    // Force `LC_ALL=C` so git/ssh stderr stays in English regardless of the
    // caller's locale — the credential-shape and transient-network heuristics
    // below match against stderr substrings, and a localized message would
    // silently break classification (and the protocol-fallback decision that
    // hangs off it). Placed after the spread so it overrides any inherited
    // LC_ALL from `process.env`; `GIT_TERMINAL_PROMPT` stays before the spread
    // so tests can opt back into prompting if they need to.
    const baseEnv = env ?? process.env;
    const finalEnv = { GIT_TERMINAL_PROMPT: "0", ...baseEnv, LC_ALL: "C" };
    return await new Promise<{ stdout: string; stderr: string; elapsedMs: number }>((resolveExec, rejectExec) => {
      // Bug 3 fix: track every git subprocess in the ChildProcessRegistry so
      // the lifecycle shutdown hook can kill stragglers if systemd SIGTERMs
      // us mid-fetch. The existing per-call setTimeout below still owns the
      // operation timeout; the registry provides a global cleanup tracker.
      const { child: proc } = getChildProcessRegistry().spawn("git", args, {
        category: "git",
        label: `git ${args.join(" ").slice(0, 120)}`,
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
  /**
   * Worst-case sleep budget: ~10s (primary ~5s + fallback ~5s). Unlike
   * `fetchOrigin`, which gates fallback on a credential-shaped terminal
   * error, `setHeadAuto` always falls through on any primary failure, so
   * a doubly-transient run pays both retry budgets. Per-call 30s timeout
   * still caps each individual git invocation.
   */
  async function setHeadAuto(mirrorPath: string, originUrl: string): Promise<boolean> {
    try {
      await gitWithNetworkRetry(["remote", "set-head", "origin", "--auto"], mirrorPath, 30_000, "set-head:primary");
      return true;
    } catch {
      // Primary attempt failed terminally (after any transient retries). Fall
      // through to the SSH-side rewrite — same fallback rules as fetchOrigin.
    }
    const direction = pickFallbackDirection(originUrl);
    if (!direction) return false;
    try {
      await gitWithNetworkRetry(
        ["-c", `url.${direction.peerBase}.insteadOf=${direction.originBase}`, "remote", "set-head", "origin", "--auto"],
        mirrorPath,
        30_000,
        "set-head:fallback",
      );
      return true;
    } catch {
      return false;
    }
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
      const { elapsedMs } = await gitWithNetworkRetry(
        ["fetch", "--prune", "origin"],
        mirrorPath,
        cloneTimeoutMs,
        "fetch:primary",
      );
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
        const { elapsedMs } = await gitWithNetworkRetry(
          ["-c", `url.${direction.peerBase}.insteadOf=${direction.originBase}`, "fetch", "--prune", "origin"],
          mirrorPath,
          cloneTimeoutMs,
          "fetch:fallback",
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

    createWorktree({ url, ref, targetPath, sessionKey, agentName }) {
      return withUrlLock(url, async () => {
        const mirror = mirrorDir(url);
        if (!existsSync(join(mirror, "HEAD"))) {
          throw new GitMirrorError(`Cannot create worktree — no mirror exists for "${url}"`);
        }
        const absTarget = resolve(targetPath);
        const branchName = deriveSessionBranchName(sessionKey, agentName, url);

        // D13: target path must be free OR a Hub-managed worktree we can reuse.
        // Self-heal exception: when the path sits inside a hub-managed root the
        // leftover is almost always an orphaned dev-server cache (vite/.vite,
        // node_modules/.cache, etc) re-written by a daemonised child that
        // outlived the previous session — see worktree-cleanup.ts header for
        // the full incident. Kill any process still holding it, rm -rf, and
        // fall through to the normal `git worktree add` path.
        if (existsSync(absTarget) && !isHubManagedWorktree(absTarget)) {
          const occupantKind = classifyOccupant(absTarget);
          if (hubManagedRoots.length > 0 && isUnderManagedRoot(absTarget, hubManagedRoots)) {
            log?.warn(
              {
                gitUrl: url,
                targetPath: absTarget,
                occupantKind,
                hubManagedRoots,
              },
              "worktree target occupied inside hub-managed root — auto-recovering (kill holders + rm -rf)",
            );
            await killProcessesHoldingPath(absTarget, log);
            try {
              rmSync(absTarget, { recursive: true, force: true });
            } catch (err) {
              throw new GitMirrorWorktreeConflictError(
                `Worktree target "${absTarget}" cleanup failed after killing holders: ${
                  err instanceof Error ? err.message : String(err)
                } (D13)`,
              );
            }
            if (existsSync(absTarget)) {
              throw new GitMirrorWorktreeConflictError(
                `Worktree target "${absTarget}" still occupied after auto-recovery — aborting (D13)`,
              );
            }
          } else {
            log?.warn(
              {
                gitUrl: url,
                targetPath: absTarget,
                occupantKind,
              },
              "worktree create conflict",
            );
            throw new GitMirrorWorktreeConflictError(
              `Worktree target "${absTarget}" is already occupied by ${occupantKind} — aborting (D13)`,
            );
          }
        }

        // Crash-recovery matrix + cross-process race recovery, wrapped in a
        // retry loop. `withUrlLock` already serialises everything in *this*
        // process, but the shared bare mirror has no inter-process lock —
        // a second hub client (rare, but happens during in-place upgrades or
        // when an old install hasn't been uninstalled) can still race on
        // `<gitdir>/config.lock` while writing upstream tracking, which makes
        // `worktree add -b` exit 255 with `could not lock config file`.
        //
        // A config-lock failure happens in git's `setup_tracking` step, which
        // runs AFTER the branch ref + worktree admin record + path dir are
        // created. So the failure leaves the repo in either `path + hasBranch`
        // or `!path + hasBranch` depending on exactly which sub-step lost the
        // race — but the matrix below handles both: reuse (short-circuit) or
        // attach-existing (`worktree add <path> <branch>`, no `-b`), neither
        // of which writes upstream config, so retry cannot re-collide.
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          // Pre-add cleanup: when a previous owner of `absTarget` crashed or
          // the directory was wiped externally, the bare mirror retains a
          // "prunable" worktree admin record. A subsequent `git worktree add`
          // against the same path then fails with
          //   `fatal: '<path>' is a missing but already registered worktree`.
          // `prune` is idempotent and safe — it only removes records whose
          // backing directory no longer exists. Live worktrees that we own
          // (e.g. the same agent's other chats) are untouched.
          await gitOk(["worktree", "prune"], mirror, 10_000);

          const pathExists = existsSync(absTarget);
          const hasBranch = await branchExists(mirror, branchName);

          mkdirSync(dirname(absTarget), { recursive: true });

          // Crash-recovery matrix (see refactor plan §5.3):
          //   path + branch    → reuse (short-circuit here even though callers also
          //                       short-circuit; defensive, cheap)
          //   !path + !branch  → `worktree add -b <branch> <path> <base>`
          //   !path + branch   → `worktree add <path> <branch>` (attach existing)
          //   path + !branch   → corruption; refuse rather than guess
          try {
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
            break;
          } catch (err) {
            if (attempt < maxAttempts && isConfigLockError(err)) {
              const delayMs = 50 * 2 ** (attempt - 1) + Math.floor(Math.random() * 50);
              log?.warn(
                { gitUrl: url, branchName, attempt, delayMs },
                "worktree add hit config lock contention — retrying",
              );
              await new Promise((r) => setTimeout(r, delayMs));
              continue;
            }
            throw err;
          }
        }

        const head = await git(["rev-parse", "HEAD"], absTarget, 30_000);
        return { worktreePath: absTarget, headCommit: head.stdout.trim(), branchName };
      });
    },

    removeWorktree({ url, path, branchName }) {
      return withUrlLock(url, async () => {
        const absTarget = resolve(path);
        const mirror = mirrorDir(url);
        // Kill any daemonised child the previous session left behind (vite,
        // esbuild, test watcher, ...) BEFORE we try to rmdir. Without this the
        // child keeps writing under `absTarget`, which both makes
        // `git worktree remove` flaky AND repopulates the directory between
        // the rm and the next session's `worktree add` — exactly the D13
        // failure mode this commit fixes. Gated by `hubManagedRoots` so we
        // never signal processes whose cwd happens to be an operator path.
        if (hubManagedRoots.length > 0 && isUnderManagedRoot(absTarget, hubManagedRoots) && existsSync(absTarget)) {
          await killProcessesHoldingPath(absTarget, log);
        }
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
          const ok = await gitOk(["branch", "-D", branchName], mirror, 10_000);
          if (!ok) {
            // The `[branch "..."]` segment will linger in the shared bare
            // mirror's `config` until startup GC sweeps it. Surface it so the
            // operator can correlate with whatever held the branch (usually a
            // peer worktree git's still holding a lock, or a renamed branch).
            log?.warn(
              { gitUrl: url, branchName, mirror },
              "branch -D failed during removeWorktree — config segment will leak until next gcOrphanSessionBranches",
            );
          }
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

    async gcOrphanSessionBranches() {
      if (!existsSync(mirrorsRoot)) return { scanned: 0, deleted: 0, failed: 0 };
      let scanned = 0;
      let deleted = 0;
      let failed = 0;
      for (const entry of readdirSync(mirrorsRoot)) {
        const mirror = join(mirrorsRoot, entry);
        if (!isBareRepo(mirror)) continue;
        // Branches held by a live worktree — must NOT be deleted. `branch -D`
        // would refuse anyway, but skipping them avoids the noisy warn log.
        const held = new Set<string>();
        try {
          const list = await git(["worktree", "list", "--porcelain"], mirror, 10_000);
          for (const line of list.stdout.split("\n")) {
            const m = line.match(/^branch refs\/heads\/(.+)$/);
            if (m?.[1]) held.add(m[1]);
          }
        } catch (err) {
          log?.warn({ mirror: entry, err }, "gcOrphanSessionBranches: worktree list failed — skipping mirror");
          continue;
        }
        let sessionBranches: string[];
        try {
          const out = await git(
            ["for-each-ref", "--format=%(refname:short)", `refs/heads/${SESSION_BRANCH_PREFIX}-*`],
            mirror,
            10_000,
          );
          sessionBranches = out.stdout
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        } catch (err) {
          log?.warn({ mirror: entry, err }, "gcOrphanSessionBranches: branch listing failed — skipping mirror");
          continue;
        }
        for (const branch of sessionBranches) {
          scanned++;
          if (held.has(branch)) continue;
          const ok = await gitOk(["branch", "-D", branch], mirror, 10_000);
          if (ok) {
            deleted++;
          } else {
            failed++;
            log?.warn({ mirror: entry, branch }, "gcOrphanSessionBranches: branch -D failed");
          }
        }
      }
      if (deleted > 0 || failed > 0) {
        log?.info({ scanned, deleted, failed }, "gcOrphanSessionBranches: swept orphan session branches");
      }
      return { scanned, deleted, failed };
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
 * Negative space (intentionally NOT matched):
 *   - SSH-level network errors (`Could not resolve hostname`,
 *     `Connection refused`, `Connection timed out`). Those are reachability
 *     issues — switching to HTTPS won't help unless the network policy
 *     specifically blocks port 22, which is rare enough that we'd rather
 *     surface the original error than guess.
 *   - `fatal: Could not read from remote repository.` on its own. Git
 *     appends that line to *every* SSH transport failure regardless of
 *     cause (auth reject, timeout, DNS, refused, …), so it carries no
 *     classification signal — matching it would re-classify network errors
 *     as auth failures and trigger a noisy HTTPS retry that fails again on
 *     SSH-only hosts. The real auth fingerprints below (`Permission denied`,
 *     `Host key verification failed`, host-key/algorithm negotiation) are
 *     specific enough on their own.
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
 * Heuristic for transient network-layer failures emitted by `git` over
 * HTTPS or SSH. These are the failure modes a brief proxy/VPN hiccup, TLS
 * handshake blip, or peer connection reset produces mid-fetch — exactly
 * what `SSL_connect: SSL_ERROR_SYSCALL` looks like when Surge / Clash
 * swaps a rule mid-flight, what `early EOF` looks like when an HTTP/2
 * stream is reset, and what `Connection refused` looks like when a local
 * proxy listener restarts.
 *
 * Used by the `gitWithNetworkRetry` wrapper around `fetch` and
 * `remote set-head --auto` to absorb the kind of hiccup that today
 * surfaces as `Session start/resume failed (…)` in chat and only goes
 * away when the operator manually @-mentions the agent again two seconds
 * later.
 *
 * Negative space (intentionally NOT matched):
 *   - credential failures — handled by the protocol-fallback path; retrying
 *     in the same protocol won't help.
 *   - `Repository not found`, `couldn't find remote ref` — deterministic
 *     content errors; a 500ms retry won't fix them.
 *   - `SSL certificate problem` — TLS trust failures; retrying won't help
 *     and silently masking them would hide a real misconfiguration.
 *   - `git … timed out after Xms` — our own per-call timeout. The op was
 *     making progress (or wasn't); either way another full timeout window
 *     is the wrong response.
 *
 * On localhost-proxy specifically (the common case for this codebase),
 * `ECONNREFUSED` IS a transient signal — when Surge / Clash bounces the
 * listener, the next attempt sees the same listener back up within
 * seconds. This is why we diverge from the SDK's `doFetch` policy (which
 * does NOT retry `ECONNREFUSED` because there the peer is the remote hub).
 *
 * Exported for unit testing.
 */
export function isLikelyTransientNetworkError(message: string): boolean {
  if (!message) return false;
  // Don't shadow a credential failure: switching to SSH is the right move
  // for those, retrying the same protocol is not.
  if (isLikelyHttpsAuthFailure(message) || isLikelySshAuthFailure(message)) return false;
  // Don't shadow a TLS trust failure: those are deterministic misconfigurations
  // (custom intercepting cert chain, expired cert, missing CA bundle, …) that
  // a 5s retry budget won't fix. Burning the budget AND emitting transient-
  // warning log lines for a deterministic failure would also mislead operators
  // diagnosing a real cert problem. Matches both the user-friendly form
  // (`SSL certificate problem: …`) and the raw OpenSSL form
  // (`error:…:SSL routines::certificate verify failed`).
  if (
    /SSL certificate problem/i.test(message) ||
    /server certificate verification failed/i.test(message) ||
    /certificate verify failed/i.test(message) ||
    /self.signed certificate/i.test(message) ||
    /unable to get local issuer certificate/i.test(message) ||
    /certificate has expired/i.test(message)
  )
    return false;
  return (
    /SSL_ERROR_SYSCALL/i.test(message) ||
    // OpenSSL's transient "the peer closed mid-stream" signal. Matches the
    // raw form (`error:…:SSL routines::unexpected eof while reading`) emitted
    // when github.com's edge resets the TLS connection mid-fetch. Narrowly
    // scoped to the exact phrase to avoid re-introducing the broad
    // `SSL routines` match that swept up cert verify failures.
    /unexpected eof while reading/i.test(message) ||
    /TLS handshake|gnutls_handshake|gnutls\s+recv\s+error/i.test(message) ||
    /\bConnection reset(?:\s+by\s+peer)?\b/i.test(message) ||
    /\bConnection refused\b/i.test(message) ||
    /\bConnection timed out\b/i.test(message) ||
    /\bOperation timed out\b/i.test(message) ||
    /\bNetwork is unreachable\b/i.test(message) ||
    /Could not resolve host(?:name)?/i.test(message) ||
    /Temporary failure in name resolution/i.test(message) ||
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

/**
 * Run `op` once, and on a `isRetryable`-classified failure replay it on the
 * given backoff schedule. Non-retryable failures propagate to the caller
 * immediately — those won't be cured by waiting and silently retrying would
 * mask real bugs and exhaust the retry budget.
 *
 * Per-attempt timeouts (when `op` enforces one of its own) are NOT reset
 * across attempts: each attempt gets its own full budget. Right policy for
 * `git fetch` where a slow but progressing transfer on attempt N+1 should
 * not be aborted because attempt N ate part of a shared budget.
 *
 * Exported so unit tests can drive the retry policy with a mock `op`
 * instead of standing up a real flaky network. Module-scope so the helper
 * stays pure and side-effect-free.
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
      // `delaysMs.length === maxAttempts - 1`, so `attempt - 1` is in range
      // for every iteration that reaches this line. The explicit guard keeps
      // TS strict happy without resorting to a non-null assertion.
      const baseDelay = delaysMs[attempt - 1];
      if (baseDelay === undefined) throw err;
      const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseDelay / 4)));
      const delayMs = baseDelay + jitter;
      onRetry?.({ attempt, nextDelayMs: delayMs, message });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  // Unreachable — the loop always either returns or throws by `maxAttempts`.
  throw lastErr;
}
