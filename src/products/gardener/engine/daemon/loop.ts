/**
 * Gardener daemon main loop.
 *
 * Tick every ~30 s. On each tick:
 *   1. Load config + state from `~/.gardener/`.
 *   2. For each sweep (`gardener-sweep`, `sync-sweep`), check if
 *      `now - lastRun >= interval`. If so, run it.
 *   3. Persist the outcome back to `state.json`.
 *
 * Sweeps are run **serially** — we never overlap two long-running
 * subprocess invocations from the same daemon. Gardener sweep runs
 * `first-tree gardener comment --merged-since <lookback> --assign-owners?`
 * pointed at the configured tree path and target_repos list. Sync
 * sweep runs `first-tree gardener sync [--apply]` pointed at the same
 * tree path.
 *
 * Subprocess dispatch is deliberately thin: we spawn with inherited
 * stderr/stdout to the daemon log file (caller's responsibility), and
 * parse the last line for the `BREEZE_RESULT: status=…` trailer to
 * populate state.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildDaemonConfig,
  loadDaemonConfig,
  resolveGardenerDir,
  writeDaemonConfig,
  type GardenerDaemonConfig,
} from "./config.js";
import {
  isSweepDue,
  loadDaemonState,
  updateSweepState,
  writeDaemonState,
  type SweepName,
  type SweepOutcome,
} from "./state.js";

export interface LoopDeps {
  /** Wall clock, injected for tests. */
  now?: () => number;
  /** Sleep between ticks. */
  sleep?: (ms: number) => Promise<void>;
  /** Runs a gardener subprocess. */
  runSweep?: (sweep: SweepName, config: GardenerDaemonConfig) => Promise<{
    outcome: SweepOutcome;
    summary: string;
  }>;
  /** If set, loop exits after this many ticks (for tests). */
  maxTicks?: number;
  /** Override for ~/.gardener root. */
  env?: NodeJS.ProcessEnv;
  write?: (line: string) => void;
}

export const DEFAULT_TICK_MS = 30 * 1000;

export async function runDaemonLoop(
  deps: LoopDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const env = deps.env ?? process.env;
  const write = deps.write ?? ((line) => process.stdout.write(line + "\n"));
  const runSweep = deps.runSweep ?? defaultRunSweep;

  writeLogLine(env, `gardener daemon started pid=${process.pid}`);

  // Stamp PID + start time into state so `gardener status` can report.
  const initial = loadDaemonState(env);
  writeDaemonState(
    { ...initial, pid: process.pid, startedAt: now() },
    env,
  );

  let tick = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    tick += 1;
    if (deps.maxTicks !== undefined && tick > deps.maxTicks) break;

    const config = loadDaemonConfig(env);
    if (!config) {
      writeLogLine(env, `tick ${tick}: no config at ~/.gardener/config.json, idling`);
      await sleep(DEFAULT_TICK_MS);
      continue;
    }

    const state = loadDaemonState(env);
    const current = now();

    const schedule: Array<{ name: SweepName; intervalMs: number }> = [
      { name: "gardener", intervalMs: config.gardenerIntervalMs },
      { name: "sync", intervalMs: config.syncIntervalMs },
    ];

    for (const entry of schedule) {
      if (!isSweepDue(state, entry.name, entry.intervalMs, current)) continue;
      writeLogLine(env, `tick ${tick}: ${entry.name}-sweep due, running`);
      write(`gardener daemon: running ${entry.name}-sweep`);
      const result = await runSweep(entry.name, config);
      updateSweepState(env, entry.name, {
        lastRunAt: now(),
        outcome: result.outcome,
        summary: result.summary,
      });
      writeLogLine(
        env,
        `tick ${tick}: ${entry.name}-sweep ${result.outcome} — ${result.summary}`,
      );
    }

    await sleep(DEFAULT_TICK_MS);
  }
}

async function defaultRunSweep(
  sweep: SweepName,
  config: GardenerDaemonConfig,
): Promise<{ outcome: SweepOutcome; summary: string }> {
  const args = sweep === "gardener"
    ? buildGardenerSweepArgs(config)
    : buildSyncSweepArgs(config);
  return invokeCli(args, config.treePath);
}

