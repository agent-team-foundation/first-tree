import type { Command } from "commander";
import { installClientService, isServiceSupported } from "../../core/index.js";
import { print } from "../../core/output.js";

/**
 * `first-tree-hub daemon refresh-unit` (hidden) — rewrite the launchd plist /
 * systemd unit using the **current binary's** templates, without restarting
 * the daemon.
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
 * Hidden because it's an internal supervisor-cooperation interface, not a
 * day-to-day user command. End users get the same effect — and more —
 * from `first-tree-hub login <token>` (which also re-authenticates) or
 * `first-tree-hub upgrade` (which also installs the npm package).
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
      try {
        const info = installClientService();
        print.line(`  refresh-unit: ${info.platform} unit rewritten at ${info.unitPath}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        print.line(`  refresh-unit: failed to rewrite service unit: ${msg}\n`);
        process.exit(1);
      }
    });
}
