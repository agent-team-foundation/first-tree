import type { CapabilityEntry } from "@first-tree/shared";
import { supportsDefaultProviderProcessSupervision } from "../../runtime/provider-support/index.js";
import { type DetectOutcome, runDetect } from "../capabilities/detect.js";
import { findAmpExecutableOnPath, formatAmpBinaryMissingMessage } from "./binary.js";

export type AmpProbeDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/**
 * Resolve-only probe plus an execution-support gate. It deliberately does not
 * launch Amp, inspect its config, or infer provider authentication.
 *
 * A resolved Windows binary stays visible in diagnostics, but is not
 * advertised as available while the built-in supervisor would reject it
 * before spawn.
 */
export async function probeAmpCapability(deps: AmpProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const findOnPath = deps.findOnPath ?? findAmpExecutableOnPath;
  const detected = await runDetect(async (): Promise<DetectOutcome> => {
    const runtimePath = findOnPath(env);
    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };
    return {
      installed: false,
      error: formatAmpBinaryMissingMessage("no amp binary resolved on this host"),
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
      "Amp is installed, but First Tree cannot run it on Windows until the client-wide " +
      "pre-admission Job Object supervisor is available.",
  };
}
