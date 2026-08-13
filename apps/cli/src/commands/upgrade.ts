import { type Command, Option } from "commander";
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
  restartClientService,
  retireLegacyGithubScanRunner,
} from "../core/index.js";
import { getChannelInstallCommand } from "../core/install-guidance.js";
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
 * operator's terms. When no server URL is configured yet, it falls back to the
 * channel's latest release data so update remains useful before login/config.
 */
export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .description("Upgrade this First Tree CLI from the server target or channel latest fallback")
    .option("--check", "Only check whether a newer version is available; do not install")
    .addOption(new Option("--latest", "Deprecated compatibility: query the channel latest directly").hideHelp())
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
        print.line("\n  Not launched from an installed CLI — cannot self-upgrade.\n");
        print.line(`  Install this channel first:\n  ${getChannelInstallCommand()}\n\n`);
        return;
      }

      const requestedLatest = options.latest === true;
      let useLatest = requestedLatest;
      const isPortable = mode === "portable";
      print.line(
        requestedLatest
          ? isPortable
            ? "\n  Checking portable update target...\n"
            : "\n  Checking npm registry...\n"
          : "\n  Checking update target...\n",
      );
      let target = requestedLatest
        ? isPortable
          ? await fetchPortableLatestVersion()
          : fetchLatestVersion()
        : await fetchServerCommandVersion();

      if (!requestedLatest && !target.ok && target.reasonCode === "server_url_not_configured") {
        useLatest = true;
        print.line(
          isPortable ? "  Checking portable update target...\n" : "  Checking channel latest release data...\n",
        );
        target = isPortable ? await fetchPortableLatestVersion() : fetchLatestVersion();
      }

      if (!target.ok) {
        const targetLabel = useLatest
          ? isPortable
            ? "portable update target"
            : "latest version"
          : "server update target";
        print.line(`  Could not fetch ${targetLabel}: ${target.reason}\n`);
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
        print.line(`  Run \`${binName} upgrade${requestedLatest ? " --latest" : ""}\` to install.\n\n`);
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

      // Issue #995: upgrades used to strand the legacy `github scan` launchd
      // runner — a KeepAlive job pinned to a now-dead binary path that
      // crash-loops and squats port 7878. Retire it as part of every upgrade,
      // before any restart branching, so the cleanup runs even under
      // `--no-restart` or when no background service is installed.
      // Idempotent, darwin-only, never throws.
      const legacyCleanup = retireLegacyGithubScanRunner();
      for (const label of legacyCleanup.retiredLabels) {
        print.line(`  Retired stranded legacy github-scan launchd service: ${label}\n`);
      }
      for (const path of legacyCleanup.removedPlists) {
        print.line(`  Removed legacy github-scan plist: ${path}\n`);
      }
      for (const warning of legacyCleanup.warnings) {
        print.line(`  warning: legacy github-scan cleanup: ${warning}\n`);
      }

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
        print.line(`  Run \`${binName} login <code>\` to set one up.\n\n`);
        return;
      }

      // Refresh the unit file from the new build BEFORE restarting. Why this
      // matters: installations that predate this release ship with
      // `Restart=always` baked into their unit, which makes `daemon stop`
      // unable to terminate the service. Just swapping the npm package would
      // leave that broken unit in place — the operator wouldn't pick up the
      // `Restart=on-failure` semantics until they manually re-ran
      // `login <code>`. installClientService is idempotent (bootout +
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
