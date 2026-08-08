import type { CapabilityEntry } from "@first-tree/shared";
import { findPiExecutableOnPath, formatPiBinaryMissingMessage } from "../pi-binary.js";
import { supportsDefaultProviderProcessSupervision } from "../provider-support/index.js";
import { type DetectOutcome, runDetect } from "./detect.js";

export type PiProbeDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/**
 * Resolve-only probe plus an execution-support gate. It deliberately does not
 * launch Pi, inspect its config, or infer provider authentication.
 *
 * A resolved Windows binary stays visible in diagnostics, but is not
 * advertised as available while the built-in supervisor would reject it
 * before spawn.
 */
export async function probePiCapability(deps: PiProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const findOnPath = deps.findOnPath ?? findPiExecutableOnPath;

  const detected = await runDetect(async (): Promise<DetectOutcome> => {
    if (platform === "win32") {
      throw new Error(
        "Pi provider is not supported on Windows in V1 (macOS/Linux only). " +
          "First Tree fails closed on this platform and will not spawn `pi` here.",
      );
    }
    const runtimePath = findOnPath(env);
    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };
    return {
      installed: false,
      error: formatPiBinaryMissingMessage("no pi binary resolved on this host"),
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
      "Pi is installed, but First Tree cannot run it on Windows until the client-wide " +
      "pre-admission Job Object supervisor is available.",
  };
}
