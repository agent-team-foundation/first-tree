/**
 * TS port of `Service::status` in `service.rs:145-195`.
 *
 * Prints the current lock + runtime/status.env contents. Intended for
 * `github-scan status`.
 */

import { loadGitHubScanDaemonConfig } from "../runtime/config.js";
import {
  findServiceLock,
  isLockStale,
  type LockInfo,
} from "../daemon/claim.js";
import { resolveDaemonIdentity } from "../daemon/identity.js";
import { RepoFilter } from "../runtime/repo-filter.js";
import { parseAllowRepoArg } from "../runtime/allow-repo.js";
import { resolveRunnerHome } from "../daemon/runner-skeleton.js";
import { ThreadStore } from "../daemon/thread-store.js";

export interface RunStatusOptions {
  write?: (line: string) => void;
  runnerHome?: string;
  allowRepo?: string;
}

const KEYS_TO_SHOW = [
  "last_poll_epoch",
  "active_tasks",
  "queued_tasks",
  "last_note",
  "last_identity",
  "next_search_reconcile_epoch",
  "last_poll_warning",
];

export async function runStatus(
  argv: readonly string[] = [],
  options: RunStatusOptions = {},
): Promise<number> {
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const home = options.runnerHome ?? parseHome(argv) ?? resolveRunnerHome();
  const config = loadGitHubScanDaemonConfig();
  const repoFilterArg = options.allowRepo ?? parseAllowRepoArg(argv);
  const filter =
    repoFilterArg && repoFilterArg.length > 0
      ? RepoFilter.parseCsv(repoFilterArg)
      : RepoFilter.empty();
  const store = new ThreadStore({ runnerHome: home });
  const runtime = store.readRuntimeStatus();

  let identityLabel = "unknown";
  let login = "";
  try {
    const identity = resolveDaemonIdentity({ host: config.host });
    identityLabel = `${identity.login}@${identity.host}`;
    login = identity.login;
  } catch {
    /* fall through */
  }
  const lock = findServiceLock(
    `${home}/locks`,
    { host: config.host, login, scopes: [], gitProtocol: "" },
    "default",
  );

  write("github-scan-runner status");
  write(`identity: ${identityLabel}`);
  write(
    `allowed repos: ${formatAllowedRepos(filter, runtime.get("allowed_repos"))}`,
  );
  write(`lock: ${formatLock(lock)}`);
  if (runtime.size === 0) {
    write("runtime: no status recorded yet");
  } else {
    for (const key of KEYS_TO_SHOW) {
      const value = runtime.get(key);
      if (value !== undefined) write(`${key}: ${value}`);
    }
  }
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

function formatAllowedRepos(
  filter: RepoFilter,
  runtimeValue: string | undefined,
): string {
  if (!filter.isEmpty()) return filter.displayPatterns();
  if (runtimeValue && runtimeValue.length > 0) return runtimeValue;
  return "all";
}

function formatLock(lock: LockInfo | null): string {
  if (!lock) return "not running";
  const state = isLockStale(lock) ? "stale" : "running";
  return `${state} pid=${lock.pid} heartbeat=${lock.heartbeat_epoch} active_tasks=${lock.active_tasks} note=${lock.note}`;
}
