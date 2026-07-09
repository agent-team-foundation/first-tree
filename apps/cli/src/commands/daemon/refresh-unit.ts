import type { Command } from "commander";
import { isServiceSupported, isServiceUnitDriftDetected, refreshClientServiceUnitForUpdate } from "../../core/index.js";
import { print } from "../../core/output.js";

/**
 * `first-tree daemon refresh-unit` (hidden) — rewrite the platform supervisor
 * definition using the **current binary's** templates, without restarting the
 * daemon, but ONLY if the on-disk definition actually differs from what the
 * current binary would write.
 *
 * Why this exists: when the in-supervisor `executeUpdate` path installs a
 * new CLI version and exits 75 to trigger a service restart, the supervisor
 * definition on disk still reflects the OLD binary's `installClientService()`
 * output.
 * If the old binary wrote an ExecStart that the new binary doesn't recognise
 * (the canonical case: `client start` retired in favour of `daemon start`),
 * the supervisor's restart spins on `unknown command` until StartLimit gives
 * up. The fix is to spawn the freshly-installed binary in a one-shot mode
 * that rewrites the supervisor definition using its own templates, then let
 * supervisor restart.
 *
 * launchd caveat: this command is called from the currently-running daemon
 * during auto-update. On macOS it must not `bootout` the current launchd
 * label, or launchd can terminate the parent daemon and this child before the
 * handoff reaches `exit(75)`. The core refresh helper therefore uses a
 * launchd-safe file rewrite on macOS; it is not a plist hot-reload mechanism.
 *
 * Why the drift check: every alpha bump (10+ a day in dev) triggers
 * `createExecuteUpdate`, but the supervisor template only changes on a real
 * surface revision (a handful of times a year). Calling
 * `installClientService()` blindly on every upgrade costs platform-specific
 * supervisor work that logs noisily and stresses the service manager for no
 * payoff. Skip the heavy path when the definition already matches.
 *
 * Hidden because it's an internal supervisor-cooperation interface, not a
 * day-to-day user command. End users get the same effect — and more —
 * from `login <code>` (which also re-authenticates) or `upgrade`
 * (which also installs the npm package).
 */
export function registerDaemonRefreshUnitCommand(daemon: Command): void {
  daemon
    .command("refresh-unit", { hidden: true })
    .description("Rewrite the supervisor definition using the current binary's templates (internal)")
    .action(() => {
      if (!isServiceSupported()) {
        // Inline-only platforms have no supervisor definition to refresh.
        // Treated as a clean no-op so the caller's exit-75 path keeps working.
        print.line(`  refresh-unit: service control not supported on ${process.platform} — nothing to refresh.\n`);
        return;
      }
      if (!isServiceUnitDriftDetected()) {
        // Common path on routine alpha bumps: launch action + env match,
        // nothing to do. Avoids supervisor refresh cost on every patch
        // upgrade.
        print.line("  refresh-unit: supervisor definition already up-to-date — skipping refresh.\n");
        return;
      }
      try {
        const info = refreshClientServiceUnitForUpdate();
        print.line(`  refresh-unit: ${info.platform} supervisor definition rewritten at ${info.unitPath}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        print.line(`  refresh-unit: failed to rewrite supervisor definition: ${msg}\n`);
        process.exit(1);
      }
    });
}
