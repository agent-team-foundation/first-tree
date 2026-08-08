import type { CapabilityEntry } from "@first-tree/shared";
import { findOpenCodeExecutableOnPath, formatOpenCodeBinaryMissingMessage } from "../opencode-binary.js";
import { supportsDefaultProviderProcessSupervision } from "../provider-support/index.js";
import { type DetectOutcome, runDetect } from "./detect.js";

export type OpenCodeProbeDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/**
 * Resolve-only probe plus an execution-support gate. It deliberately does not
 * launch OpenCode, inspect its config, or infer provider authentication.
 *
 * A resolved Windows binary stays visible in diagnostics, but is not
 * advertised as available while the built-in supervisor would reject it
 * before spawn.
 */
export async function probeOpenCodeCapability(deps: OpenCodeProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const findOnPath = deps.findOnPath ?? findOpenCodeExecutableOnPath;
  const detected = await runDetect(async (): Promise<DetectOutcome> => {
    const runtimePath = findOnPath(env);
    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };
    return {
      installed: false,
      error: formatOpenCodeBinaryMissingMessage("no opencode binary resolved on this host"),
    };
  });
  if (detected.state !== "ok" || supportsDefaultProviderProcessSupervision(deps.platform)) {
    return detected;
  }
  return {
    ...detected,
    state: "error",
    available: false,
    error:
      "OpenCode is installed, but First Tree cannot run it on Windows until the client-wide " +
      "pre-admission Job Object supervisor is available.",
  };
}
