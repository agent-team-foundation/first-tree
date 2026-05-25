import type { ClientCapabilities, RuntimeProvider } from "@first-tree/shared";
import { probeClaudeCodeCapability } from "./claude-code.js";
import { probeCodexCapability } from "./codex.js";

/**
 * Run every built-in capability probe and aggregate the results.
 *
 * Each provider gets its own module under this directory; the orchestrator
 * is intentionally simple — adding a new provider means importing the new
 * probe here and registering its key. The probe modules themselves are
 * deliberately not part of the `HandlerFactory` interface so capability
 * detection stays decoupled from runtime instantiation (so we can probe
 * whether a runtime is usable before spawning anything).
 */
export async function probeCapabilities(): Promise<ClientCapabilities> {
  const probes: Array<readonly [RuntimeProvider, ReturnType<typeof probeClaudeCodeCapability>]> = [
    ["claude-code", probeClaudeCodeCapability()],
    ["codex", probeCodexCapability()],
  ];

  const out: ClientCapabilities = {};
  await Promise.all(
    probes.map(async ([provider, p]) => {
      try {
        out[provider] = await p;
      } catch (err) {
        out[provider] = {
          state: "error",
          available: false,
          authenticated: false,
          sdkVersion: null,
          authMethod: "none",
          error: err instanceof Error ? err.message : String(err),
          detectedAt: new Date().toISOString(),
        };
      }
    }),
  );
  return out;
}
