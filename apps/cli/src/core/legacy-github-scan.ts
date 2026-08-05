import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { createLogger } from "@first-tree/client";
import { defaultHome } from "@first-tree/shared/config";
import { print } from "./output.js";
import { runCapture, runCaptureOut } from "./supervisor/shared.js";

/**
 * One-shot retirement of the legacy github-scan launchd runner (issue #995).
 *
 * The github-scan subsystem was removed from every channel in #775, but its
 * macOS user agent could outlive the upgrade: the plist pinned
 * `ProgramArguments` to an absolute binary path with `KeepAlive: true`, so
 * once the binary moved, launchd kept restarting a job that died instantly
 * with `MODULE_NOT_FOUND` — an endless crash-loop appending to the runner
 * log, and a zombie that could keep squatting the legacy default port 7878.
 *
 * This housekeeping runs once per machine per channel from the CLI's global
 * preAction hook: detect any stranded runner and put it down — `launchctl
 * bootout` the label(s) and remove the plist directory.
 *
 * Detection has two sources because the label embeds the operator's GitHub
 * login (`com.first-tree.github-scan.runner.<login>.<profile>`), which we
 * cannot recompute locally:
 *
 *   1. Plist files under the default runner dir
 *      `~/.first-tree/github-scan/runner/launchd/*.plist` — the only
 *      location the legacy installer ever bootstrapped from (no
 *      `~/Library/LaunchAgents` copy existed). The filename IS the label.
 *   2. A `launchctl list` sweep for labels with the runner prefix — the only
 *      way to find runners installed with `GITHUB_SCAN_DIR` /
 *      `GITHUB_SCAN_HOME` overrides (non-default plist location), and
 *      runners whose plist was deleted by hand while the service stayed
 *      loaded. For such non-default paths we bootout by label only; we do
 *      not hunt for their plist files.
 *
 * Why auto-removal is safe here, unlike the `dev.first-tree.client` legacy
 * label in `supervisor/launchd.ts`: no live or future release of any channel
 * can own `com.first-tree.github-scan.runner.*` — the subsystem is gone
 * everywhere, so there is no parallel-install scenario to protect.
 *
 * Invariants:
 *   - Idempotent — with nothing stranded it only writes the marker; repeat
 *     runs short-circuit on the marker; even without the marker every step
 *     tolerates the already-clean state (bootout tolerates not-loaded,
 *     rmSync tolerates a missing dir).
 *   - Non-fatal — any failure is logged and reported in the result, never
 *     thrown; the marker is only written on a fully clean pass so the next
 *     CLI run retries.
 *   - Cheap — steady state is one `existsSync` per command; the first run
 *     costs at most two `launchctl` subprocesses.
 */

const LEGACY_LABEL_PREFIX = "com.first-tree.github-scan.runner.";
const LEGACY_MARKER_VERSION = 1;

export type LegacyGithubScanRetireResult = {
  /** false when the pass short-circuited (non-darwin, or marker already present). */
  checked: boolean;
  /** Labels guaranteed not loaded after the pass (booted out, or already not loaded). */
  labelsBootedOut: string[];
  /** Whether the default runner plist directory was removed. */
  plistDirRemoved: boolean;
  /** Whether the done-marker was written. Absent marker ⇒ next CLI run retries. */
  markerWritten: boolean;
  /** Non-fatal problems encountered; non-empty means the pass will be retried. */
  errors: string[];
};

