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
   * When true, `sync-sweep` invokes `gardener sync --apply` (open tree
   * PRs). When false, it stays in detect-only mode.
   */
  syncApply: boolean;
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
  const syncApply = raw.syncApply === true;
  return {
    treePath,
    codeRepos,
    gardenerIntervalMs,
    syncIntervalMs,
    mergedLookbackSeconds,
    assignOwners,
    syncApply,
  };
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
  syncApply?: boolean;
}): GardenerDaemonConfig {
  const gardenerIntervalMs = opts.gardenerIntervalMs ?? DEFAULT_GARDENER_INTERVAL_MS;
  const syncIntervalMs = opts.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const resolvedTree = resolve(opts.treePath);
  return {
    treePath: resolvedTree,
    codeRepos: [...opts.codeRepos],
    gardenerIntervalMs,
    syncIntervalMs,
    mergedLookbackSeconds:
      opts.mergedLookbackSeconds ??
      Math.max(60, Math.round((gardenerIntervalMs * 2) / 1000)),
    assignOwners: opts.assignOwners ?? false,
    syncApply: opts.syncApply ?? false,
  };
}
