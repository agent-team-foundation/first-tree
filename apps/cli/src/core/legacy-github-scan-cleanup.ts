import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { runCapture, runCaptureOut } from "./supervisor/shared.js";

/**
 * One-shot retirement of the legacy GitHub Scan launchd runner (issue #995).
 *
 * The retired `github scan` subsystem bootstrapped a per-user launchd job
 * labelled `com.first-tree.github-scan.runner.<login>.<profile>` whose plist
 * lived under `~/.first-tree/github-scan/runner/launchd/` (a pre-multi-channel
 * hardcoded path — NOT `defaultHome()`), with `KeepAlive: true` and an
 * absolute node/CLI path baked into `ProgramArguments`. When an upgrade
 * removed the subsystem or relocated the binary, launchd kept restarting the
 * dead path: a KeepAlive crash-loop that also squatted the legacy default
 * HTTP port (7878).
 *
 * This module detects that stranded state and remediates it:
 *   1. plists on disk under the legacy launchd dir, and
 *   2. labels still loaded in the gui domain (covers a zombie whose plist was
 *      already deleted by hand — the old `stop` never removed plists, but an
 *      operator may have),
 * then `launchctl bootout`s each label and deletes its plist.
 *
 * The label prefix is exclusively owned by the retired subsystem — no current
 * channel (`first-tree` / `first-tree-staging` / `first-tree-dev`) or peer
 * install ever uses it — so booting these labels out can never take down a
 * live service. The operation is naturally idempotent (nothing found → no-op)
 * and best-effort: it never throws, so it can never block `upgrade` or
 * `daemon start`.
 */

export const LEGACY_GITHUB_SCAN_LABEL_PREFIX = "com.first-tree.github-scan.runner.";

/**
 * "This job is not loaded" answers from `launchctl bootout` — the expected
 * idempotent case, not an error. Matched both by message ("Could not find
 * specified service", "No such process") and by the stable launchd error
 * codes launchctl prints in `Boot-out failed: <code>:` form (3 = ESRCH,
 * 113 = could-not-find-service), so detection does not hinge on exact
 * wording.
 */
const BOOTOUT_NOT_LOADED_RE = /not find|no such|not loaded|failed: (?:3|113):/i;

/**
 * `~/.first-tree/github-scan/runner/launchd` — matches the retired runner's
 * `resolveRunnerHome()` default. Deliberately based on `homedir()`, not the
 * channel home: the legacy runner predates multi-channel and only ever wrote
 * here, so every channel's cleanup must look at the same location.
 */
export function legacyGithubScanLaunchdDir(): string {
  return join(homedir(), ".first-tree", "github-scan", "runner", "launchd");
}

export type LegacyGithubScanCleanup = {
  /** False when the platform has no launchd (nothing to check). */
  checked: boolean;
  /** Labels successfully booted out of the gui domain. */
  retiredLabels: string[];
  /** Plist files removed from the legacy launchd dir. */
  removedPlists: string[];
  /** Non-fatal problems encountered (cleanup continues past each). */
  warnings: string[];
};

function emptyResult(checked: boolean): LegacyGithubScanCleanup {
  return { checked, retiredLabels: [], removedPlists: [], warnings: [] };
}

function legacyPlistFiles(dir: string, warnings: string[]): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter(
      (name) => name.startsWith(LEGACY_GITHUB_SCAN_LABEL_PREFIX) && name.endsWith(".plist"),
    );
  } catch (err) {
    warnings.push(`could not read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Labels currently loaded in the gui domain that belong to the legacy runner.
 * `launchctl list` prints one `PID\tStatus\tLabel` row per job; the label is
 * the last tab-separated column. A failed/timed-out query degrades to "none
 * found" with a warning — the on-disk plist sweep still runs.
 */
function loadedLegacyLabels(warnings: string[]): string[] {
  const res = runCaptureOut("launchctl", ["list"], 10_000);
  if (!res.ok) {
    warnings.push(`launchctl list failed: ${res.stderr || `exit ${res.code ?? "unknown"}`}`);
    return [];
  }
  const labels: string[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const label = line.split("\t").at(-1)?.trim();
    if (label?.startsWith(LEGACY_GITHUB_SCAN_LABEL_PREFIX)) labels.push(label);
  }
  return labels;
}

/**
 * Detect and retire any stranded legacy github-scan launchd runner.
 *
 * Safe to call repeatedly and from any command path; returns a summary the
 * caller may surface to the operator. Never throws.
 */
export function retireLegacyGithubScanRunner(): LegacyGithubScanCleanup {
  if (process.platform !== "darwin") return emptyResult(false);

  const result = emptyResult(true);
  const dir = legacyGithubScanLaunchdDir();
  const plistFiles = legacyPlistFiles(dir, result.warnings);

  const labels = new Set<string>(loadedLegacyLabels(result.warnings));
  for (const file of plistFiles) labels.add(file.slice(0, -".plist".length));
  if (labels.size === 0 && plistFiles.length === 0) return result;

  const domain = `gui/${userInfo().uid}`;
  for (const label of [...labels].sort()) {
    // Generous timeout: tearing down a live (even crash-looping) job can take
    // a few seconds. "Not loaded" answers are the expected idempotent case.
    const bootout = runCapture("launchctl", ["bootout", `${domain}/${label}`], 15_000);
    if (bootout.ok) {
      result.retiredLabels.push(label);
    } else if (!BOOTOUT_NOT_LOADED_RE.test(bootout.stderr)) {
      result.warnings.push(
        `launchctl bootout ${domain}/${label}: ${bootout.stderr || `exit ${bootout.code ?? "unknown"}`}`,
      );
    }
  }

  for (const file of plistFiles) {
    const path = join(dir, file);
    try {
      rmSync(path);
      result.removedPlists.push(path);
    } catch (err) {
      result.warnings.push(`could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Leave the rest of `~/.first-tree/github-scan/` (config.yaml, logs, repos)
  // alone — user-owned data is out of scope. Only fold away the now-empty
  // launchd dir; rmdirSync refuses non-empty dirs, which is exactly what we
  // want for anything unexpected left inside.
  try {
    rmdirSync(dir);
  } catch {
    // Missing or non-empty — either way, nothing to do.
  }

  return result;
}
