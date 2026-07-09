import type { Command } from "commander";
import { print } from "../../core/output.js";
import { runWindowsSupervisorLoop } from "../../core/supervisor/windows-supervisor.js";

/**
 * `first-tree daemon supervise` (hidden) — Windows Task Scheduler action.
 *
 * Task Scheduler is only the per-user logon/start trigger. This process owns
 * the actual child supervision loop: spawn `daemon start --no-interactive`,
 * observe its exit code, restart on self-update/crash, and honor stop intent.
 */
export function registerDaemonSuperviseCommand(daemon: Command): void {
  daemon
    .command("supervise", { hidden: true })
    .description("Run the Windows Task Scheduler supervisor loop (internal)")
    .action(async () => {
      if (process.platform !== "win32") {
        print.line(`  daemon supervise is only supported on win32 (current platform: ${process.platform}).\n`);
        process.exit(1);
      }
      try {
        const code = await runWindowsSupervisorLoop();
        process.exit(code);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        print.line(`  daemon supervise failed: ${msg}\n`);
        process.exit(1);
      }
    });
}
