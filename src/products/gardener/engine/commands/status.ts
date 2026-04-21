/**
 * `first-tree gardener status` — print the last-run summary and the
 * currently-configured schedule. Pure read operation; never mutates.
 */

import { loadDaemonConfig } from "../daemon/config.js";
import { loadDaemonState } from "../daemon/state.js";

export const STATUS_USAGE = `usage: first-tree gardener status

Print gardener daemon state:
  - whether a daemon process is recorded as running (pid + uptime)
  - the current sweep schedule (from ~/.gardener/config.json)
  - the last run time, outcome, and summary for each sweep
  - the projected next run time per sweep
`;

export interface RunStatusOptions {
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export async function runStatus(
  argv: readonly string[] = [],
  options: RunStatusOptions = {},
): Promise<number> {
  const write = options.write ?? ((line) => process.stdout.write(line + "\n"));
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());

  if (argv.includes("--help") || argv.includes("-h")) {
    write(STATUS_USAGE);
    return 0;
  }

  const config = loadDaemonConfig(env);
  const state = loadDaemonState(env);

  write("gardener daemon status");
  if (state.pid !== undefined) {
    const uptimeSec = state.startedAt
      ? Math.max(0, Math.round((now() - state.startedAt) / 1000))
      : undefined;
    write(`  pid:       ${state.pid}${uptimeSec !== undefined ? ` (uptime ${uptimeSec}s)` : ""}`);
  } else {
    write("  pid:       <not running>");
  }

  if (!config) {
    write("  config:    <missing — run `gardener start` to create>");
    return 0;
  }

  write(`  tree-path: ${config.treePath}`);
  write(`  code-repos: ${config.codeRepos.join(", ") || "<none>"}`);
  write(
    `  gardener-interval: ${config.gardenerIntervalMs / 1000}s   sync-interval: ${config.syncIntervalMs / 1000}s`,
  );

  const sweeps: Array<[keyof typeof state.sweeps, number]> = [
    ["gardener", config.gardenerIntervalMs],
    ["sync", config.syncIntervalMs],
  ];
  for (const [name, interval] of sweeps) {
    const record = state.sweeps[name];
    if (!record) {
      write(`  ${name}-sweep: <never run> (next: as soon as daemon picks it up)`);
      continue;
    }
    const ago = Math.max(0, now() - record.lastRunAt);
    const nextInMs = Math.max(0, interval - ago);
    write(
      `  ${name}-sweep: last ${record.outcome} ${formatAgo(ago)} — ${record.summary || "(no summary)"}; next in ${formatRemaining(nextInMs)}`,
    );
  }
  return 0;
}

function formatAgo(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "now";
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.ceil(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.ceil(min / 60);
  return `${hr}h`;
}
