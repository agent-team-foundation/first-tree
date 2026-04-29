/**
 * Identity cache for `gh api /user`.
 *
 * The Rust daemon's `resolve_identity` (`identity.rs`) uses `gh auth status`
 * + jq. For the TS port we use the simpler `gh api /user` and cache the
 * response to `~/.first-tree/auto/identity.json` with a 24h TTL. Phase 3 (daemon)
 * will decide whether to keep both paths or unify them.
 *
 * The cache file is read-only for most callers. Corrupt / stale cache is
 * treated as a miss (no crash) and refetched.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

import { GhClient } from "./gh.js";

export const IdentitySchema = z.object({
  login: z.string(),
  /** GitHub REST endpoint host; e.g. "api.github.com" for github.com. */
  host: z.string(),
  /** Unix ms when the cache entry was written. */
  fetched_at_ms: z.number().int(),
});
export type Identity = z.infer<typeof IdentitySchema>;

export const DEFAULT_IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdentityDeps {
  gh?: GhClient;
  /** Override "now" for tests. */
  now?: () => number;
  /** Path to the cache file. */
  cachePath: string;
  /** TTL; defaults to 24h. */
  ttlMs?: number;
  /** GitHub host (default "github.com"). */
  host?: string;
  readFile?: (path: string) => string;
  writeFile?: (path: string, data: string) => void;
  fileExists?: (path: string) => boolean;
}

function readCached(deps: IdentityDeps): Identity | null {
  const exists = deps.fileExists ?? existsSync;
  if (!exists(deps.cachePath)) return null;
  try {
    const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
    const parsed = IdentitySchema.safeParse(JSON.parse(read(deps.cachePath)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function fetchFreshIdentity(deps: IdentityDeps): Identity {
  const gh = deps.gh ?? new GhClient();
  const host = deps.host ?? "github.com";
  const stdout = gh.runChecked("api /user", [
    "api",
    "--hostname",
    host,
    "/user",
  ]);
  const parsed = JSON.parse(stdout) as { login?: unknown };
  if (typeof parsed.login !== "string" || parsed.login.length === 0) {
    throw new Error("gh api /user returned no login");
  }
  const now = deps.now ?? Date.now;
  return { login: parsed.login, host, fetched_at_ms: now() };
}

/**
 * Resolve the current gh identity. Checks the cache first; refetches if
 * missing or stale. Writes the fresh value back to disk on a refresh.
 */
export function resolveIdentity(deps: IdentityDeps): Identity {
  const ttl = deps.ttlMs ?? DEFAULT_IDENTITY_TTL_MS;
  const now = deps.now ?? Date.now;
  const cached = readCached(deps);
  if (cached && now() - cached.fetched_at_ms < ttl) {
    return cached;
  }
  const fresh = fetchFreshIdentity(deps);
  const write =
    deps.writeFile ??
    ((p: string, data: string) => writeFileSync(p, data, "utf-8"));
  write(deps.cachePath, `${JSON.stringify(fresh, null, 2)}\n`);
  return fresh;
}
