import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityEntry } from "@first-tree/shared";

/**
 * Top-level marker file Claude Code writes after a successful OAuth login.
 * Path is platform-agnostic (`~/.claude.json`); the access token itself lives
 * in the platform credential store (macOS Keychain entry "Claude Code-
 * credentials", or libsecret on Linux), so we treat the presence of an
 * `oauthAccount.accountUuid` field as the canonical "logged in" signal.
 */
const CLAUDE_PROFILE_PATH = () => join(homedir(), ".claude.json");

function hasClaudeOAuthAccount(): boolean {
  try {
    const path = CLAUDE_PROFILE_PATH();
    if (!existsSync(path)) return false;
    const raw = readFileSync(path, "utf-8");
    const obj = JSON.parse(raw) as { oauthAccount?: { accountUuid?: unknown } };
    return typeof obj.oauthAccount?.accountUuid === "string" && obj.oauthAccount.accountUuid.length > 0;
  } catch {
    return false;
  }
}

async function readSdkVersion(): Promise<string | null> {
  // The Anthropic SDK does not expose `./package.json` via `exports` and only
  // ships ESM `default` (no CJS `require` condition). Use ESM resolution, then
  // walk up from the entry file to the package root.
  try {
    const entryUrl = await import.meta.resolve("@anthropic-ai/claude-agent-sdk");
    let dir = dirname(fileURLToPath(entryUrl));
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as { name?: unknown; version?: unknown };
        if (pkg.name === "@anthropic-ai/claude-agent-sdk" && typeof pkg.version === "string") return pkg.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return null;
}

function detectAuth(): { authenticated: boolean; method: "api_key" | "oauth" | "none" } {
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 0) {
    return { authenticated: true, method: "api_key" };
  }
  if (hasClaudeOAuthAccount()) {
    return { authenticated: true, method: "oauth" };
  }
  return { authenticated: false, method: "none" };
}

/**
 * Probe whether the Claude Code runtime is usable on this machine.
 *
 * `state` is the authoritative field; `available` and `authenticated` are
 * derived booleans kept around for simple consumers (e.g. capability lookup
 * in service-layer guards).
 */
export async function probeClaudeCodeCapability(): Promise<CapabilityEntry> {
  const detectedAt = new Date().toISOString();
  try {
    let sdkPresent = false;
    try {
      await import("@anthropic-ai/claude-agent-sdk");
      sdkPresent = true;
    } catch {
      sdkPresent = false;
    }

    if (!sdkPresent) {
      return {
        state: "missing",
        available: false,
        authenticated: false,
        sdkVersion: null,
        authMethod: "none",
        detectedAt,
      };
    }

    const sdkVersion = await readSdkVersion();
    const auth = detectAuth();
    if (!auth.authenticated) {
      return {
        state: "unauthenticated",
        available: true,
        authenticated: false,
        sdkVersion,
        authMethod: "none",
        detectedAt,
      };
    }
    return {
      state: "ok",
      available: true,
      authenticated: true,
      sdkVersion,
      authMethod: auth.method,
      detectedAt,
    };
  } catch (err) {
    return {
      state: "error",
      available: false,
      authenticated: false,
      sdkVersion: null,
      authMethod: "none",
      error: err instanceof Error ? err.message : String(err),
      detectedAt,
    };
  }
}
