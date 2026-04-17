/**
 * TS port of `Service::stop` in `service.rs:231-245`.
 *
 * Stops any launchd-backed background daemon, then removes the stale
 * lock dir (if any) and sends `kill <pid>` to the live process.
 */

import { spawnSync } from "node:child_process";

import { loadBreezeDaemonConfig } from "../core/config.js";
import { resolveDaemonIdentity } from "../daemon/identity.js";
import {
  findServiceLock,
  isLockStale,
  serviceLockDir,
  type LockInfo,
} from "../daemon/claim.js";
import { resolveRunnerHome } from "../daemon/runner-skeleton.js";
import { stopLaunchdJob, supportsLaunchd } from "../daemon/launchd.js";
import { rmSync } from "node:fs";

export interface RunStopOptions {
  write?: (line: string) => void;
  runnerHome?: string;
  profile?: string;
}

export async function runStop(
  argv: readonly string[] = [],
  options: RunStopOptions = {},
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
      `breeze: could not resolve identity to stop the runner: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (supportsLaunchd()) {
    stopLaunchdJob(home, identity.login, profile);
  }

  const locksDir = `${home}/locks`;
  const lock = findServiceLock(locksDir, identity, profile);
  if (!lock) {
    write("breeze: no running breeze-runner for the active identity");
    return 0;
  }

  if (isLockStale(lock)) {
    const dir = serviceLockDir(locksDir, identity, profile);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    write(`removed stale breeze-runner lock for pid ${lock.pid}`);
    return 0;
  }

  const code = killProcess(lock);
  if (code === 0) {
    write(`stopped breeze-runner pid ${lock.pid}`);
    return 0;
  }
  write(`breeze: kill ${lock.pid} failed (exit ${code})`);
  return 1;
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

function killProcess(lock: LockInfo): number {
  const result = spawnSync("kill", [String(lock.pid)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status ?? 1;
}
