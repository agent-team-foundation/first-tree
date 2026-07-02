import { existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir, defaultDataDir, defaultHome } from "@first-tree/shared/config";
import type { Command } from "commander";
import { fail } from "../cli/output.js";
import { channelConfig } from "../core/channel.js";
import {
  getClientServiceStatus,
  isServiceSupported,
  loadCredentials,
  readActiveRootClientId,
  recordActiveClientOwner,
  stopClientService,
} from "../core/index.js";
import { print } from "../core/output.js";
import { decodeJwtPayload } from "./_shared/connect-token.js";

function readOwnerSub(token: string | undefined): string | null {
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  return typeof payload?.sub === "string" ? payload.sub : null;
}

/**
 * `logout` — symmetric counterpart to `login`. Stops the
 * background daemon and removes persisted credentials. `client.yaml` and local
 * agent runtime state are kept by default; `--purge` is the compatibility
 * destructive reset path for damaged local client identity/state.
 */
export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Disconnect from First Tree — stop daemon and clear credentials (symmetric to `login`)")
    .option("--purge", "Also remove active and parked local client state")
    .action((options: { purge?: boolean }) => {
      runLogout({ purge: options.purge === true, retryCommand: `${channelConfig.binName} logout --purge` });
    });
}

export function runLogout(opts: { purge: boolean; retryCommand?: string }): void {
  const home = defaultHome();
  const configDir = defaultConfigDir();
  const dataDir = defaultDataDir();
  const retryCommand = opts.retryCommand ?? `${channelConfig.binName} logout --purge`;
  // 1. Stop daemon (best-effort).
  if (isServiceSupported()) {
    const svc = getClientServiceStatus();
    if (svc.state === "active") {
      const res = stopClientService();
      if (!res.ok && opts.purge) {
        print.line(`  Could not stop ${svc.platform} service: ${res.reason}\n\n`);
        print.line("  Refusing to purge First Tree local client state while the daemon may still be running.\n");
        print.line(
          `  Run \`${channelConfig.binName} daemon stop\` or stop the service manually, then retry \`${retryCommand}\`.\n\n`,
        );
        fail("PURGE_DAEMON_STOP_FAILED", `Failed to stop active background service: ${res.reason}`, 1);
      }
      print.line(`  ✓ Stopped ${svc.platform} service${res.ok ? "" : ` (warning: ${res.reason})`}\n`);
    }
  }
  // 2. Remove credentials.
  if (!opts.purge) {
    const credentials = loadCredentials();
    const ownerSub = readOwnerSub(credentials?.accessToken);
    const clientId = readActiveRootClientId(configDir);
    if (credentials && ownerSub && clientId) {
      recordActiveClientOwner({
        clientId,
        userId: ownerSub,
        serverUrl: credentials.serverUrl,
      });
    }
  }
  const credsPath = join(configDir, "credentials.json");
  if (existsSync(credsPath)) {
    unlinkSync(credsPath);
    print.line(`  ✓ Removed credentials\n`);
  }
  // 3. purge: remove local machine identity and agent runtime state.
  if (opts.purge) {
    for (const entry of [
      { path: join(configDir, "client.yaml"), label: "client.yaml" },
      { path: join(configDir, "agents"), label: "local agent configs" },
      { path: join(dataDir, "sessions"), label: "agent session state" },
      { path: join(dataDir, "workspaces"), label: "agent workspaces" },
      { path: join(home, "parked-clients"), label: "parked local clients" },
      { path: join(home, "state", "client-switch.lock"), label: "client switch lock" },
      { path: join(home, "state", "client-switch-journal.json"), label: "client switch journal" },
    ]) {
      if (!existsSync(entry.path)) continue;
      rmSync(entry.path, { recursive: true, force: true });
      print.line(`  ✓ Removed ${entry.label}\n`);
    }
  }
  print.line(`\n  Logged out. Run \`${channelConfig.binName} login <token>\` to reconnect.\n\n`);
}
