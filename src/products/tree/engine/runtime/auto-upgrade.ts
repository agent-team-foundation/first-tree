import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { compareFrameworkVersions } from "#products/tree/engine/runtime/upgrader.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_PATH = join(homedir(), ".first-tree", "version-check.json");
const NPM_REGISTRY_URL = "https://registry.npmjs.org/first-tree/latest";
const HTTP_TIMEOUT_MS = 1500;
const PACKAGE_NAME = "first-tree";

export interface VersionCacheEntry {
  checkedAt: number;
  latest: string;
}

export interface AutoUpgradeDeps {
  /** Current CLI version (from bundled package.json). */
  currentVersion: string;
  /** Returns the latest published version, or null if the check failed. */
  fetchLatestVersion: () => Promise<string | null>;
  /** Installs the given version globally; returns true on success. */
  installLatestVersion: (version: string) => boolean;
  /** Reads the persisted cache entry, if any. */
  readCache: () => VersionCacheEntry | null;
  /** Persists the cache entry. */
  writeCache: (entry: VersionCacheEntry) => void;
  /** Current time in ms; injectable for tests. */
  now?: () => number;
}

export interface AutoUpgradeResult {
  /** Whether an upgrade was attempted. */
  attempted: boolean;
  /** Whether the upgrade succeeded (only meaningful when attempted). */
  succeeded: boolean;
  /** The latest version we observed, or null if the check failed. */
  latestVersion: string | null;
  /** Why we did or did not upgrade. */
  reason:
    | "skipped-by-flag"
    | "cache-fresh"
    | "already-latest"
    | "fetch-failed"
    | "install-failed"
    | "upgraded";
}

/**
 * Check for a newer published version of `first-tree` and silently upgrade
 * if one is available. Designed to run on every CLI invocation unless the
 * caller passed `--skip-version-check`.
 *
 * Failures are non-fatal: offline checks, permission errors during install,
 * and registry timeouts all return without throwing. The CLI continues with
 * the currently installed version in those cases.
 */
export async function checkAndAutoUpgrade(
  deps: AutoUpgradeDeps,
): Promise<AutoUpgradeResult> {
  const now = deps.now ?? Date.now;

  // Check cache first
  const cached = deps.readCache();
  if (cached !== null && now() - cached.checkedAt < CACHE_TTL_MS) {
    if (compareFrameworkVersions(cached.latest, deps.currentVersion) <= 0) {
      return {
        attempted: false,
        succeeded: false,
        latestVersion: cached.latest,
        reason: "cache-fresh",
      };
    }
    // Cache says newer is available — skip refetch and go straight to install
    const installed = deps.installLatestVersion(cached.latest);
    if (!installed) {
      return {
        attempted: true,
        succeeded: false,
        latestVersion: cached.latest,
        reason: "install-failed",
      };
    }
    return {
      attempted: true,
      succeeded: true,
      latestVersion: cached.latest,
      reason: "upgraded",
    };
  }

  // Cache stale or missing — hit the registry
  let latest: string | null;
  try {
    latest = await deps.fetchLatestVersion();
  } catch {
    latest = null;
  }
  if (latest === null) {
    return {
      attempted: false,
      succeeded: false,
      latestVersion: null,
      reason: "fetch-failed",
    };
  }

  // Always update the cache so we don't refetch within the TTL
  deps.writeCache({ checkedAt: now(), latest });

  if (compareFrameworkVersions(latest, deps.currentVersion) <= 0) {
    return {
      attempted: false,
      succeeded: false,
      latestVersion: latest,
      reason: "already-latest",
    };
  }

  const installed = deps.installLatestVersion(latest);
  if (!installed) {
    return {
      attempted: true,
      succeeded: false,
      latestVersion: latest,
      reason: "install-failed",
    };
  }

  return {
    attempted: true,
    succeeded: true,
    latestVersion: latest,
    reason: "upgraded",
  };
}

// ---------- Default production implementations ----------

export function defaultReadCache(): VersionCacheEntry | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<VersionCacheEntry>;
    if (
      typeof parsed.checkedAt === "number" &&
      typeof parsed.latest === "string"
    ) {
      return { checkedAt: parsed.checkedAt, latest: parsed.latest };
    }
    return null;
  } catch {
    return null;
  }
}

export function defaultWriteCache(entry: VersionCacheEntry): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(entry));
  } catch {
    // Cache write failures are non-fatal — silently ignore
  }
}

export async function defaultFetchLatestVersion(): Promise<string | null> {
  // Use the abort signal for timeout; rely on global fetch (Node 18+).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function defaultInstallLatestVersion(version: string): boolean {
  try {
    const result = spawnSync(
      "npm",
      ["install", "-g", `${PACKAGE_NAME}@${version}`, "--silent"],
      { stdio: "ignore", timeout: 60_000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}
