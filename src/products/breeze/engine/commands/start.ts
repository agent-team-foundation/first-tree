/**
 * TS port of `Service::start_background` in `service.rs:255-349`.
 *
 * Brings up a detached daemon process. On macOS (with `launchctl`
 * available) we write a LaunchAgent plist and kickstart it. Elsewhere
 * we fall back to `spawn(... detached: true)` with stdout redirected.
 */

import { mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

import { loadBreezeDaemonConfig } from "../runtime/config.js";
import {
  parseAllowRepoArg,
  requireExplicitRepoFilter,
} from "../runtime/allow-repo.js";
import { findServiceLock, isLockStale } from "../daemon/claim.js";
import { resolveDaemonIdentity } from "../daemon/identity.js";
import {
  bootstrapLaunchdJob,
  supportsLaunchd,
} from "../daemon/launchd.js";
import { resolveRunnerHome } from "../daemon/runner-skeleton.js";

export interface RunStartOptions {
  write?: (line: string) => void;
  breezeDir?: string;
  runnerHome?: string;
  profile?: string;
  /** CLI executable. Defaults to the current Node binary. */
  executable?: string;
  /** CLI script path when re-invoking via `node <script> ...`. */
  entrypoint?: string;
  /** Args after the executable (forwarded to the daemon). */
  daemonArgs?: readonly string[];
}

export interface SelfCliInvocation {
  executable: string;
  prefixArgs: string[];
}

export function resolveSelfCliInvocation(
  entrypoint: string | undefined = process.argv[1],
): SelfCliInvocation {
  return {
    executable: process.execPath,
    prefixArgs: entrypoint && entrypoint.length > 0 ? [entrypoint] : [],
  };
}

export async function runStart(
  argv: readonly string[] = [],
  options: RunStartOptions = {},
): Promise<number> {
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  try {
    requireExplicitRepoFilter(parseAllowRepoArg(argv));
  } catch (err) {
    write(
      `breeze: start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const home = options.runnerHome ?? parseHome(argv) ?? resolveRunnerHome();
  const breezeDir =
    options.breezeDir ?? process.env.BREEZE_DIR ?? dirname(home);
  const profile = options.profile ?? parseProfile(argv) ?? "default";
  const config = loadBreezeDaemonConfig();

  let identity;
  try {
    identity = resolveDaemonIdentity({ host: config.host });
  } catch (err) {
    write(
      `breeze: start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  // #293: detect a live daemon and refuse to silently no-op. The bootstrap
  // path below is idempotent at the launchd level, but it doesn't update
  // the running process's allow-list — users kept running `breeze start`
  // with a new --allow-repo and seeing no effect. Fail loudly so the user
  // knows to stop first.
  const existingLock = findServiceLock(
    `${home}/locks`,
    {
      host: config.host,
      login: identity.login,
      scopes: [],
      gitProtocol: "",
    },
    profile,
  );
  if (existingLock && !isLockStale(existingLock)) {
    const stopCmd = formatStopCommand({
      home: options.runnerHome ?? parseHome(argv),
      profile: options.profile ?? parseProfile(argv),
    });
    write(
      `breeze: daemon already running (pid ${existingLock.pid}).`,
    );
    write(
      "  The live daemon's --allow-repo list is baked in at start time and",
    );
    write(
      "  will not update if you edit ~/.breeze/config.yaml or re-run `start`.",
    );
    write(
      `  Run \`${stopCmd}\` first, then re-run \`start\` with the`,
    );
    write("  full --allow-repo csv.");
    return 1;
  }

  const logsDir = join(home, "logs");
  mkdirSync(logsDir, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1_000);
  const logPath = join(logsDir, `breeze-daemon-${nowSec}.log`);

  const self = resolveSelfCliInvocation(options.entrypoint);
  const executable = options.executable ?? self.executable;
  const daemonArgs =
    options.daemonArgs ??
    defaultDaemonArgs(argv, options.executable ? [] : self.prefixArgs);

  if (supportsLaunchd()) {
    try {
      const result = bootstrapLaunchdJob({
        runnerHome: home,
        login: identity.login,
        profile,
        executable,
        arguments: daemonArgs,
        logPath,
        env: {
          BREEZE_DIR: breezeDir,
          BREEZE_HOME: home,
        },
      });
      write("breeze-daemon started in background via launchd");
      write(`plist: ${result.plistPath}`);
      write(`log: ${logPath}`);
      write(`label: ${result.label}`);
      return 0;
    } catch (err) {
      write(
        `breeze: launchd bootstrap failed (${err instanceof Error ? err.message : String(err)}), falling back to detached spawn`,
      );
    }
  }

  // Fallback: detached spawn with stdout + stderr redirected.
  const logFd = openSync(logPath, "a");
  const child = spawn(executable, daemonArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  if (!child.pid) {
    write("breeze: failed to spawn detached daemon process");
    return 1;
  }
  write("breeze-daemon started via detached spawn");
  write(`pid: ${child.pid}`);
  write(`log: ${logPath}`);
  return 0;
}

/**
 * Build the `breeze stop` suggestion shown when we refuse to start
 * because a live daemon is already running. If the current invocation
 * resolved a non-default `--home`/`--profile`, surface those flags so
 * the user targets the same runner instead of silently stopping the
 * default one.
 */
function formatStopCommand(opts: {
  home?: string;
  profile?: string;
}): string {
  const parts = ["first-tree breeze stop"];
  if (opts.home) parts.push(`--home ${shellQuote(opts.home)}`);
  if (opts.profile && opts.profile !== "default") {
    parts.push(`--profile ${shellQuote(opts.profile)}`);
  }
  return parts.join(" ");
}

function shellQuote(v: string): string {
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

function parseHome(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--home") return argv[i + 1];
    if (a?.startsWith("--home=")) return a.slice("--home=".length);
  }
  return undefined;
}

function parseProfile(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") return argv[i + 1];
    if (a?.startsWith("--profile=")) return a.slice("--profile=".length);
  }
  return undefined;
}

/**
 * Build the forwarded argv for the background daemon. The incoming
 * `start` argv may contain flags like `--allow-repo` that we pass
 * through to the foreground daemon entrypoint. We also drop
 * `--home`/`--profile` because those are interpreted by this command
 * and may differ from the daemon's own resolution.
 */
export function defaultDaemonArgs(
  argv: readonly string[],
  prefixArgs: readonly string[] = [],
): string[] {
  // The ported daemon entrypoint is `first-tree breeze daemon --backend=ts`.
  const forwarded: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--home" || a === "--profile") {
      // Skip flag + value.
      i += 1;
      continue;
    }
    if (a.startsWith("--home=") || a.startsWith("--profile=")) continue;
    forwarded.push(a);
  }
  return [...prefixArgs, "breeze", "daemon", "--backend=ts", ...forwarded];
}
