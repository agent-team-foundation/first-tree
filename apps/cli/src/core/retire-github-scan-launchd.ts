import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Retire the stranded legacy `github-scan` launchd runner.
 *
 * The `github-scan` subsystem was removed after v1.0, but on machines that
 * ran an older build its launchd runner (label like
 * `com.first-tree.github-scan.runner.<user>.default`) was installed with
 * `KeepAlive: true` and a `ProgramArguments` path baked into the old npm
 * layout. After a CLI upgrade relocates/removes that binary, launchd hits
 * `MODULE_NOT_FOUND` and the service crash-loops indefinitely — and while it
 * loops it keeps binding the legacy default `httpPort` 7878, silently
 * squatting a port another local tool (tdoc) documents as its own.
 *
 * Nothing in the current upgrade path retires this service: the
 * `v1-orphan-skills` workspace migration sweeps retired skill *payloads*, but
 * the runner is a machine/user-level launchd job under the prod home, not a
 * workspace artifact. This sweep closes that gap.
 *
 * Strategy is enumerate-from-disk rather than reconstruct-the-label: the label
 * embeds the OS username (and a profile suffix), so we read each plist's
 * `Label` straight from the file instead of guessing it. Bootout is keyed on
 * the user GUI domain (`gui/<uid>`), matching how the legacy runner registered
 * itself. Everything is best-effort — a `bootout` against an already-evicted
 * label is a no-op, and we never throw out of here; daemon start must not be
 * blocked by cleanup of a dead subsystem.
 *
 * Scope is deliberately narrow: only `*.plist` files under
 * `<home>/github-scan/runner/launchd/` are touched (plus the now-empty dir).
 * The rest of `<home>/github-scan/` (config.yaml, logs) is left alone — a user
 * may have written a defensive config there, and inert files do not crash-loop.
 */
export type RetireGithubScanResult = {
  /** Labels successfully booted out or confirmed absent. */
  bootedOut: string[];
  /** Plist files removed from disk. */
  removedPlists: number;
};

const EMPTY_RESULT: RetireGithubScanResult = { bootedOut: [], removedPlists: 0 };
const ROOT_MIGRATION_BUDGET_MS = 1_000;
const RETRY_INTERVAL_MS = 6 * 60 * 60 * 1_000;
let rootMigrationAttempted = false;

function legacyHome(homeDir?: string): string {
  return homeDir ?? join(homedir(), ".first-tree");
}

function legacyLaunchdDir(homeDir?: string): string {
  return join(legacyHome(homeDir), "github-scan", "runner", "launchd");
}

/** Parse the `Label` value out of a launchd plist body, if present. */
function parsePlistLabel(plistBody: string): string | null {
  const match = plistBody.match(/<key>\s*Label\s*<\/key>\s*<string>([^<]+)<\/string>/);
  return match ? match[1].trim() : null;
}

