/**
 * TS port of `Service::doctor` in
 * `service.rs:107-143`.
 *
 * Prints a one-screen diagnostic of the daemon's local environment.
 * Designed for `first-tree breeze doctor` — no subprocesses the user
 * isn't already running.
 */

import { existsSync, mkdirSync } from "node:fs";

import { loadBreezeDaemonConfig } from "../runtime/config.js";
import {
  identityHasRequiredScope,
  resolveDaemonIdentity,
} from "../daemon/identity.js";
import {
  findServiceLock,
  isLockStale,
  type LockInfo,
} from "../daemon/claim.js";
import { RepoFilter } from "../runtime/repo-filter.js";
import {
  detectAvailableAgents,
  findExecutable,
  resolveRunnerHome,
} from "../daemon/runner-skeleton.js";
import { ThreadStore } from "../daemon/thread-store.js";

export interface RunDoctorOptions {
  write?: (line: string) => void;
  runnerHome?: string;
  allowRepo?: string;
}

/**
 * Parse the minimal flags doctor accepts (`--home`, `--allow-repo`).
 * Unknown flags are ignored to stay forward-compatible.
 */
export function parseDoctorArgs(argv: readonly string[]): {
  home?: string;
  allowRepo?: string;
} {
  const out: { home?: string; allowRepo?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--home") out.home = argv[++i];
    else if (a?.startsWith("--home=")) out.home = a.slice("--home=".length);
    else if (a === "--allow-repo") out.allowRepo = argv[++i];
    else if (a?.startsWith("--allow-repo="))
      out.allowRepo = a.slice("--allow-repo=".length);
  }
  return out;
}

export async function runDoctor(
  argv: readonly string[] = [],
  options: RunDoctorOptions = {},
): Promise<number> {
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const parsed = parseDoctorArgs(argv);
  const home = options.runnerHome ?? parsed.home ?? resolveRunnerHome();
  mkdirSync(home, { recursive: true });
  const config = loadBreezeDaemonConfig();
  const repoFilter = parsed.allowRepo ?? options.allowRepo;
  const filter =
    repoFilter && repoFilter.length > 0
      ? RepoFilter.parseCsv(repoFilter)
      : RepoFilter.empty();

  let identityLine: string;
  let scopeLine: string;
  let gitProtocol: string;
  let scopes: string;
  try {
    const identity = resolveDaemonIdentity({ host: config.host });
    identityLine = `${identity.login}@${identity.host}`;
    gitProtocol = identity.gitProtocol;
    scopes = identity.scopes.length > 0 ? identity.scopes.join(",") : "(none)";
    scopeLine = identityHasRequiredScope(identity)
      ? "ok"
      : "missing repo/notifications";
  } catch (err) {
    identityLine = "unknown";
    gitProtocol = "unknown";
    scopes = "unknown";
    scopeLine = `identity resolution failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const lock = findServiceLock(
    `${home}/locks`,
    { host: config.host, login: identityLine.split("@")[0] ?? "", scopes: [], gitProtocol },
    "default",
  );
  const store = new ThreadStore({ runnerHome: home });
  const agents = detectAvailableAgents();

  write("breeze-runner doctor");
  write(`home: ${home}`);
  write(`host: ${config.host}`);
  write(`login: ${identityLine}`);
  write(
    `allowed repos: ${filter.isEmpty() ? "all" : filter.displayPatterns()}`,
  );
  write(`git protocol: ${gitProtocol}`);
  write(`scopes: ${scopes}`);
  write(`lock: ${formatLockState(lock)}`);
  write(
    `agents: ${agents.length > 0 ? agents.map((r) => r.kind).join(", ") : "(none)"}`,
  );
  write(`gh binary: ${findExecutable("gh") ?? "(missing)"}`);
  write(`required auth scope: ${scopeLine}`);
  write(
    `runtime status file: ${existsSync(store.runtimePath) ? "present" : "missing"}`,
  );
  return 0;
}

function formatLockState(lock: LockInfo | null): string {
  if (!lock) return "absent";
  return isLockStale(lock) ? "stale" : "present";
}
