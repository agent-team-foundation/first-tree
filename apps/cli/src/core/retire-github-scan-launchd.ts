import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Retire the stranded legacy `github-scan` launchd runner (issue #995).
 *
 * The `github-scan` subsystem was removed from the CLI after v1.0 (first
 * shipped in v0.5.4), but machines that ran an older build may still carry its
 * launchd runner: label `com.first-tree.github-scan.runner.<user>.<profile>`,
 * installed with an unconditional `KeepAlive: true` and `ProgramArguments`
 * pointing at the old npm layout. Once an upgrade relocates or removes that
 * entrypoint, launchd restarts the runner forever (`MODULE_NOT_FOUND` crash
 * loop) and, while looping, the runner re-binds its legacy default HTTP port
 * 7878. No current code path retires the service — this module closes that gap.
 *
 * Design constraints, in decreasing order of importance:
 *
 * - **Never break the requested command.** Everything here is best-effort:
 *   errors are swallowed (optionally reported through `log`) and the sweep
 *   never throws. The production caller (root CLI preAction) passes no `log`
 *   sink at all, because preAction also wraps `--json` commands where any
 *   stray output would corrupt machine-readable stdout.
 * - **Touch only the retired namespace.** Enumeration is scoped to
 *   `<prod home>/github-scan/runner/launchd/*.plist`, and a label must start
 *   with {@link LEGACY_GITHUB_SCAN_LABEL_PREFIX} before it is booted out —
 *   whether it came from the plist body or from the filename fallback. A
 *   plist declaring any other label is recorded in `skipped` and left on
 *   disk. The legacy runner predates the multi-channel home split and only
 *   ever lived under `~/.first-tree`, so the prod home is always the right
 *   root, whichever channel binary runs the sweep. This does not conflict
 *   with the `installLaunchd` rule against sweeping legacy *client* labels:
 *   that rule protects a namespace still shared with parallel channel
 *   installs, whereas the github-scan namespace is retired wholesale and can
 *   never belong to a live service again.
 * - **Keep the retry artifact on real failure.** A plist is deleted only
 *   after its bootout succeeded or launchd reported the label as not loaded.
 *   On an unexpected launchctl failure the file stays behind so a later run
 *   retries; deleting it first could strand a still-loaded KeepAlive job with
 *   no on-disk trace.
 *
 * Known limitation, accepted by design: the runner registered itself with
 * `launchctl bootstrap gui/<uid>` straight from its own directory and never
 * wrote to `~/Library/LaunchAgents`, so its registration does not survive a
 * logout. If another OS user installed the runner, our `gui/<uid>` bootout
 * targets the wrong domain, reports "not found", and we still remove the
 * plist — the other user's in-session job dies at their next logout and can
 * no longer be re-bootstrapped.
 */

export const LEGACY_GITHUB_SCAN_LABEL_PREFIX = "com.first-tree.github-scan.runner.";

export type RetireGithubScanResult = {
  /** Labels booted out (or confirmed not loaded); plist removal is then attempted (see `removedPlists`). */
  bootedOut: string[];
  /** Number of plist files removed from disk. */
  removedPlists: number;
  /** Plist file names whose label is outside the legacy namespace; left untouched. */
  skipped: string[];
};

/** Cooldown between sweeps while a plist survives a failed bootout. */
const RETRY_INTERVAL_MS = 6 * 60 * 60 * 1_000;
/** Shared launchctl budget for the startup-boundary sweep (per label and overall). */
const STARTUP_SWEEP_BUDGET_MS = 1_000;

let migrationAttemptedInProcess = false;

function emptyResult(): RetireGithubScanResult {
  // Fresh object per call — callers may append to the arrays.
  return { bootedOut: [], removedPlists: 0, skipped: [] };
}

/** The pre-multi-channel production home the legacy runner lived under. */
function legacyHome(homeDir?: string): string {
  return homeDir ?? join(homedir(), ".first-tree");
}

/** Directory the legacy runner wrote its plists to (default `$GITHUB_SCAN_HOME` layout). */
export function legacyGithubScanLaunchdDir(homeDir?: string): string {
  return join(legacyHome(homeDir), "github-scan", "runner", "launchd");
}

/**
 * Extract the `Label` value from a launchd plist body. Whitespace between the
 * key/string tags is tolerated; legacy labels themselves were built from a
 * `[A-Za-z0-9._-]` sanitized charset, so no XML entity decoding is needed.
 */
function parsePlistLabel(plistBody: string): string | null {
  const match = plistBody.match(/<key>\s*Label\s*<\/key>\s*<string>([^<]+)<\/string>/);
  return match?.[1] === undefined ? null : match[1].trim();
}

/**
 * Resolve the label a plist file claims: prefer the body's `Label`, fall back
 * to the filename stem (the legacy runner always wrote `<label>.plist`, so an
 * unreadable file still gets a bootout attempt keyed on its name).
 */
function resolvePlistLabel(plistPath: string, fileName: string): string {
  let label: string | null = null;
  try {
    label = parsePlistLabel(readFileSync(plistPath, "utf-8"));
  } catch {
    // Unreadable body — the filename stem below still identifies the label.
  }
  return label ?? basename(fileName, ".plist");
}

/** `launchctl bootout gui/<uid>/<label>`, tolerating the label-not-loaded case. */
function bootoutLabel(uid: number, label: string, timeoutMs: number, log?: (message: string) => void): boolean {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("launchctl", ["bootout", `gui/${uid}/${label}`], {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    log?.(`launchctl bootout ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (result.status === 0) return true;
  const stderr = String(result.stderr ?? "").trim();
  // Same tolerance set the launchd supervisor uses: a label that is not
  // currently loaded is the happy path on a machine where the zombie already
  // died (or never ran this login session).
  if (/not find|no such|not loaded/i.test(stderr)) return true;
  log?.(`launchctl bootout ${label} failed: ${stderr || `exit ${result.status ?? "unknown"}`}`);
  return false;
}

/**
 * Boot out and delete every legacy github-scan plist under the prod home.
 *
 * @param opts.homeDir Prod-home override for tests; defaults to `~/.first-tree`.
 * @param opts.log Optional sink for non-fatal diagnostics. Omit in production
 *   command paths — see the module doc on `--json` purity.
 * @param opts.bootoutTimeoutMs Per-label launchctl timeout (default 15s).
 * @param opts.overallTimeoutMs Deadline across all labels (default unbounded).
 */
export function retireLegacyGithubScanLaunchd(
  opts: {
    homeDir?: string;
    log?: (message: string) => void;
    bootoutTimeoutMs?: number;
    overallTimeoutMs?: number;
  } = {},
): RetireGithubScanResult {
  const result = emptyResult();
  // The legacy runner only ever installed a persistent service through
  // launchd; on every other platform there is nothing to retire.
  if (process.platform !== "darwin") return result;

  const launchdDir = legacyGithubScanLaunchdDir(opts.homeDir);
  if (!existsSync(launchdDir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(launchdDir).filter((name) => name.endsWith(".plist"));
  } catch (err) {
    opts.log?.(`could not read ${launchdDir}: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  if (entries.length === 0) return result;

  const uid = userInfo().uid;
  const bootoutTimeoutMs = opts.bootoutTimeoutMs ?? 15_000;
  const deadline = Date.now() + (opts.overallTimeoutMs ?? Number.POSITIVE_INFINITY);

  for (const entry of entries) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    const plistPath = join(launchdDir, entry);
    const label = resolvePlistLabel(plistPath, entry);
    if (!label.startsWith(LEGACY_GITHUB_SCAN_LABEL_PREFIX)) {
      // Not ours — a foreign plist in this directory is surprising, so it is
      // reported (doctor surfaces it too) but never booted out or deleted.
      result.skipped.push(entry);
      opts.log?.(`skipping ${entry}: label "${label}" is outside the legacy github-scan namespace`);
      continue;
    }

    if (!bootoutLabel(uid, label, Math.max(1, Math.min(bootoutTimeoutMs, remainingMs)), opts.log)) continue;
    result.bootedOut.push(label);

    try {
      rmSync(plistPath);
      result.removedPlists += 1;
    } catch (err) {
      opts.log?.(`failed to remove ${plistPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Prune the directory once it is empty; anything left (skipped plists, logs)
  // keeps it in place.
  try {
    rmdirSync(launchdDir);
  } catch {
    // Non-empty or already gone.
  }

  return result;
}

/**
 * Disk-only residue scan for `daemon doctor`: classifies every plist under the
 * legacy launchd directory without touching launchd or deleting anything.
 */
export function scanLegacyGithubScanPlists(homeDir?: string): { legacyLabels: string[]; foreignPlists: string[] } {
  const legacyLabels: string[] = [];
  const foreignPlists: string[] = [];
  const launchdDir = legacyGithubScanLaunchdDir(homeDir);
  let entries: string[] = [];
  try {
    entries = readdirSync(launchdDir).filter((name) => name.endsWith(".plist"));
  } catch {
    // Missing or unreadable directory reads as "no residue".
  }
  for (const entry of entries) {
    const label = resolvePlistLabel(join(launchdDir, entry), entry);
    if (label.startsWith(LEGACY_GITHUB_SCAN_LABEL_PREFIX)) legacyLabels.push(label);
    else foreignPlists.push(entry);
  }
  return { legacyLabels, foreignPlists };
}

function hasRemainingPlists(homeDir?: string): boolean {
  try {
    return readdirSync(legacyGithubScanLaunchdDir(homeDir)).some((name) => name.endsWith(".plist"));
  } catch {
    return false;
  }
}

/**
 * Once-per-process, durably throttled entrypoint for the root CLI preAction.
 *
 * Steady state on a clean machine is two fs probes (throttle state read,
 * launchd dir existence) and zero subprocesses. When a plist survives a failed
 * bootout, a cooldown stamp under the prod home suppresses retries for
 * {@link RETRY_INTERVAL_MS} so ordinary commands never pay repeated launchctl
 * spawns; the stamp is deleted again the moment the directory is clean. The
 * throttle deliberately counts *any* remaining plist, including skipped
 * foreign ones — otherwise a foreign-only directory would re-enumerate and
 * re-parse every file on every CLI command forever instead of once per
 * cooldown. All launchctl work shares one {@link STARTUP_SWEEP_BUDGET_MS}
 * deadline regardless of how many labels exist.
 */
export function runLegacyGithubScanMigration(
  opts: { homeDir?: string; log?: (message: string) => void; nowMs?: number; retryIntervalMs?: number } = {},
): RetireGithubScanResult {
  if (migrationAttemptedInProcess) return emptyResult();
  migrationAttemptedInProcess = true;
  if (process.platform !== "darwin") return emptyResult();

  const home = legacyHome(opts.homeDir);
  const statePath = join(home, "state", "legacy-github-scan-launchd.json");
  const nowMs = opts.nowMs ?? Date.now();
  try {
    const state: unknown = JSON.parse(readFileSync(statePath, "utf-8"));
    if (
      typeof state === "object" &&
      state !== null &&
      typeof (state as { retryAfterMs?: unknown }).retryAfterMs === "number" &&
      (state as { retryAfterMs: number }).retryAfterMs > nowMs
    ) {
      return emptyResult();
    }
  } catch {
    // No or unreadable state — this process gets one bounded attempt.
  }

  const result = retireLegacyGithubScanLaunchd({
    homeDir: home,
    log: opts.log,
    bootoutTimeoutMs: STARTUP_SWEEP_BUDGET_MS,
    overallTimeoutMs: STARTUP_SWEEP_BUDGET_MS,
  });

  if (hasRemainingPlists(home)) {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(
        statePath,
        `${JSON.stringify({ retryAfterMs: nowMs + (opts.retryIntervalMs ?? RETRY_INTERVAL_MS) })}\n`,
        {
          mode: 0o600,
        },
      );
    } catch {
      // Losing the stamp only loses throttling; the retained plist still drives retries.
    }
  } else {
    try {
      rmSync(statePath, { force: true });
    } catch {
      // Stale-stamp cleanup is best-effort.
    }
  }

  return result;
}
