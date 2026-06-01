import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Auth detection shared by every probe that drives the `claude` CLI —
 * currently `claude-code` (SDK) and `claude-code-tui` (tmux). Both authenticate
 * the exact same way (there is only one Claude login on a machine), so the
 * detection lives here instead of being duplicated per probe.
 */
export type ClaudeAuthMethod = "api_key" | "oauth" | "none";

/**
 * Top-level marker file Claude Code writes after a successful OAuth login.
 * Path is platform-agnostic (`~/.claude.json`); the access token itself lives
 * in the platform credential store (macOS Keychain entry "Claude Code-
 * credentials", or libsecret on Linux), so we treat the presence of an
 * `oauthAccount.accountUuid` field as the canonical "logged in" signal.
 */
const claudeProfilePath = (): string => join(homedir(), ".claude.json");

export function hasClaudeOAuthAccount(): boolean {
  try {
    const path = claudeProfilePath();
    if (!existsSync(path)) return false;
    const raw = readFileSync(path, "utf-8");
    const obj = JSON.parse(raw) as { oauthAccount?: { accountUuid?: unknown } };
    return typeof obj.oauthAccount?.accountUuid === "string" && obj.oauthAccount.accountUuid.length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the Claude auth state from the environment + OAuth marker file.
 *
 * `ANTHROPIC_API_KEY` takes precedence over the OAuth marker — an explicit key
 * overrides whatever login the local CLI happens to have cached.
 */
export function detectClaudeAuth(): { authenticated: boolean; method: ClaudeAuthMethod } {
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 0) {
    return { authenticated: true, method: "api_key" };
  }
  if (hasClaudeOAuthAccount()) {
    return { authenticated: true, method: "oauth" };
  }
  return { authenticated: false, method: "none" };
}
