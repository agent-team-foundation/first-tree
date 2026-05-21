import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityEntry } from "@first-tree/shared";

function codexAuthPath(): string {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(home, "auth.json");
}

async function readSdkVersion(): Promise<string | null> {
  // The codex-sdk only exports `.` (no `./package.json` and no CJS `require`
  // condition), so `createRequire(...).resolve` fails in CJS context. Use
  // ESM's `import.meta.resolve`, then walk up from the entry file to the
  // package's own package.json.
  try {
    const entryUrl = await import.meta.resolve("@openai/codex-sdk");
    let dir = dirname(fileURLToPath(entryUrl));
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as { name?: unknown; version?: unknown };
        if (pkg.name === "@openai/codex-sdk" && typeof pkg.version === "string") return pkg.version;
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

function detectAuth(): { authenticated: boolean; method: "api_key" | "auth_json" | "none" } {
  if (process.env.CODEX_API_KEY && process.env.CODEX_API_KEY.length > 0) {
    return { authenticated: true, method: "api_key" };
  }
  if (existsSync(codexAuthPath())) {
    return { authenticated: true, method: "auth_json" };
  }
  return { authenticated: false, method: "none" };
}

/**
 * Probe whether the OpenAI Codex runtime is usable on this machine.
 * Treats `~/.codex/auth.json` (set by `codex login`) as the canonical local
 * auth source; CODEX_API_KEY env shortcuts that for ephemeral use.
 */
export async function probeCodexCapability(): Promise<CapabilityEntry> {
  const detectedAt = new Date().toISOString();
  try {
    let sdkPresent = false;
    try {
      await import("@openai/codex-sdk");
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
