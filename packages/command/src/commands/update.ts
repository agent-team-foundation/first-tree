import type { Command } from "commander";
import * as semver from "semver";
import {
  COMMAND_VERSION,
  detectInstallMode,
  fetchLatestVersion,
  getClientServiceStatus,
  installClientService,
  installGlobalLatest,
  isServiceSupported,
  PACKAGE_NAME,
  restartClientService,
} from "../core/index.js";
import { print } from "../core/output.js";

/**
 * `first-tree-hub update` — user-driven CLI upgrade.
 *
 * Lives at the top level (not under `client`) because the tarball bundles
 * server / client / web / shared into a single artifact: upgrading affects
 * the whole CLI, not the client subsystem alone.
 *
 * Pairs with — but does not replace — the server-driven UpdateManager
 * (packages/client/src/runtime/update-manager.ts), which fires automatically
 * when a connected client falls behind the server-bundled version. This
 * command is the manual equivalent: same install + restart sequence, but
 * triggered on the operator's terms.
 */
export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Upgrade first-tree-hub to the latest published version and restart the service")
    .option("--check", "Only check whether a newer version is available; do not install")
    .option("--no-restart", "Install the new version but skip restarting the background service")
    .action(async (options: { check?: boolean; restart?: boolean }) => {
      const mode = detectInstallMode();
      if (mode === "source") {
        print.line("\n  Running from a source checkout — `update` is a no-op.\n");
        print.line("  Use `git pull` instead.\n\n");
        return;
      }
      if (mode === "npx") {
        print.line("\n  Not launched from a global npm install — cannot self-update.\n");
        print.line(`  Install globally first:  npm i -g ${PACKAGE_NAME}\n\n`);
        return;
      }

      print.line("\n  Checking npm registry...\n");
      const latest = fetchLatestVersion();
      if (!latest.ok) {
        print.line(`  Could not fetch latest version: ${latest.reason}\n\n`);
        process.exit(1);
      }

      const current = COMMAND_VERSION;
      const cmp = semver.valid(current) ? semver.compare(current, latest.version) : -1;
      if (cmp >= 0) {
        print.line(`  Already on ${current} (latest is ${latest.version}).\n\n`);
        return;
      }

      if (options.check) {
        print.line(`  Update available: ${current} → ${latest.version}\n`);
        print.line("  Run `first-tree-hub update` to install.\n\n");
        return;
      }

      print.line(`  Updating ${current} → ${latest.version}...\n`);
      const installRes = await installGlobalLatest();
      if (!installRes.ok) {
        print.line(`\n  Install failed: ${installRes.reason}\n\n`);
        process.exit(1);
      }
      const installed = installRes.installedVersion ?? latest.version;
      print.line(`  Installed ${installed}.\n`);

      // Restart the service so the new binary actually starts handling
      // connections. Skipped under --no-restart so power users can stage
      // the bits and time the cutover themselves.
      if (options.restart === false) {
        print.line("  Skipping restart (--no-restart). Run `first-tree-hub client restart` when ready.\n\n");
        return;
      }

      if (!isServiceSupported()) {
        print.line(`  No service manager on ${process.platform}; restart your inline `);
        print.line("`client start` process to pick up the new version.\n\n");
        return;
      }

      const svc = getClientServiceStatus();
      if (svc.state === "not-installed") {
        print.line("  No background service installed — nothing to restart.\n");
        print.line("  Run `first-tree-hub connect <token>` to set one up.\n\n");
        return;
      }

      // Refresh the unit file from the new build BEFORE restarting. Why this
      // matters: installations that predate this release ship with
      // `Restart=always` baked into their unit, which makes `client stop`
      // unable to terminate the service. Just swapping the npm package would
      // leave that broken unit in place — the operator wouldn't pick up the
      // `Restart=on-failure` semantics until they manually re-ran
      // `connect <token>`. installClientService is idempotent (bootout +
      // bootstrap on launchd, daemon-reload + enable --now on systemd), so
      // running it on every update gives existing machines a free unit
      // refresh on top of the binary swap. Best-effort: a unit-rewrite
      // failure logs but doesn't block the binary upgrade — we still attempt
      // the restart against the old unit.
      try {
        installClientService();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        print.line(`  warning: unit-file refresh failed: ${msg}\n`);
        print.line("  Continuing with restart against the old unit.\n");
      }

      if (svc.state === "inactive") {
        print.line("  Service is stopped — leaving it stopped. Use `client start` to bring it up.\n\n");
        return;
      }

      const restartRes = restartClientService();
      if (!restartRes.ok) {
        print.line(`\n  Service restart failed: ${restartRes.reason}\n`);
        print.line("  Run `first-tree-hub client restart` to retry.\n\n");
        process.exit(1);
      }
      print.line(`  Service restarted on ${installed}.\n\n`);
    });
}