function legacyLaunchdDir(homeDir: string): string {
  // Prod-era fixed path: github-scan predates channels, so its state always
  // lived under ~/.first-tree regardless of which channel's binary is
  // cleaning up now. Deliberately NOT defaultHome() (channel-dependent).
  return join(homeDir, ".first-tree", "github-scan", "runner", "launchd");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function retireLegacyGithubScanRunner(opts?: {
  homeDir?: string;
  stateDir?: string;
}): LegacyGithubScanRetireResult {
  const result: LegacyGithubScanRetireResult = {
    checked: false,
    labelsBootedOut: [],
    plistDirRemoved: false,
    markerWritten: false,
    errors: [],
  };
  const logger = createLogger("legacy-github-scan");
  try {
    // The legacy subsystem was darwin-only; Linux/Windows never had a unit.
    if (process.platform !== "darwin") return result;

    const stateDir = opts?.stateDir ?? join(defaultHome(), "state");
    const markerPath = join(stateDir, "legacy-github-scan-runner-retired.json");
    if (existsSync(markerPath)) return result;
    result.checked = true;

    const homeDir = opts?.homeDir ?? homedir();
    const plistDir = legacyLaunchdDir(homeDir);
    const labels = new Set<string>();

    // Source 1: plist files in the default runner dir. Filename is the label;
    // only exact-prefix names are eligible for bootout (the directory itself
    // is tool-private state and is removed wholesale below).
    const plistDirPresent = existsSync(plistDir);
    if (plistDirPresent) {
      try {
        for (const entry of readdirSync(plistDir)) {
          if (!entry.endsWith(".plist")) continue;
          const label = entry.slice(0, -".plist".length);
          if (label.startsWith(LEGACY_LABEL_PREFIX)) labels.add(label);
        }
      } catch (err) {
        result.errors.push(`scan ${plistDir}: ${errorMessage(err)}`);
      }
    }

    // Source 2: sweep the user's launchd domain for runner labels. `launchctl
    // list` prints `PID\tStatus\tLabel` with no header; labels are
    // sanitizeFilename products and contain no spaces, so the last
    // whitespace-separated field of each line is the label.
    const sweep = runCaptureOut("launchctl", ["list"], 10_000);
    if (sweep.ok) {
      for (const line of sweep.stdout.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);
        const label = fields[fields.length - 1];
        if (label?.startsWith(LEGACY_LABEL_PREFIX)) labels.add(label);
      }
    } else {
      // Without the sweep we cannot prove nothing is stranded (e.g. an
      // env-override install), so block the marker and retry next run.
      result.errors.push(`launchctl list: ${sweep.stderr || `exit ${sweep.code ?? "unknown"}`}`);
    }

    const uid = userInfo().uid;
    for (const label of [...labels].sort()) {
      const res = runCapture("launchctl", ["bootout", `gui/${uid}/${label}`], 15_000);
      if (!res.ok && !/not find|no such|not loaded/i.test(res.stderr)) {
        result.errors.push(`launchctl bootout ${label}: ${res.stderr || `exit ${res.code ?? "unknown"}`}`);
        continue;
      }
      result.labelsBootedOut.push(label);
    }

    if (plistDirPresent) {
      try {
        rmSync(plistDir, { recursive: true, force: true });
        result.plistDirRemoved = true;
      } catch (err) {
        result.errors.push(`remove ${plistDir}: ${errorMessage(err)}`);
      }
    }

    if (result.errors.length === 0) {
      try {
        mkdirSync(stateDir, { recursive: true });
        const marker = {
          version: LEGACY_MARKER_VERSION,
          retiredAt: new Date().toISOString(),
          labelsBootedOut: result.labelsBootedOut,
          plistDirRemoved: result.plistDirRemoved,
        };
        writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
        result.markerWritten = true;
      } catch (err) {
        result.errors.push(`write marker ${markerPath}: ${errorMessage(err)}`);
      }
    }

    if (result.labelsBootedOut.length > 0 || result.plistDirRemoved) {
      const parts: string[] = [];
      if (result.labelsBootedOut.length > 0) parts.push(`booted out ${result.labelsBootedOut.join(", ")}`);
      if (result.plistDirRemoved) parts.push(`removed ${plistDir}`);
      print.status(
        "✓",
        `retired legacy github-scan launchd runner (${parts.join("; ")}) — crash-loop stopped, port 7878 released`,
      );
    }
    if (result.errors.length > 0) {
      logger.warn({ errors: result.errors }, "legacy github-scan runner retirement incomplete; will retry on next run");
    }
    return result;
  } catch (err) {
    // Housekeeping must never break a CLI command.
    result.errors.push(errorMessage(err));
    logger.warn({ err }, "legacy github-scan runner retirement failed; will retry on next run");
    return result;
  }
}
