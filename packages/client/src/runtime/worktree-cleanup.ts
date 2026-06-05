import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { relative, sep } from "node:path";
import type { pino } from "../observability/logger.js";

/**
 * Pre-cleanup helpers for worktree paths First Tree owns.
 *
 * Why this module exists: agent sessions often spawn dev servers (vite, esbuild,
 * test watchers) inside the worktree as background children. When First Tree tears the
 * worktree down those children outlive the agent process — daemonised, attached
 * to a different process group, or simply not tracked by the SDK. The orphan
 * keeps the cwd open, keeps writing cache files (`.vite/deps/...`,
 * `node_modules/.cache/...`) under the just-deleted directory, and on the next
 * session start the rebuilt path collides with the conflict guard in
 * `ensureSourceRepo` because there's a non-empty dir but no managed `.git` clone.
 *
 * Two consumers:
 *   - `removeSourceRepo` calls `killProcessesHoldingPath` BEFORE `rm -rf` of
 *     the clone so the rmdir actually sticks.
 *   - `ensureSourceRepo` calls `killProcessesHoldingPath` then `rmSync` when a
 *     non-managed leftover sits in a path under a First Tree-managed root — see the
 *     `hubManagedRoots` option on `GitMirrorManager`.
 *
 * Platform support: `lsof` is the universal way to enumerate file holders
 * on POSIX. We try a few well-known paths before falling back to PATH (macOS
 * launchd / systemd strip `/usr/sbin` from `Environment=PATH`). Windows ships
 * no equivalent; `resolveLsofBinary` returns `null` there and the helpers
 * become no-ops — the self-heal path then relies on `existsSync(absTarget)`
 * after the post-cleanup attempt to surface failure. Windows isn't in First Tree's
 * supported daemon matrix today; revisit if/when that changes.
 */

/** Generous upper bound on a single lsof run before we give up. */
const LSOF_TIMEOUT_MS = 5_000;
/** How long to wait between SIGTERM and SIGKILL on holdouts. */
const SIGTERM_GRACE_MS = 750;

/**
 * Candidate `lsof` binaries, tried in order. macOS ships lsof at
 * `/usr/sbin/lsof` which is on the interactive `PATH` (via `/etc/paths`) but
 * NOT in the minimal env launchd / our test harness hands to children. Linux
 * distros typically have it at `/usr/bin/lsof`. We fall back to the bare name
 * last so a wrapper installed via Homebrew etc. still wins when present.
 */
const LSOF_CANDIDATE_PATHS = ["/usr/sbin/lsof", "/usr/bin/lsof", "/sbin/lsof", "lsof"] as const;

function resolveLsofBinary(): string | null {
  for (const candidate of LSOF_CANDIDATE_PATHS) {
    if (candidate === "lsof") return "lsof"; // last-resort PATH lookup
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not present, try next
    }
  }
  return null;
}

/**
 * True when `target` is contained STRICTLY inside `root` after path
 * normalisation. The exact-match case (`target === root`) returns false on
 * purpose: a caller that passes the managed root itself as a worktree target
 * would otherwise let the self-heal branch `rm -rf` the entire
 * `<dataDir>/workspaces` tree. Worktree targets always sit at least two levels
 * deeper (`<agent>/<chatId>/<repo>`), so the exact-match path is never a
 * legitimate request — fail closed.
 */
export function isUnderManagedRoot(target: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    const rel = relative(root, target);
    if (rel === "") continue; // target === root: never auto-clean the root itself
    if (rel.startsWith("..")) continue;
    // `path.relative` returns OS-native separators; reject if it bottoms out
    // to an absolute path on the foreign side (relative across volumes on
    // Windows). First Tree data dirs never cross volumes on POSIX so this is just
    // belt-and-braces.
    if (rel.startsWith(sep)) continue;
    return true;
  }
  return false;
}

/**
 * Enumerate PIDs that hold any file open under `path` (including cwd, mmap'd
 * binaries, regular fds). Uses `lsof +D` which recurses into the directory
 * tree. Returns an empty list when:
 *   - the path doesn't exist
 *   - `lsof` exits non-zero or isn't on PATH
 *   - the timeout expires
 * Never throws — callers continue with the destructive op regardless.
 */
