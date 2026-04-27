import type { Command } from "commander";
import {
  getHubServiceStatus,
  isHubServiceSupported,
  stopHubService,
  uninstallHubService,
} from "../core/hub-service.js";
import { print, status } from "../core/output.js";
import { parseDuration, showServiceLogs, validateLevel } from "../core/service-logs.js";

/**
 * `first-tree-hub service` — manage the Hub daemon installed by
 * `start --service`. Status, logs, stop, uninstall (Postgres / data dir
 * untouched). `service install` is an alias for `start --service`.
 */
export function registerServiceCommands(program: Command): void {
  const service = program
    .command("service")
    .description("Manage the Hub daemon (launchd / systemd-user)")
    .action(() => {
      service.help();
    });

  service
    .command("install")
    .description("Alias for `first-tree-hub start --service`")
    .action(() => {
      print.line(
        "\n  Run `first-tree-hub start --service` instead — it bundles install-time work\n" +
          "  (Docker preflight, Postgres, migrations, auto-admin) with the unit install.\n\n",
      );
      process.exit(2);
    });

  service
    .command("status")
    .description("Print whether the daemon is installed/running")
    .action(() => {
      if (!isHubServiceSupported()) {
        print.line(`  Background services are not supported on ${process.platform}.\n`);
        return;
      }
      const info = getHubServiceStatus();
      switch (info.state) {
        case "active":
          status("Service", `running (${info.detail ?? info.label})`);
          break;
        case "inactive":
          status("Service", `installed but not running${info.detail ? ` — ${info.detail}` : ""}`);
          break;
        case "not-installed":
          status("Service", "not installed");
          break;
        default:
          status("Service", "unknown");
      }
      print.line(`  Unit: ${info.unitPath}\n`);
      print.line(`  Logs: ${info.logDir}\n\n`);
    });

  service
    .command("logs")
    .description("Stream / tail the daemon's NDJSON log files")
    .option("-f, --follow", "follow new lines as they arrive")
    .option("--level <level>", "minimum level (trace|debug|info|warn|error|fatal)")
    .option("--since <duration>", "only lines newer than e.g. 30s, 5m, 2h, 1d")
    .option("--json", "emit raw NDJSON lines instead of pretty-printed text")
    .action(async (options: { follow?: boolean; level?: string; since?: string; json?: boolean }) => {
      try {
        await showServiceLogs({
          variant: "daemon",
          tail: options.follow === true,
          level: validateLevel(options.level),
          sinceMs: options.since ? parseDuration(options.since) : undefined,
          json: options.json === true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        print.line(`  Error: ${msg}\n`);
        process.exit(1);
      }
    });

  service
    .command("stop")
    .description("Stop the running daemon (does not uninstall)")
    .action(() => {
      if (!isHubServiceSupported()) {
        print.line(`  Background services are not supported on ${process.platform}.\n`);
        process.exit(1);
      }
      try {
        stopHubService();
        status("Service", "stop signalled");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        print.line(`  Error: ${msg}\n`);
        process.exit(1);
      }
    });

  service
    .command("uninstall")
    .description("Remove the daemon's launchd plist / systemd unit (Postgres untouched)")
    .action(() => {
      if (!isHubServiceSupported()) {
        print.line(`  Background services are not supported on ${process.platform}.\n`);
        return;
      }
      try {
        const info = uninstallHubService();
        status("Service", "uninstalled");
        print.line(`  Removed: ${info.unitPath}\n`);
        print.line("  (Postgres container and ~/.first-tree/hub left intact.)\n\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        print.line(`  Error: ${msg}\n`);
        process.exit(1);
      }
    });
}
