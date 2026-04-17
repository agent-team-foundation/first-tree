/**
 * TS port of `Service::start_background` in `service.rs:255-349`.
 *
 * Brings up a detached daemon process. On macOS (with `launchctl`
 * available) we write a LaunchAgent plist and kickstart it. Elsewhere
 * we fall back to `spawn(... detached: true)` with stdout redirected.
 */

import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { loadBreezeDaemonConfig } from "../core/config.js";
import { resolveDaemonIdentity } from "../daemon/identity.js";
import {
  bootstrapLaunchdJob,
  supportsLaunchd,
} from "../daemon/launchd.js";
import { resolveRunnerHome } from "../daemon/runner-skeleton.js";

export interface RunStartOptions {
  write?: (line: string) => void;
  runnerHome?: string;
  profile?: string;
  /** CLI entrypoint. Defaults to `process.execPath` (node) + first-tree bin. */
  executable?: string;
  /** Args after the executable (forwarded to the daemon). */
  daemonArgs?: readonly string[];
}

export async function runStart(
  argv: readonly string[] = [],
  options: RunStartOptions = {},
): Promise<number> {
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const home = options.runnerHome ?? parseHome(argv) ?? resolveRunnerHome();
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

  const logsDir = join(home, "logs");
  mkdirSync(logsDir, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1_000);
  const logPath = join(logsDir, `breeze-daemon-${nowSec}.log`);

  const executable = options.executable ?? process.execPath;
  const daemonArgs = options.daemonArgs ?? defaultDaemonArgs(argv);

  if (supportsLaunchd()) {
    try {
      const result = bootstrapLaunchdJob({
        runnerHome: home,
        login: identity.login,
        profile,
        executable,
        arguments: daemonArgs,
        logPath,
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
function defaultDaemonArgs(argv: readonly string[]): string[] {
  // The ported daemon entrypoint is `first-tree breeze daemon --backend=ts`.
  // In the fallback spawn path, executable is process.execPath so we
  // cannot embed the CLI; we assume the caller set `executable` to the
  // `first-tree` bin. See RunStartOptions.
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
  return ["breeze", "daemon", "--backend=ts", ...forwarded];
}
