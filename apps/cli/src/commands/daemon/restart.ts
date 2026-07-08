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
        if (process.platform === "win32") {
          print.line("\n  Service control is not supported on Windows.\n");
          print.line("  First Tree runs inline on this platform.\n\n");
          print.line("  If you are onboarding and need to refresh detected agents:\n");
          print.line(`    ${channelConfig.binName} daemon probe\n\n`);
          print.line("  If you need to restart the inline daemon:\n");
          print.line(`    stop the PowerShell running \`${channelConfig.binName} daemon start\` with Ctrl+C,\n`);
          print.line(`    then run \`${channelConfig.binName} daemon start\` again.\n\n`);
        } else {
          print.line(`\n  Service control is not supported on ${process.platform}.\n`);
          print.line("  First Tree runs inline on this platform.\n\n");
          print.line("  If you are onboarding and need to refresh detected agents:\n");
          print.line(`    ${channelConfig.binName} daemon probe\n\n`);
          print.line("  If you need to restart the inline daemon:\n");
          print.line(`    stop the terminal running \`${channelConfig.binName} daemon start\` with Ctrl+C,\n`);
          print.line(`    then run \`${channelConfig.binName} daemon start\` again.\n\n`);
        }
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
