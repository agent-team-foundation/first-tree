import type { CapabilityEntry } from "@first-tree/shared";
import { type DetectOutcome, runDetect } from "../../runtime/capabilities/detect.js";
import { findGrokExecutableOnPath, formatGrokBinaryMissingMessage } from "./binary.js";

/** Injectable seams — production callers pass nothing. */
export type GrokProbeDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  env?: NodeJS.ProcessEnv;
  /** Test-only platform override; production reads `process.platform`. */
  platform?: NodeJS.Platform;
};

/**
 * Install-only probe for the `grok` (Grok Build) runtime.
 *
 * Grok Build is external-only — there is no bundled fallback, so the probe
 * answers exactly one question: does an operator-installed `grok` exist on
 * this host? Existence only: no `--version`, no credential or network
 * judgment (the probe never reads `~/.grok/auth.json` either). A logged-out
 * or unreachable Grok Build is discovered when a session actually runs and
 * surfaced as an in-chat credential failure. `runtimeSource` is always
 * `"path"` for grok.
 *
 * Platform gate: Grok Build V1 supports macOS and Linux only. On Windows the
 * probe fails closed with state `error` (NOT `missing`): a `missing` entry
 * makes the Web setup cards render the official install command in a loop
 * for a runtime First Tree explicitly does not support on that platform.
 * The gate short-circuits BEFORE the resolver — no filesystem consult, no
 * spawn.
 */
export async function probeGrokCapability(deps: GrokProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const findOnPath = deps.findOnPath ?? findGrokExecutableOnPath;

  return runDetect(async (): Promise<DetectOutcome> => {
    if (platform === "win32") {
      throw new Error(
        "Grok Build provider is not supported on Windows in V1 (macOS/Linux only). " +
          "First Tree fails closed on this platform and will not spawn `grok` here.",
      );
    }
    const pathBinary = findOnPath(env);
    if (pathBinary) {
      return { installed: true, runtimeSource: "path", runtimePath: pathBinary };
    }
    return {
      installed: false,
      error: formatGrokBinaryMissingMessage("no grok binary resolved on this host"),
    };
  });
}
