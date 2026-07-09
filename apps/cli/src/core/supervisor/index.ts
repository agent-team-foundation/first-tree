import { launchdBackend, renderLaunchdWrapper, renderPlist } from "./launchd.js";
import { resolveCliInvocation } from "./shared.js";
import { renderSystemdUnit, systemdBackend } from "./systemd.js";
import type { ServiceInfo, ServiceOpResult, ServiceState, SupervisorBackend } from "./types.js";
import { unsupportedBackend } from "./unsupported.js";

function currentBackend(): SupervisorBackend {
  if (process.platform === "darwin") return launchdBackend;
  if (process.platform === "linux") return systemdBackend;
  return unsupportedBackend;
}

/** Is background-service install supported on the current platform? */
export function isServiceSupported(): boolean {
  return currentBackend().isSupported();
}

/**
 * Install the background service for the current platform.
 *
 * @throws {Error} if the platform is not supported or the service manager fails.
 */
export function installClientService(): ServiceInfo {
  return currentBackend().install();
}

/**
 * Rewrite the supervised unit for an in-daemon auto-update handoff.
 *
 * On launchd this deliberately avoids bootout/bootstrap: refresh-unit runs as
 * a child of the current daemon job, and unloading that label can terminate the
 * update handoff before the parent daemon exits with the restart signal.
 *
 * On systemd we keep the install path because the unit explicitly treats exit
 * 75 as restart-forced, and `enable --now` does not unload the running parent
 * process out from under the update callback.
 */
export function refreshClientServiceUnitForUpdate(): ServiceInfo {
  return currentBackend().refreshForUpdate();
}

/**
 * Cheap idempotency probe used by `daemon refresh-unit`: render the unit
 * file the *current binary* would write and compare against what's on disk.
 *
 * `true`  → contents differ, the next CLI version invocation will read a
 *           stale unit and `installClientService()` SHOULD be called.
 * `false` → on-disk unit already matches (the common case for patch
 *           upgrades within the same CLI surface), no need to pay the
 *           bootout/bootstrap or daemon-reload + enable cost.
 *
 * Defensive: if the unit file is missing entirely, we treat that as "drift"
 * — the caller likely needs `installClientService()` to lay it down,
 * NOT a refresh skip. Errors during read also return `true` rather than
 * silently skipping, so a permission glitch can't ever stall the unit
 * behind a stale ExecStart.
 *
 * Returns `false` on unsupported platforms (Windows): there's no unit file
 * to refresh, so "no drift" is the honest answer.
 */
export function isServiceUnitDriftDetected(): boolean {
  return currentBackend().isUnitDriftDetected();
}

/** Report the current service state without modifying anything. */
export function getClientServiceStatus(): ServiceInfo {
  return currentBackend().status();
}

// ── start / stop / restart ──────────────────────────────────────────
//
// These delegate to the platform's service manager. Designed so the
// `daemon start / stop / restart` CLI commands are thin wrappers — all
// platform-specific quirks (launchctl bootout vs kickstart, systemctl
// start vs restart, "not loaded" tolerance) live here.

/** Start the service. No-op + ok if already running. */
export function startClientService(): ServiceOpResult {
  return currentBackend().start();
}

/** Stop the service without disabling auto-start on next boot/login. */
export function stopClientService(): ServiceOpResult {
  return currentBackend().stop();
}

/** Restart the service. Equivalent to stop + start, but uses the manager's atomic primitive. */
export function restartClientService(): ServiceOpResult {
  return currentBackend().restart();
}

/** Uninstall the background service. No-op if not installed. */
export function uninstallClientService(): ServiceInfo {
  return currentBackend().uninstall();
}

export type { ServiceInfo, ServiceOpResult, ServiceState };
export { renderLaunchdWrapper, renderPlist, renderSystemdUnit, resolveCliInvocation };
