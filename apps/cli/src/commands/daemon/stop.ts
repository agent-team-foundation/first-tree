import type { Command } from "commander";
import { getClientServiceStatus, isServiceSupported, stopClientService } from "../../core/index.js";
import { print } from "../../core/output.js";

export function registerDaemonStopCommand(daemon: Command): void {
  daemon
    .command("stop")
    .description("Stop the background service (preserves auto-start; use `daemon start` to bring it back)")
    .action(() => {
      if (!isServiceSupported()) {
        print.line(`\n  Service control not supported on ${process.platform}.\n`);
        print.line("  If running inline, use Ctrl+C or kill the process.\n\n");
        return;
      }
      const svc = getClientServiceStatus();
      if (svc.state === "not-installed") {
        print.line("\n  No background service installed — nothing to stop.\n");
        print.line("  If running inline, use Ctrl+C or kill the process.\n\n");
        return;
      }
      if (svc.state === "inactive") {
        print.line("\n  Service is already stopped.\n\n");
        return;
      }
      const res = stopClientService();
      if (!res.ok) {
        print.line(`\n  Failed to stop service: ${res.reason}\n\n`);
        process.exit(1);
      }
      print.line(`\n  Stopped ${svc.platform} service.\n`);
      print.line("  Auto-start on next login is preserved. Run `first-tree-hub daemon start` to bring it back.\n\n");
    });
}
