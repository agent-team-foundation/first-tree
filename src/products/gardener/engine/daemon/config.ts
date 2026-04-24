/**
 * Gardener daemon persisted configuration.
 *
 * Written by `first-tree gardener start` into `~/.gardener/config.json`
 * (overridable via `$GARDENER_DIR`). The daemon loop reads it on each
 * tick so a restart inherits the exact schedule + repo set the user
 * originally passed.
 *
 * Intentionally minimal: this is not a general scheduler, it's a
 * two-sweep state file (`gardener-sweep`, `sync-sweep`). Anything more
 * complex belongs in a proper scheduler, not here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * What the sync-sweep should do on each tick.
 *
 * - `detect` (default): run `gardener sync` only; report drift, no writes.
 * - `apply`: run `gardener sync --apply`; open one aggregated tree PR.
 * - `open-issues`: run `gardener sync --open-issues`; open one tree
 *   issue per drift proposal, assignees resolved from NODE.md owners
 *   unless overridden by `syncAssignee`.
 *
 * Modes are mutually exclusive by construction. The legacy boolean
 * `syncApply` is kept in the on-disk schema as a deprecated alias
 * that coerces to `syncMode: 'apply'`.
 */
export type SyncMode = "detect" | "apply" | "open-issues";

export interface GardenerDaemonConfig {
  /** Absolute path to the bound tree repo checkout. */
  treePath: string;
  /** Source repos to sweep on each gardener-sweep tick (`owner/name`). */
  codeRepos: string[];
  /** Milliseconds between gardener-sweep ticks. */
  gardenerIntervalMs: number;
  /** Milliseconds between sync-sweep ticks. */
  syncIntervalMs: number;
  /**
   * Lookback window (seconds) passed as `--merged-since` to gardener
   * comment on each sweep. Defaults to 2× `gardenerIntervalMs` so we
   * don't miss merges that happen between ticks.
   */
  mergedLookbackSeconds: number;
  /**
   * When true, pass `--assign-owners` to the gardener-sweep subprocess
   * so merge→tree-issue assigns NODE owners from CODEOWNERS.
   */
  assignOwners: boolean;
  /**
   * How the sync-sweep runs — see {@link SyncMode}. Replaces the older
   * `syncApply: boolean` which is retained only as a read-time alias
   * for back-compat with configs written by earlier versions.
   */
  syncMode: SyncMode;
  /**
   * Optional override for every issue opened in `syncMode: "open-issues"`.
   * When set, all issues are assigned to this user instead of NODE.md
   * owners. Intended for testing against third-party repos where you
   * don't want to ping real domain owners. Ignored unless
   * `syncMode === "open-issues"`.
   */
  syncAssignee?: string;
}

export function resolveGardenerDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.GARDENER_DIR ?? join(homedir(), ".gardener");
}

export function configPath(env?: NodeJS.ProcessEnv): string {
  return join(resolveGardenerDir(env), "config.json");
}

const DEFAULT_GARDENER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function loadDaemonConfig(
  env?: NodeJS.ProcessEnv,
): GardenerDaemonConfig | null {
  const path = configPath(env);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return coerceDaemonConfig(raw);
  } catch {
    return null;
  }
}

export function writeDaemonConfig(
  config: GardenerDaemonConfig,
  env?: NodeJS.ProcessEnv,
): string {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}

function coerceDaemonConfig(raw: Record<string, unknown>): GardenerDaemonConfig {
  const treePath = typeof raw.treePath === "string" ? raw.treePath : "";
  const codeRepos = Array.isArray(raw.codeRepos)
    ? raw.codeRepos.filter((x): x is string => typeof x === "string")
    : [];
  const gardenerIntervalMs =
    typeof raw.gardenerIntervalMs === "number" && raw.gardenerIntervalMs > 0
      ? raw.gardenerIntervalMs
      : DEFAULT_GARDENER_INTERVAL_MS;
  const syncIntervalMs =
    typeof raw.syncIntervalMs === "number" && raw.syncIntervalMs > 0
      ? raw.syncIntervalMs
      : DEFAULT_SYNC_INTERVAL_MS;
  const mergedLookbackSeconds =
    typeof raw.mergedLookbackSeconds === "number" &&
    raw.mergedLookbackSeconds > 0
      ? raw.mergedLookbackSeconds
      : Math.max(60, Math.round((gardenerIntervalMs * 2) / 1000));
  const assignOwners = raw.assignOwners === true;
  const syncMode = coerceSyncMode(raw);
  const syncAssignee =
    typeof raw.syncAssignee === "string" && raw.syncAssignee.length > 0
      ? raw.syncAssignee
      : undefined;
  return {
    treePath,
    codeRepos,
    gardenerIntervalMs,
    syncIntervalMs,
    mergedLookbackSeconds,
    assignOwners,
    syncMode,
    ...(syncAssignee ? { syncAssignee } : {}),
  };
}

/**
 * Read `syncMode` from raw config, falling back to the legacy
 * `syncApply: boolean` alias for configs written by pre-enum versions.
 * Unknown string values collapse to `"detect"` (safe default).
 */
function coerceSyncMode(raw: Record<string, unknown>): SyncMode {
  const mode = raw.syncMode;
  if (mode === "detect" || mode === "apply" || mode === "open-issues") {
    return mode;
  }
  if (raw.syncApply === true) return "apply";
  return "detect";
}

/**
 * Parse a `<n><unit>` duration string into milliseconds. Accepts
 * `m`/`h`/`d`, plus bare integers interpreted as seconds for shell
 * ergonomics (the daemon never encodes sub-second timing). Returns
 * null on unparseable input so callers can render a clear error.
 */
export function parseDurationMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const match = trimmed.match(/^(\d+)\s*([smhd]?)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  if (unit === "s" || unit === "") return amount * 1000;
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  if (unit === "d") return amount * 24 * 60 * 60 * 1000;
  return null;
}

export function buildDaemonConfig(opts: {
  treePath: string;
  codeRepos: readonly string[];
  gardenerIntervalMs?: number;
  syncIntervalMs?: number;
  mergedLookbackSeconds?: number;
  assignOwners?: boolean;
  /**
   * New enum-shaped selector for the sync-sweep mode. Prefer this over
   * the legacy `syncApply` boolean.
   */
  syncMode?: SyncMode;
  /** Optional assignee override, applied only when `syncMode === "open-issues"`. */
  syncAssignee?: string;
  /**
   * @deprecated Pass `syncMode: "apply"` instead. When set to true and
   * `syncMode` is omitted, coerces to `syncMode: "apply"`. When both
   * are set, `syncMode` wins.
   */
  syncApply?: boolean;
}): GardenerDaemonConfig {
  const gardenerIntervalMs = opts.gardenerIntervalMs ?? DEFAULT_GARDENER_INTERVAL_MS;
  const syncIntervalMs = opts.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const resolvedTree = resolve(opts.treePath);
  const syncMode: SyncMode =
    opts.syncMode ?? (opts.syncApply === true ? "apply" : "detect");
  const syncAssignee =
    syncMode === "open-issues" && opts.syncAssignee && opts.syncAssignee.length > 0
      ? opts.syncAssignee
      : undefined;
  return {
    treePath: resolvedTree,
    codeRepos: [...opts.codeRepos],
    gardenerIntervalMs,
    syncIntervalMs,
    mergedLookbackSeconds:
      opts.mergedLookbackSeconds ??
      Math.max(60, Math.round((gardenerIntervalMs * 2) / 1000)),
    assignOwners: opts.assignOwners ?? false,
    syncMode,
    ...(syncAssignee ? { syncAssignee } : {}),
  };
}
