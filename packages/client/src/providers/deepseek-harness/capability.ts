import type { CapabilityEntry } from "@first-tree/shared";
import { type DetectOutcome, runDetect } from "../capabilities/detect.js";
import { formatDeepseekBinaryMissingMessage, resolveDeepseekRuntimeBinary } from "./binary.js";

export type DeepseekProbeDeps = {
  resolveRuntime?: typeof resolveDeepseekRuntimeBinary;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/**
 * Resolve-only probe plus a platform admission gate. It deliberately does not
 * launch the harness, inspect credentials, or run a prompt.
 *
 * Windows V1 fails closed before install detection so setup cards never invite
 * operators to install a runtime `prepareSession` will always reject (Job Object
 * supervisor not yet available).
 */
export async function probeDeepseekCapability(deps: DeepseekProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const resolveRuntime = deps.resolveRuntime ?? resolveDeepseekRuntimeBinary;

  return runDetect(async (): Promise<DetectOutcome> => {
    if (platform === "win32") {
      throw new Error(
        "DeepSeek Harness is not supported on Windows in v1 until the client-wide pre-admission " +
          "Job Object supervisor is available. First Tree fails closed on this platform " +
          "and will not spawn `dsh-jsonrpc-agent` here.",
      );
    }
    const resolution = resolveRuntime(env);
    if (resolution.ok) {
      return {
        installed: true,
        runtimeSource: "bundled",
        runtimePath: resolution.binary,
      };
    }
    return {
      installed: false,
      error: formatDeepseekBinaryMissingMessage(resolution.error),
    };
  });
}
