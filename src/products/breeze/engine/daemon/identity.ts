/**
 * Daemon-level identity resolver.
 *
 * TS port of `identity.rs`.
 *
 * The daemon needs a richer identity than the one-shot commands:
 *   - `host`  — GitHub host (default `github.com`)
 *   - `login` — the authenticated user's GH login
 *   - `gitProtocol` — `https` | `ssh` (from `gh auth status --json hosts`)
 *   - `scopes` — OAuth scope list; used by `hasRequiredScope` to warn if
 *     the token lacks `repo`/`notifications`
 *   - `lockKey(profile)` — `host__login__profile`, used by the broker
 *     lock directory (`~/.breeze/runner/locks/<lockKey>/`). Phase 3c
 *     consumes this; we produce it now so identity is stable.
 *
 * Caching: delegates to `runtime/identity-cache.ts`'s 24h-TTL JSON file at
 * `~/.breeze/identity.json`. The core cache only stores `{login, host,
 * fetched_at_ms}` because one-shot callers don't need scopes. The
 * daemon fetches the richer payload via `gh auth status --json hosts`
 * and keeps it in memory for the lifetime of the daemon process.
 */

import { GhClient, GhExecError } from "../runtime/gh.js";

export interface DaemonIdentity {
  host: string;
  login: string;
  gitProtocol: string;
  scopes: string[];
}

export function identityLockKey(
  identity: DaemonIdentity,
  profile: string,
): string {
  return `${identity.host}__${identity.login}__${profile}`;
}

export function identityHasRequiredScope(identity: DaemonIdentity): boolean {
  return identity.scopes.some(
    (scope) => scope === "repo" || scope === "notifications",
  );
}

export interface ResolveDaemonIdentityDeps {
  gh?: GhClient;
  host?: string;
}

interface AuthStatusHostEntry {
  active?: boolean;
  user?: string;
  login?: string;
  gitProtocol?: string;
  git_protocol?: string;
  scopes?: string | string[];
}

interface AuthStatusPayload {
  hosts?: Record<string, AuthStatusHostEntry | AuthStatusHostEntry[]>;
}

/**
 * Parse the scope field as `gh` returns it. Shape varies:
 *   - Comma-separated string (`"repo,workflow"`) — older output
 *   - Array of strings (`["repo", "workflow"]`) — newer output
 */
function parseScopes(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

/**
 * Pick the active account from a `gh auth status --json hosts` payload.
 * Handles both shapes seen in the wild (single object vs array per host).
 */
export function pickActiveIdentityFromAuthStatus(
  payload: AuthStatusPayload,
  targetHost: string,
): DaemonIdentity | null {
  const hosts = payload.hosts ?? {};
  for (const [host, bucket] of Object.entries(hosts)) {
    if (host !== targetHost) continue;
    const candidates: AuthStatusHostEntry[] = Array.isArray(bucket)
      ? bucket
      : [bucket];
    const active = candidates.find((c) => c?.active === true) ?? candidates[0];
    if (!active) continue;
    const login = active.user ?? active.login;
    if (typeof login !== "string" || login.length === 0) continue;
    const gitProtocol = active.gitProtocol ?? active.git_protocol ?? "https";
    return {
      host,
      login,
      gitProtocol,
      scopes: parseScopes(active.scopes),
    };
  }
  return null;
}

/**
 * Resolve the active gh identity for the daemon. Uses
 * `gh auth status --json hosts` with a jq-free JSON parse in Node.
 */
export function resolveDaemonIdentity(
  deps: ResolveDaemonIdentityDeps = {},
): DaemonIdentity {
  const gh = deps.gh ?? new GhClient();
  const host = deps.host ?? "github.com";

  let stdout: string;
  try {
    stdout = gh.runChecked("resolve gh identity", [
      "auth",
      "status",
      "--active",
      "--hostname",
      host,
      "--json",
      "hosts",
    ]);
  } catch (err) {
    if (err instanceof GhExecError) {
      throw new Error(
        `gh auth status failed; run \`gh auth login --hostname ${host}\` first (${err.message.split("\n")[0]})`,
      );
    }
    throw err;
  }

  let parsed: AuthStatusPayload;
  try {
    parsed = JSON.parse(stdout) as AuthStatusPayload;
  } catch (err) {
    throw new Error(
      `gh auth status returned non-JSON output: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const identity = pickActiveIdentityFromAuthStatus(parsed, host);
  if (!identity) {
    throw new Error(`no active gh identity found for host \`${host}\``);
  }
  return identity;
}
