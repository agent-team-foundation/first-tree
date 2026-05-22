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

import { loadGitHubScanDaemonConfig } from "../runtime/config.js";
import { parseAllowRepoArg, requireExplicitRepoFilter } from "../runtime/allow-repo.js";
import { findServiceLock, isLockStale } from "../daemon/claim.js";
import { resolveDaemonIdentity } from "../daemon/identity.js";
import { bootstrapLaunchdJob, supportsLaunchd } from "../daemon/launchd.js";
import { resolveRunnerHome } from "../daemon/runner-skeleton.js";

export interface RunStartOptions {
  write?: (line: string) => void;
  githubScanDir?: string;
  runnerHome?: string;
  profile?: string;
  /** CLI executable. Defaults to the current Node binary. */
  executable?: string;
  /** CLI script path when re-invoking via `node <script> ...`. */
  entrypoint?: string;
  /** Args after the executable (forwarded to the daemon). */
  daemonArgs?: readonly string[];
  /**
   * Working directory the launchd job should `cd` into. Defaults to
   * `process.cwd()` captured when `runStart` runs. Mostly an injection
   * seam for tests — production callers should let this default.
   */
  workingDirectory?: string;
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

// oxlint-disable-next-line complexity
export async function runStart(
  argv: readonly string[] = [],
  options: RunStartOptions = {},
): Promise<number> {
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  try {
    requireExplicitRepoFilter(parseAllowRepoArg(argv));
  } catch (err) {
    write(`github-scan: start failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const home = options.runnerHome ?? parseHome(argv) ?? resolveRunnerHome();
  const githubScanDir = options.githubScanDir ?? process.env.GITHUB_SCAN_DIR ?? dirname(home);
  const profile = options.profile ?? parseProfile(argv) ?? "default";
  const config = loadGitHubScanDaemonConfig();

  let identity;
  try {
    identity = resolveDaemonIdentity({ host: config.host });
  } catch (err) {
    write(`github-scan: start failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // #293: detect a live daemon and refuse to silently no-op. The bootstrap
  // path below is idempotent at the launchd level, but it doesn't update
  // the running process's allow-list — users kept running
  // `first-tree github scan start`
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
    write(`github-scan: daemon already running (pid ${existingLock.pid}).`);
    write("  The live daemon's --allow-repo list is baked in at start time and");
    write("  will not update if you edit ~/.first-tree/github-scan/config.yaml or re-run `start`.");
    write(`  Run \`${stopCmd}\` first, then re-run \`start\` with the`);
    write("  full --allow-repo csv.");
    return 1;
  }

  const logsDir = join(home, "logs");
  mkdirSync(logsDir, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1_000);
  const logPath = join(logsDir, `github-scan-daemon-${nowSec}.log`);

  const self = resolveSelfCliInvocation(options.entrypoint);
  const executable = options.executable ?? self.executable;
  const daemonArgs =
    options.daemonArgs ?? defaultDaemonArgs(argv, options.executable ? [] : self.prefixArgs);

  // Capture cwd eagerly (before any other logic might chdir).
  // launchd otherwise spawns the daemon from `/`, which fails the
  // bound-tree check in the daemon's startup. See #380.
  const workingDirectory = options.workingDirectory ?? process.cwd();

  if (supportsLaunchd()) {
    try {
      const result = bootstrapLaunchdJob({
        runnerHome: home,
        login: identity.login,
        profile,
        executable,
        arguments: daemonArgs,
        logPath,
        workingDirectory,
        env: {
          GITHUB_SCAN_DIR: githubScanDir,
          GITHUB_SCAN_HOME: home,
        },
      });
      write("github-scan-daemon started in background via launchd");
      write(`plist: ${result.plistPath}`);
      write(`log: ${logPath}`);
      write(`label: ${result.label}`);
      return 0;
    } catch (err) {
      write(
        `github-scan: launchd bootstrap failed (${err instanceof Error ? err.message : String(err)}), falling back to detached spawn`,
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
    write("github-scan: failed to spawn detached daemon process");
    return 1;
  }
  write("github-scan-daemon started via detached spawn");
  write(`pid: ${child.pid}`);
  write(`log: ${logPath}`);
  return 0;
}

/**
 * Build the `first-tree github scan stop` suggestion shown when we refuse to start
 * because a live daemon is already running. If the current invocation
 * resolved a non-default `--home`/`--profile`, surface those flags so
 * the user targets the same runner instead of silently stopping the
 * default one.
 */
function formatStopCommand(opts: { home?: string; profile?: string }): string {
  const parts = ["first-tree github scan stop"];
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
 *
 * When `--tree-repo` was supplied to the foreground `start` invocation,
 * the umbrella CLI strips it from argv and surfaces it via the
 * `FIRST_TREE_GITHUB_SCAN_TREE_REPO` env var. The launchd-spawned
 * daemon does not inherit that env var (and even if it did, the
 * umbrella's own binding gate doesn't consult it — it re-parses
 * `--tree-repo` from argv), so the spawned daemon would fail the
 * bound-tree check. Re-inject `--tree-repo` into the daemon argv so the
 * background process re-runs the same binding resolution the foreground
 * process did. See #380 round 2.
 */
export function defaultDaemonArgs(
  argv: readonly string[],
  prefixArgs: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // The daemon is re-entered through the umbrella CLI as
  // `first-tree github scan daemon --backend=ts`.
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
  const treeRepoBinding = env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
  const treeRepoArgs =
    treeRepoBinding && treeRepoBinding.length > 0 ? ["--tree-repo", treeRepoBinding] : [];
  return [...prefixArgs, "github", "scan", "daemon", "--backend=ts", ...treeRepoArgs, ...forwarded];
}
