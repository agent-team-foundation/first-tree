import type { Command } from "commander";
import { channelConfig } from "../../core/channel.js";
import { getClientServiceStatus, isServiceSupported, restartClientService } from "../../core/index.js";
import { print } from "../../core/output.js";

export function registerDaemonRestartCommand(daemon: Command): void {
  daemon
    .command("restart")
    .description("Restart the background service")
    .action(() => {
      if (!isServiceSupported()) {
        print.line(`\n  Service control not supported on ${process.platform}.\n`);
        print.line("  Restart your inline `daemon start` process manually.\n\n");
        return;
      }
      const svc = getClientServiceStatus();
      if (svc.state === "not-installed") {
        print.line("\n  No background service installed.\n");
        print.line(`  Run \`${channelConfig.binName} login <token>\` first.\n\n`);
        process.exit(1);
      }
      const res = restartClientService();
      if (!res.ok) {
        print.line(`\n  Failed to restart service: ${res.reason}\n\n`);
        process.exit(1);
      }
      const after = getClientServiceStatus();
      print.line(`\n  Restarted ${after.platform} service${after.detail ? ` (${after.detail})` : ""}.\n\n`);
    });
}
