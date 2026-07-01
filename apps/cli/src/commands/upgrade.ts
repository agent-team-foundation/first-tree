import type { Command } from "commander";
import * as semver from "semver";
import { channelConfig } from "../core/channel.js";
import {
  COMMAND_VERSION,
  detectInstallMode,
  fetchLatestVersion,
  fetchPortableLatestVersion,
  fetchServerCommandVersion,
  getClientServiceStatus,
  installClientService,
  installGlobalLatest,
  installGlobalSpec,
  installPortableSpec,
  isServiceSupported,
  PACKAGE_NAME,
  restartClientService,
} from "../core/index.js";
import { print } from "../core/output.js";

/**
 * `upgrade` — user-driven CLI upgrade.
 *
 * Lives at the top level (not under `daemon`) because the tarball bundles
 * server / client / web / shared into a single artifact: upgrading affects
 * the whole CLI, not the daemon subsystem alone.
 *
 * Pairs with — but does not replace — the server-driven UpdateManager
 * (packages/client/src/runtime/update-manager.ts), which fires automatically
 * when a connected client falls behind the server-bundled version. This
 * command is the manual equivalent by default: same server-selected target
 * version plus the same install + restart sequence, but triggered on the
 * operator's terms. `--latest` is the explicit npm bypass.
 */
export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .description("Upgrade this First Tree CLI to the server-recommended version and restart the daemon")
    .option("--check", "Only check whether a newer version is available; do not install")
    .option("--latest", "Bypass the server target and install npm latest")
    .option("--no-restart", "Install the new version but skip restarting the background service")
    .action(async (options: { check?: boolean; latest?: boolean; restart?: boolean }) => {
      const binName = channelConfig.binName;
      const mode = detectInstallMode();
      if (mode === "source") {
        print.line("\n  Running from a source checkout — `upgrade` is a no-op.\n");
        print.line("  Use `git pull` instead.\n\n");
        return;
      }
      if (mode === "npx") {
        print.line("\n  Not launched from a global npm install — cannot self-upgrade.\n");
        // PACKAGE_NAME is never null in this branch: dev channel (null
        // pkg) short-circuits to mode==="source" above. Defend anyway so
        // the message stays readable if that contract ever changes.
        const installHint = PACKAGE_NAME ?? binName;
        print.line(`  Install globally first:  npm i -g ${installHint}\n\n`);
        return;
      }

      const useLatest = options.latest === true;
      const isPortable = mode === "portable";
      print.line(
        useLatest
          ? isPortable
            ? "\n  Checking portable update target...\n"
            : "\n  Checking npm registry...\n"
          : "\n  Checking server update target...\n",
      );
      const target = useLatest
        ? isPortable
          ? await fetchPortableLatestVersion()
          : fetchLatestVersion()
        : await fetchServerCommandVersion();
      if (!target.ok) {
        const targetLabel = useLatest
          ? isPortable
            ? "portable update target"
            : "latest version"
          : "server update target";
        print.line(`  Could not fetch ${targetLabel}: ${target.reason}\n`);
        if (!useLatest) {
          print.line(`  Run \`${binName} upgrade --latest\` to install latest instead.\n`);
        }
        print.line("\n");
        process.exit(1);
      }

      const current = COMMAND_VERSION;
      const sourceLabel = useLatest ? (isPortable ? "portable latest" : "npm latest") : "server target";
      const cmp = semver.valid(current) ? semver.compare(current, target.version) : -1;
      if (cmp >= 0) {
        print.line(`  Already on ${current} (${sourceLabel} is ${target.version}).\n\n`);
        return;
      }

      if (options.check) {
        print.line(`  Upgrade available: ${current} → ${target.version}\n`);
        print.line(`  Run \`${binName} upgrade${useLatest ? " --latest" : ""}\` to install.\n\n`);
        return;
      }

      print.line(`  Upgrading ${current} → ${target.version}...\n`);
      const installRes = isPortable
        ? await installPortableSpec(useLatest ? "latest" : target.version)
        : useLatest
          ? await installGlobalLatest()
          : await installGlobalSpec(target.version);
      if (!installRes.ok) {
        print.line(`\n  Install failed: ${installRes.reason}\n\n`);
        process.exit(1);
      }
      const installed = installRes.installedVersion ?? target.version;
      print.line(`  Installed ${installed}.\n`);

      // Restart the service so the new binary actually starts handling
      // connections. Skipped under --no-restart so power users can stage
      // the bits and time the cutover themselves.
      if (options.restart === false) {
        print.line(`  Skipping restart (--no-restart). Run \`${binName} daemon restart\` when ready.\n\n`);
        return;
      }

      if (!isServiceSupported()) {
        print.line(`  No service manager on ${process.platform}; restart your inline `);
        print.line(`\`${binName} daemon start\` process to pick up the new version.\n\n`);
        return;
      }

      const svc = getClientServiceStatus();
      if (svc.state === "not-installed") {
        print.line("  No background service installed — nothing to restart.\n");
        print.line(`  Run \`${binName} login <token>\` to set one up.\n\n`);
        return;
      }

      // Refresh the unit file from the new build BEFORE restarting. Why this
      // matters: installations that predate this release ship with
      // `Restart=always` baked into their unit, which makes `daemon stop`
      // unable to terminate the service. Just swapping the npm package would
      // leave that broken unit in place — the operator wouldn't pick up the
      // `Restart=on-failure` semantics until they manually re-ran
      // `login <token>`. installClientService is idempotent (bootout +
      // bootstrap on launchd, daemon-reload + enable --now on systemd), so
      // running it on every upgrade gives existing machines a free unit
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
        print.line(`  Service is stopped — leaving it stopped. Use \`${binName} daemon start\` to bring it up.\n\n`);
        return;
      }

      const restartRes = restartClientService();
      if (!restartRes.ok) {
        print.line(`\n  Service restart failed: ${restartRes.reason}\n`);
        print.line(`  Run \`${binName} daemon restart\` to retry.\n\n`);
        process.exit(1);
      }
      print.line(`  Service restarted on ${installed}.\n\n`);
    });
}
