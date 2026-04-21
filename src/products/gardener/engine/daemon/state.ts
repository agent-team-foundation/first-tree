/**
 * Gardener daemon persisted runtime state.
 *
 * `~/.gardener/state.json` records the last-run timestamp of each
 * sweep, the current daemon PID (when one is running), and the exit
 * status of the most recent sweep invocations. Read by `gardener
 * status` for diagnostics and by the loop itself to decide when a
 * sweep is due.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveGardenerDir } from "./config.js";

export type SweepName = "gardener" | "sync";
export type SweepOutcome = "handled" | "skipped" | "failed";

export interface SweepRecord {
  /** Unix epoch ms of the last completed run. */
  lastRunAt: number;
  /** Outcome of the last completed run. */
  outcome: SweepOutcome;
  /** Short human-readable summary from the subprocess. */
  summary: string;
}

export interface DaemonState {
  /** OS PID of the running daemon; undefined when stopped. */
  pid?: number;
  /** Unix epoch ms when the current daemon process started. */
  startedAt?: number;
  /** Most recent outcome per sweep. */
  sweeps: Partial<Record<SweepName, SweepRecord>>;
}

export function statePath(env?: NodeJS.ProcessEnv): string {
  return join(resolveGardenerDir(env), "state.json");
}

export function loadDaemonState(env?: NodeJS.ProcessEnv): DaemonState {
  const path = statePath(env);
  if (!existsSync(path)) return { sweeps: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const sweepsRaw =
      raw.sweeps && typeof raw.sweeps === "object" && !Array.isArray(raw.sweeps)
        ? (raw.sweeps as Record<string, unknown>)
        : {};
    const sweeps: DaemonState["sweeps"] = {};
    for (const key of ["gardener", "sync"] as const) {
      const entry = sweepsRaw[key];
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.lastRunAt !== "number") continue;
      const outcome =
        record.outcome === "handled" ||
        record.outcome === "skipped" ||
        record.outcome === "failed"
          ? record.outcome
          : "skipped";
      const summary = typeof record.summary === "string" ? record.summary : "";
      sweeps[key] = {
        lastRunAt: record.lastRunAt,
        outcome,
        summary,
      };
    }
    return {
      pid: typeof raw.pid === "number" ? raw.pid : undefined,
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : undefined,
      sweeps,
    };
  } catch {
    return { sweeps: {} };
  }
}

export function writeDaemonState(
  state: DaemonState,
  env?: NodeJS.ProcessEnv,
): string {
  const path = statePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
  return path;
}

export function updateSweepState(
  env: NodeJS.ProcessEnv | undefined,
  sweep: SweepName,
  record: SweepRecord,
): DaemonState {
  const current = loadDaemonState(env);
  const next: DaemonState = {
    ...current,
    sweeps: { ...current.sweeps, [sweep]: record },
  };
  writeDaemonState(next, env);
  return next;
}

/**
 * Compute whether a sweep is due. A sweep is due when it has never
 * run, or when `now - lastRunAt >= intervalMs`. Used both by the loop
 * (to decide what to execute next) and by `status` (to project next
 * run times).
 */
export function isSweepDue(
  state: DaemonState,
  sweep: SweepName,
  intervalMs: number,
  now: number,
): boolean {
  const last = state.sweeps[sweep]?.lastRunAt;
  if (last === undefined) return true;
  return now - last >= intervalMs;
}
