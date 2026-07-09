import { existsSync, readFileSync } from "node:fs";
import { daemonEnvFile } from "@first-tree/shared/config";

/**
 * Path of the user-owned environment file the daemon loads at start.
 *
 * Compatibility, not management: a launchd / systemd daemon does NOT inherit the
 * user's interactive login-shell environment, so a user behind a network proxy
 * has no ambient `HTTP(S)_PROXY` in the daemon's process — which is why direct
 * egress to api.anthropic.com / github.com fails even though the same user's
 * interactive `claude` / `git` work. This file is the user's explicit, opt-in
 * channel to supply that environment to the background daemon.
 *
 * Resolves under the channel home (`daemonEnvFile`), so guidance and loading
 * always agree on the same per-channel path. First Tree only ever READS this
 * file; it never writes a proxy here on the user's behalf. The lone exception is
 * the one-time upgrade migration in `service-install.ts` that lifts a proxy a
 * previous version had baked into the service unit — after which the file is the
 * user's to edit or delete.
 */
export function daemonEnvPath(): string {
  return daemonEnvFile();
}

/**
 * Parse simple `KEY=VALUE` env-file lines. Tolerates blank lines, `#` comments,
 * an optional leading `export `, and surrounding single / double quotes. An
 * UNQUOTED value also has a trailing ` # comment` stripped (a `#` inside quotes,
 * or not preceded by whitespace, is kept — proxy URLs and passwords may contain
 * it). Never throws — a malformed line is skipped rather than aborting the load,
 * so a user's typo in this file can never crash the daemon at start.
 */
export function parseDaemonEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      // Quoted: take the literal interior, no comment stripping.
      value = value.slice(1, -1);
    } else {
      // Unquoted: a ` #...` tail is a trailing comment, not part of the value.
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load the user-owned `daemon.env` into `process.env` for the running daemon, so
 * every child process it later spawns (the Claude CLI, git, npm) inherits
 * whatever proxy / network environment the user configured.
 *
 * Fill-don't-clobber: a key already present and non-empty in `process.env` (e.g.
 * pinned by the service unit, or inherited when the daemon runs in the
 * foreground) is left untouched — the file fills gaps, it does not override a
 * live environment. An empty value (`KEY=`) is skipped, not applied: injecting
 * an empty proxy var silently disables egress, and a half-deleted entry should
 * not read as "loaded". Returns the keys that were applied, for logging. A
 * missing, unreadable, or malformed file yields `[]` (a clean no-op); never
 * throws.
 */
export function loadDaemonEnv(envPath: string = daemonEnvPath(), env: NodeJS.ProcessEnv = process.env): string[] {
  let content: string;
  try {
    if (!existsSync(envPath)) return [];
    content = readFileSync(envPath, "utf-8");
  } catch {
    /* v8 ignore next */
    return [];
  }
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseDaemonEnv(content))) {
    if (value === "") continue;
    const existing = env[key];
    if (existing !== undefined && existing !== "") continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}
