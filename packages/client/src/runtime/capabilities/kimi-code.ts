import type { CapabilityEntry } from "@first-tree/shared";
import {
  findKimiExecutableOnPath,
  formatKimiBinaryMissingMessage,
} from "../kimi-binary.js";
import { type DetectOutcome, runDetect } from "./detect.js";

/** Exact SDK build bundled with the client and used by the runtime handler. */
export const KIMI_CODE_SDK_VERSION = "0.26.0-botiverse.2";

/** Injectable seams — production callers pass nothing. */
export type KimiCodeProbeDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  env?: NodeJS.ProcessEnv;
};

/**
 * Install-only Kimi capability.
 *
 * Product contract: Computer availability tracks the official `kimi` CLI so
 * the operator can complete provider-owned `/login` and credential recovery on
 * this host. The bundled `@botiverse/kimi-code-sdk` remains the execution
 * engine and must not by itself make the capability `ok`.
 *
 * Detection is existence-only: no Kimi launch, no credential read, no network.
 * When the CLI is present, the entry still reports `runtimeSource: "bundled"`
 * and `runtimePath: null` because the CLI is the setup artifact, not the
 * spawn target for agent turns.
 */
export async function probeKimiCodeCapability(deps: KimiCodeProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const findOnPath = deps.findOnPath ?? findKimiExecutableOnPath;

  return runDetect(async (): Promise<DetectOutcome> => {
    const pathBinary = findOnPath(env);
    if (pathBinary) {
      return {
        installed: true,
        version: KIMI_CODE_SDK_VERSION,
        runtimeSource: "bundled",
        runtimePath: null,
      };
    }
    return {
      installed: false,
      error: formatKimiBinaryMissingMessage(
        "no kimi binary resolved on PATH, well-known install dirs, or login-shell PATH",
      ),
    };
  });
}
