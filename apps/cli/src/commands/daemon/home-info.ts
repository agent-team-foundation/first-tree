import { defaultConfigDir, defaultDataDir, defaultHome } from "@first-tree/shared/config";
import type { Command } from "commander";
import { channelConfig } from "../../core/channel.js";

/**
 * `first-tree daemon home-info --json` (hidden) — emit the resolved
 * channel identity + home paths as JSON. Exists purely so the
 * post-bundle test (`apps/cli/src/__tests__/post-bundle-channel-home.test.ts`)
 * can spawn `node dist/cli/index.mjs daemon home-info --json` with a
 * controlled `HOME` env and assert that the dist binary writes into the
 * channel home (`~/.first-tree-dev` / `-staging` / no suffix) rather
 * than the prod fallback.
 *
 * Why a real subcommand instead of a test-only probe: the test exercises
 * the **same code path** any real subcommand uses to read paths
 * (`defaultHome()` / `defaultConfigDir()` / `defaultDataDir()`). A
 * bespoke probe could miss the bundle eval-order regression that
 * motivated this whole thing.
 *
 * Hidden from `daemon --help` because it's a debugging interface, not a
 * user verb. Output is single-line JSON — easy to parse from shell or
 * test code.
 */
export function registerDaemonHomeInfoCommand(daemon: Command): void {
  daemon
    .command("home-info", { hidden: true })
    .description("Emit resolved channel identity + home paths as JSON (internal)")
    .action(() => {
      const payload = {
        channel: channelConfig.channel,
        binName: channelConfig.binName,
        packageName: channelConfig.packageName,
        channelDefaultHome: channelConfig.defaultHome,
        home: defaultHome(),
        configDir: defaultConfigDir(),
        dataDir: defaultDataDir(),
        serviceUnitFile: channelConfig.serviceUnitFile,
        launchdLabel: channelConfig.launchdLabel,
        firstTreeHomeEnv: process.env.FIRST_TREE_HOME ?? null,
      };
      // Bypass `print` (which is gated by --json mode); always emit JSON.
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    });
}