/** `launchctl bootout gui/<uid>/<label>`, swallowing the benign not-loaded case. */
function bootoutLabel(uid: number, label: string, timeoutMs: number, log?: (msg: string) => void): boolean {
  const target = `gui/${uid}/${label}`;
  let res: ReturnType<typeof spawnSync>;
  try {
    res = spawnSync("launchctl", ["bootout", target], {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    if (log) log(`launchctl bootout ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (res.status === 0) return true;
  const stderr = String(res.stderr ?? "").trim();
  // A label that is not currently loaded is the expected happy path on a
  // machine where the zombie was already evicted (or never ran this boot).
  if (/not find|no such|not loaded/i.test(stderr)) return true;
  if (log) log(`launchctl bootout ${label}: ${stderr || `exit ${res.status ?? "unknown"}`}`);
  return false;
}

/**
 * Bootout + delete every legacy github-scan launchd plist found on disk.
 *
 * @param opts.homeDir Base home to look under. Defaults to the prod
 *   `~/.first-tree` home where the pre-multi-channel github-scan runner lived
 *   (it predates the per-channel home split, so it only ever existed there).
 *   Overridable for tests.
 * @param opts.log Optional sink for non-fatal diagnostics.
 */
export function retireLegacyGithubScanLaunchd(
  opts: { homeDir?: string; log?: (msg: string) => void; bootoutTimeoutMs?: number; overallTimeoutMs?: number } = {},
): RetireGithubScanResult {
  // launchd is macOS-only; the legacy runner was never a launchd job anywhere
  // else, so there is nothing to retire off-darwin.
  if (process.platform !== "darwin") return EMPTY_RESULT;

  const launchdDir = legacyLaunchdDir(opts.homeDir);
  if (!existsSync(launchdDir)) return EMPTY_RESULT;

  let entries: string[];
  try {
    entries = readdirSync(launchdDir).filter((name) => name.endsWith(".plist"));
  } catch (err) {
    if (opts.log) opts.log(`could not read ${launchdDir}: ${err instanceof Error ? err.message : String(err)}`);
    return EMPTY_RESULT;
  }
  if (entries.length === 0) return EMPTY_RESULT;

  const uid = userInfo().uid;
  const bootedOut: string[] = [];
  let removedPlists = 0;
  const bootoutTimeoutMs = opts.bootoutTimeoutMs ?? 15_000;
  const deadline = Date.now() + (opts.overallTimeoutMs ?? Number.POSITIVE_INFINITY);

  for (const entry of entries) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const plistPath = join(launchdDir, entry);
    // Prefer the Label recorded inside the plist; fall back to the filename
    // stem so an unparseable plist still gets a bootout attempt (a wrong
    // guess is a harmless no-op against launchd).
    let label: string | null = null;
    try {
      label = parsePlistLabel(readFileSync(plistPath, "utf-8"));
    } catch {
      // unreadable — fall through to the filename-derived label
    }
    label ??= basename(entry, ".plist");

    // Keep the plist when launchd reports an unexpected failure. It is the
    // retry artifact for the next daemon start; deleting it while the job is
    // still loaded would strand the KeepAlive runner permanently.
    if (!bootoutLabel(uid, label, Math.max(1, Math.min(bootoutTimeoutMs, remainingMs)), opts.log)) continue;
    bootedOut.push(label);

    try {
      rmSync(plistPath);
      removedPlists += 1;
    } catch (err) {
      if (opts.log) opts.log(`failed to remove ${plistPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Prune the now-empty launchd dir (best-effort; leave it if anything else
  // — e.g. a stray runner log — still lives there).
  try {
    rmdirSync(launchdDir);
  } catch {
    // non-empty or already gone — nothing to do
  }

  return { bootedOut, removedPlists };
}

function hasRemainingPlists(homeDir?: string): boolean {
  try {
    return readdirSync(legacyLaunchdDir(homeDir)).some((name) => name.endsWith(".plist"));
  } catch {
    return false;
  }
}

/**
 * Process-once, durably throttled entrypoint for ordinary CLI startup.
 *
 * A retained plist is retried after a cooldown, not on every command. The
 * launchctl work also has one shared one-second budget regardless of how many
 * legacy profiles exist.
 */
export function runLegacyGithubScanMigration(
  opts: { homeDir?: string; log?: (msg: string) => void; nowMs?: number; retryIntervalMs?: number } = {},
): RetireGithubScanResult {
  if (rootMigrationAttempted) return EMPTY_RESULT;
  rootMigrationAttempted = true;
  if (process.platform !== "darwin") return EMPTY_RESULT;

  const home = legacyHome(opts.homeDir);
  const statePath = join(home, "state", "legacy-github-scan-launchd.json");
  const nowMs = opts.nowMs ?? Date.now();
  try {
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as { retryAfterMs?: unknown };
    if (typeof state.retryAfterMs === "number" && state.retryAfterMs > nowMs) return EMPTY_RESULT;
  } catch {
    // Missing or unreadable state means this process gets one bounded attempt.
  }

  const result = retireLegacyGithubScanLaunchd({
    homeDir: home,
    log: opts.log,
    bootoutTimeoutMs: ROOT_MIGRATION_BUDGET_MS,
    overallTimeoutMs: ROOT_MIGRATION_BUDGET_MS,
  });
  if (hasRemainingPlists(home)) {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(
        statePath,
        `${JSON.stringify({ retryAfterMs: nowMs + (opts.retryIntervalMs ?? RETRY_INTERVAL_MS) })}\n`,
        { mode: 0o600 },
      );
    } catch {
      // A state-write failure only loses throttling; plist retry safety remains.
    }
  } else {
    try {
      rmSync(statePath, { force: true });
    } catch {
      // Best-effort stale throttle cleanup.
    }
  }
  return result;
}