export function buildGardenerSweepArgs(
  config: GardenerDaemonConfig,
): string[] {
  const args = [
    "gardener",
    "comment",
    "--tree-path",
    config.treePath,
    "--merged-since",
    `${config.mergedLookbackSeconds}s`,
  ];
  if (config.assignOwners) args.push("--assign-owners");
  return args;
}

export function buildSyncSweepArgs(
  config: GardenerDaemonConfig,
): string[] {
  const args = ["gardener", "sync", "--tree-path", config.treePath];
  if (config.syncApply) args.push("--apply");
  return args;
}

async function invokeCli(
  args: string[],
  cwd: string,
): Promise<{ outcome: SweepOutcome; summary: string }> {
  return new Promise((resolveFn) => {
    const entrypoint = process.argv[1];
    const argv = entrypoint ? [entrypoint, ...args] : args;
    const child = spawn(process.execPath, argv, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      const trailer = parseBreezeResult(stdout);
      const outcome: SweepOutcome = trailer?.status ??
        (code === 0 ? "handled" : "failed");
      const summary = trailer?.summary ??
        (code === 0
          ? `exit=0 no BREEZE_RESULT trailer`
          : `exit=${code} ${stderr.slice(0, 200)}`);
      resolveFn({ outcome, summary });
    });
    child.on("error", (err) => {
      resolveFn({
        outcome: "failed",
        summary: `spawn error: ${err.message}`,
      });
    });
  });
}

export function parseBreezeResult(
  stdout: string,
): { status: SweepOutcome; summary: string } | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(
      /^BREEZE_RESULT:\s+status=(handled|skipped|failed)\s+summary=(.*?)(?:\s+[a-z_]+=.*)?$/,
    );
    if (match) {
      return { status: match[1] as SweepOutcome, summary: match[2].trim() };
    }
  }
  return null;
}

function logPath(env: NodeJS.ProcessEnv): string {
  return join(resolveGardenerDir(env), "daemon.log");
}

function writeLogLine(env: NodeJS.ProcessEnv, line: string): void {
  const path = logPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const stamp = new Date().toISOString();
  const text = `${stamp} ${line}\n`;
  try {
    writeFileSync(path, text, { flag: "a" });
  } catch {
    // Best-effort logging — don't blow up the loop on I/O issues.
  }
}

/**
 * One-shot: run both sweeps exactly once, return outcome per sweep.
 * Used by `gardener run-once` to exercise the daemon pipeline without
 * starting a background process.
 */
export async function runOnce(
  deps: {
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    write?: (line: string) => void;
    runSweep?: LoopDeps["runSweep"];
  } = {},
): Promise<{ gardener?: { outcome: SweepOutcome; summary: string }; sync?: { outcome: SweepOutcome; summary: string } }> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const write = deps.write ?? ((line) => process.stdout.write(line + "\n"));
  const runSweep = deps.runSweep ?? defaultRunSweep;
  const config = loadDaemonConfig(env);
  if (!config) {
    write(
      "gardener run-once: no config at ~/.gardener/config.json — run `gardener start` first, or set $GARDENER_DIR",
    );
    return {};
  }
  const results: {
    gardener?: { outcome: SweepOutcome; summary: string };
    sync?: { outcome: SweepOutcome; summary: string };
  } = {};
  for (const sweep of ["gardener", "sync"] as const) {
    write(`gardener run-once: running ${sweep}-sweep`);
    const result = await runSweep(sweep, config);
    updateSweepState(env, sweep, {
      lastRunAt: now(),
      outcome: result.outcome,
      summary: result.summary,
    });
    results[sweep] = result;
    write(`gardener run-once: ${sweep}-sweep ${result.outcome} — ${result.summary}`);
  }
  return results;
}

/**
 * Builders re-exported for tests and start-command previews — the
 * caller's CLI asks "what would the daemon actually invoke?" and shows
 * that in the start summary.
 */
export { buildDaemonConfig, writeDaemonConfig, resolve };
