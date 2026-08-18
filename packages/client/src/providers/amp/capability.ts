import type { CapabilityEntry } from "@first-tree/shared";
import { type DetectOutcome, runDetect } from "../capabilities/detect.js";
import { findAmpExecutableOnPath, formatAmpBinaryMissingMessage } from "./binary.js";

export type AmpProbeDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/**
 * Resolve-only probe plus a platform admission gate. It deliberately does not
 * launch Amp, inspect its config, or infer provider authentication.
 *
 * Windows V1 fails closed before install detection so setup cards never invite
 * operators to install a runtime `prepareSession` will always reject (Job Object
 * supervisor not yet available).
 */
export async function probeAmpCapability(deps: AmpProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const findOnPath = deps.findOnPath ?? findAmpExecutableOnPath;

  return runDetect(async (): Promise<DetectOutcome> => {
    if (platform === "win32") {
      throw new Error(
        "Amp is not supported on Windows in v1 until the client-wide pre-admission " +
          "Job Object supervisor is available. First Tree fails closed on this platform " +
          "and will not spawn `amp` here.",
      );
    }
    const runtimePath = findOnPath(env);
    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };
    return {
      installed: false,
      error: formatAmpBinaryMissingMessage("no amp binary resolved on this host"),
    };
  });
}
