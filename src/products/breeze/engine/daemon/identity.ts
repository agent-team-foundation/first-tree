/**
 * Daemon-level identity resolver.
 *
 * TS port of `identity.rs`.
 *
 * The daemon needs a richer identity than the one-shot commands:
 *   - `host`  — GitHub host (default `github.com`)
 *   - `login` — the authenticated user's GH login
 *   - `gitProtocol` — `https` | `ssh` (from `gh auth status --active`)
 *   - `scopes` — OAuth scope list; used by `hasRequiredScope` to warn if
 *     the token lacks `repo`/`notifications`
 *   - `lockKey(profile)` — `host__login__profile`, used by the broker
 *     lock directory (`~/.breeze/runner/locks/<lockKey>/`). Phase 3c
 *     consumes this; we produce it now so identity is stable.
 *
 * Caching: delegates to `runtime/identity-cache.ts`'s 24h-TTL JSON file at
 * `~/.breeze/identity.json`. The core cache only stores `{login, host,
 * fetched_at_ms}` because one-shot callers don't need scopes. The
 * daemon fetches the richer payload via `gh auth status --active`
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

/**
 * Parse the scope field as `gh` returns it. Shape varies:
 *   - Comma-separated string (`"repo,workflow"`) — older output
 *   - Shell-quoted string from `gh auth status`
 *     (`"'repo', 'workflow'"`)
 */
function parseScopes(raw: unknown): string[] {
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim().replace(/^['"]+|['"]+$/gu, ""))
      .filter((s) => s.length > 0)
      .filter((s) => s !== "(none)" && s.toLowerCase() !== "none");
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim().replace(/^['"]+|['"]+$/gu, ""))
      .filter((s) => s.length > 0);
  }
  return [];
}

/**
 * Parse the active account from `gh auth status --active --hostname <host>`.
 */
export function pickIdentityFromAuthStatusText(
  statusText: string,
  targetHost: string,
): DaemonIdentity | null {
  let login: string | null = null;
  let gitProtocol = "https";
  let scopes: string[] = [];

  for (const line of statusText.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (!login) {
      const marker = `Logged in to ${targetHost} account `;
      const start = trimmed.indexOf(marker);
      if (start >= 0) {
        const rest = trimmed.slice(start + marker.length).trim();
        const parsedLogin = rest.match(/^([^\s(]+)/u)?.[1];
        if (parsedLogin) {
          login = parsedLogin;
          continue;
        }
      }
    }

    const protocolMatch = trimmed.match(
      /^-\s*Git operations protocol:\s*(\S+)/u,
    );
    if (protocolMatch) {
      gitProtocol = protocolMatch[1];
      continue;
    }

    const scopesMatch = trimmed.match(/^-\s*Token scopes:\s*(.+)$/u);
    if (scopesMatch) {
      scopes = parseScopes(scopesMatch[1]);
    }
  }

  if (!login) return null;

  return {
    host: targetHost,
    login,
    gitProtocol,
    scopes,
  };
}

/**
 * Resolve the active gh identity for the daemon. Uses
 * `gh auth status --active --hostname <host>` to stay compatible with
 * older gh releases that don't support `gh auth status --json`.
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
    ]);
  } catch (err) {
    if (err instanceof GhExecError) {
      throw new Error(
        `gh auth status failed; run \`gh auth login --hostname ${host}\` first (${err.message.split("\n")[0]})`,
      );
    }
    throw err;
  }

  const identity = pickIdentityFromAuthStatusText(stdout, host);
  if (!identity) {
    throw new Error(
      `could not parse an active gh identity from \`gh auth status\` for host \`${host}\``,
    );
  }
  return identity;
}
