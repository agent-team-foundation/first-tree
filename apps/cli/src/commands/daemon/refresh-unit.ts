import type { Command } from "commander";
import { errorMessage } from "../../core/error-message.js";
import { isServiceSupported, isServiceUnitDriftDetected, refreshClientServiceUnitForUpdate } from "../../core/index.js";
import { print } from "../../core/output.js";

/**
 * `first-tree daemon refresh-unit` (hidden) — rewrite the launchd plist /
 * systemd unit using the **current binary's** templates, without restarting
 * the daemon, but ONLY if the on-disk unit actually differs from what the
 * current binary would write.
 *
 * Why this exists: when the in-supervisor `executeUpdate` path installs a
 * new CLI version and exits 75 to trigger a service restart, the unit file
 * on disk still reflects the OLD binary's `installClientService()` output.
 * If the old binary wrote an ExecStart that the new binary doesn't recognise
 * (the canonical case: `client start` retired in favour of `daemon start`),
 * the supervisor's restart spins on `unknown command` until StartLimit gives
 * up. The fix is to spawn the freshly-installed binary in a one-shot mode
 * that rewrites the unit using its own templates, then let supervisor restart.
 *
 * launchd caveat: this command is called from the currently-running daemon
 * during auto-update. On macOS it must not `bootout` the current launchd
 * label, or launchd can terminate the parent daemon and this child before the
 * handoff reaches `exit(75)`. The core refresh helper therefore uses a
 * launchd-safe file rewrite on macOS; it is not a plist hot-reload mechanism.
 *
 * Why the drift check: every alpha bump (10+ a day in dev) triggers
 * `createExecuteUpdate`, but the unit template only changes on a real
 * surface revision (a handful of times a year). Calling
 * `installClientService()` blindly on every upgrade costs a bootout/
 * bootstrap pair (launchd) or daemon-reload + enable cycle (systemd), all
 * of which log noisily and stress the service manager for no payoff. Skip
 * the heavy path when the unit already matches.
 *
 * Hidden because it's an internal supervisor-cooperation interface, not a
 * day-to-day user command. End users get the same effect — and more —
 * from `login <code>` (which also re-authenticates) or `upgrade`
 * (which also installs the npm package).
 */
export function registerDaemonRefreshUnitCommand(daemon: Command): void {
  daemon
    .command("refresh-unit", { hidden: true })
    .description("Rewrite the launchd plist / systemd unit using the current binary's templates (internal)")
    .action(() => {
      if (!isServiceSupported()) {
        // Inline-only platforms (Windows, BSD, etc.) have no unit to refresh.
        // Treated as a clean no-op so the caller's exit-75 path keeps working.
        print.line(`  refresh-unit: service control not supported on ${process.platform} — nothing to refresh.\n`);
        return;
      }
      if (!isServiceUnitDriftDetected()) {
        // Common path on routine alpha bumps: ExecStart + env match, nothing
        // to do. Avoids the bootout/bootstrap (launchd) or daemon-reload +
        // enable (systemd) cost on every patch upgrade.
        print.line("  refresh-unit: unit already up-to-date — skipping bootout/bootstrap.\n");
        return;
      }
      try {
        const info = refreshClientServiceUnitForUpdate();
        print.line(`  refresh-unit: ${info.platform} unit rewritten at ${info.unitPath}\n`);
      } catch (err) {
        const msg = errorMessage(err);
        print.line(`  refresh-unit: failed to rewrite service unit: ${msg}\n`);
        process.exit(1);
      }
    });
}
