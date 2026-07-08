import type { Command } from "commander";
import { channelConfig } from "../../core/channel.js";
import {
  getClientServiceStatus,
  installClientService,
  isServiceSupported,
  isServiceUnitDriftDetected,
  loadCredentials,
} from "../../core/index.js";
import { print } from "../../core/output.js";

/**
 * Hidden recovery hook used by the portable installer after it has switched the
 * channel shim to the freshly installed version. It is intentionally narrower
 * than `login <token>`: credentials are never created or replaced here. If a
 * previous login left valid credentials behind, this refreshes the supervised
 * unit and starts it; if credentials are gone, the follow-up `login` owns that
 * recovery step.
 */
export function registerDaemonEnsureServiceCommand(daemon: Command): void {
  daemon
    .command("ensure-service", { hidden: true })
    .description("Ensure the background service is installed and running when credentials already exist")
    .action(() => {
      const binName = channelConfig.binName;
      if (!isServiceSupported()) {
        print.line(`  ensure-service: service control is not supported on ${process.platform}; skipping.\n`);
        return;
      }

      if (!loadCredentials()) {
        print.line(`  ensure-service: no credentials found; run \`${binName} login <token>\` after install.\n`);
        return;
      }

      const svc = getClientServiceStatus();
      const drift = isServiceUnitDriftDetected();
      if (svc.state === "active" && !drift) {
        print.line(`  ensure-service: ${svc.platform} service is already running.\n`);
        return;
      }

      try {
        const info = installClientService();
        if (info.state !== "active") {
          print.line(
            `  ensure-service: ${info.platform} service installed but not running` +
              `${info.detail ? ` (${info.detail})` : ""}.\n`,
          );
          process.exit(1);
        }
        print.line(`  ensure-service: ${info.platform} service installed and running.\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        print.line(`  ensure-service: failed to install/start service: ${msg}\n`);
        process.exit(1);
      }
    });
}
