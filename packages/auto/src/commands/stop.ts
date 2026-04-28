/**
 * TS port of `Service::stop` in `service.rs:231-245`.
 *
 * Stops any launchd-backed background daemon, then removes the stale
 * lock dir (if any) and sends `kill <pid>` to the live process.
 */

import { spawnSync } from "node:child_process";

import { loadAutoDaemonConfig } from "../runtime/config.js";
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
  const config = loadAutoDaemonConfig();

  let identity;
  try {
    identity = resolveDaemonIdentity({ host: config.host });
  } catch (err) {
    write(
      `auto: could not resolve identity to stop the runner: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (supportsLaunchd()) {
    stopLaunchdJob(home, identity.login, profile);
  }

  const locksDir = `${home}/locks`;
  const lock = findServiceLock(locksDir, identity, profile);
  if (!lock) {
    write("auto: no running auto-runner for the active identity");
    return 0;
  }

  if (isLockStale(lock)) {
    const dir = serviceLockDir(locksDir, identity, profile);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    write(`removed stale auto-runner lock for pid ${lock.pid}`);
    return 0;
  }

  const code = killProcess(lock);
  if (code !== 0) {
    write(`auto: kill ${lock.pid} failed (exit ${code})`);
    return 1;
  }
  const stopped = await waitForStop(lock.pid);
  if (!stopped) {
    write(`auto: pid ${lock.pid} did not exit after SIGTERM; forcing stop`);
    const killCode = killProcess(lock, "-KILL");
    if (killCode !== 0) {
      write(`auto: kill -KILL ${lock.pid} failed (exit ${killCode})`);
      return 1;
    }
    if (!(await waitForStop(lock.pid, 1_000))) {
      write(`auto: pid ${lock.pid} is still alive after SIGKILL`);
      return 1;
    }
  }
  const dir = serviceLockDir(locksDir, identity, profile);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  write(`stopped auto-runner pid ${lock.pid}`);
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

function killProcess(lock: LockInfo, signal: "-TERM" | "-KILL" = "-TERM"): number {
  const result = spawnSync("kill", [signal, String(lock.pid)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status ?? 1;
}

function processAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForStop(pid: number, timeoutMs: number = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processAlive(pid);
}