export async function findPidsHoldingPath(path: string, log?: pino.Logger): Promise<number[]> {
  if (!existsSync(path)) return [];
  const lsofBin = resolveLsofBinary();
  if (!lsofBin) {
    log?.debug({ path }, "no lsof binary found on disk — skipping holder scan");
    return [];
  }
  return await new Promise<number[]>((resolveExec) => {
    let stdout = "";
    let stderr = "";
    // `-w` suppresses lock-acquisition warnings on Linux; `-n -P` skip name/port
    // resolution so we don't time out on a slow DNS. `-F p` switches to the
    // field-prefixed parseable output (lines `pNNNN`). `+D` recurses AND
    // matches processes whose cwd is `path` (cwd is reported as fd type `cwd`
    // — see `lsof(8)` — which `+D` enumerates alongside open files); with the
    // self-pid excluded below the cost is bounded by the dir's filecount.
    const proc = spawn(lsofBin, ["-w", "-n", "-P", "-F", "p", "+D", path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const settle = (pids: number[]) => {
      if (settled) return;
      settled = true;
      resolveExec(pids);
    };
    proc.stdout.on("data", (d) => {
      stdout += String(d);
    });
    proc.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore — child already exited
      }
      log?.warn({ path, timeoutMs: LSOF_TIMEOUT_MS }, "lsof timed out while scanning worktree holders");
      settle([]);
    }, LSOF_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(timer);
      log?.debug({ path, err: String(err) }, "lsof spawn failed — assuming no holders");
      settle([]);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      // lsof exits 1 when its scan turned up no matching files — that's the
      // happy "nobody is holding it" path, not an error. Treat any unparseable
      // exit as "unknown, proceed without killing".
      if (code !== 0 && code !== 1) {
        log?.debug(
          { path, exitCode: code, stderr: stderr.slice(0, 256) },
          "lsof exited non-zero — assuming no holders",
        );
        settle([]);
        return;
      }
      const selfPid = process.pid;
      const pids = new Set<number>();
      for (const line of stdout.split("\n")) {
        const m = line.match(/^p(\d+)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        if (!Number.isFinite(pid) || pid <= 1) continue;
        if (pid === selfPid) continue;
        pids.add(pid);
      }
      settle([...pids]);
    });
  });
}

/**
 * Best-effort kill every process holding a file under `path`. Sends SIGTERM,
 * waits {@link SIGTERM_GRACE_MS}, then SIGKILLs any holdouts. Returns the PIDs
 * we asked the kernel to kill and any that we could not signal (typically
 * because they belong to another uid).
 *
 * Idempotent: a second call on the same path is cheap when no holders remain.
 * Never throws — caller decides what to do when `failedToKill` is non-empty.
 */
export async function killProcessesHoldingPath(
  path: string,
  log?: pino.Logger,
): Promise<{ killed: number[]; failedToKill: number[] }> {
  const pids = await findPidsHoldingPath(path, log);
  if (pids.length === 0) return { killed: [], failedToKill: [] };

  log?.warn({ path, pids }, "killing processes holding worktree path");

  const failedToKill: number[] = [];
  const termed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      termed.push(pid);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // process already gone — count as terminated so we still skip SIGKILL
        termed.push(pid);
      } else {
        log?.warn({ path, pid, err: String(err) }, "SIGTERM failed");
        failedToKill.push(pid);
      }
    }
  }

  if (termed.length === 0) {
    return { killed: [], failedToKill };
  }

  await new Promise((r) => setTimeout(r, SIGTERM_GRACE_MS));

  // Anything still alive gets SIGKILL. `kill(pid, 0)` is the standard liveness
  // probe — succeeds when the pid exists and we can signal it, throws ESRCH
  // otherwise.
  const killed: number[] = [];
  for (const pid of termed) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (!alive) {
      killed.push(pid);
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        killed.push(pid);
      } else {
        log?.warn({ path, pid, err: String(err) }, "SIGKILL failed");
        failedToKill.push(pid);
      }
    }
  }

  return { killed, failedToKill };
}
