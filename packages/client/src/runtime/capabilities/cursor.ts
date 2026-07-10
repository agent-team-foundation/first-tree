import type { CapabilityEntry } from "@first-tree/shared";
import { findCursorExecutableOnPath, formatCursorBinaryMissingMessage } from "../cursor-binary.js";
import { type DetectOutcome, runDetect } from "./detect.js";

/** Injectable seams — production callers pass nothing. */
export type CursorProbeDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  env?: NodeJS.ProcessEnv;
};

/**
 * Install-only probe for the `cursor` runtime.
 *
 * Installed when the Cursor agent CLI (`agent` / `cursor-agent`) resolves on
 * PATH or a well-known install directory — WITHOUT launching it (`--version`),
 * checking login status, or running a session. First Tree does not bundle a
 * Cursor binary, so detection is PATH-only. Authentication and reachability are
 * discovered at session run time and surfaced as an in-chat credential failure,
 * not here.
 */
export async function probeCursorCapability(deps: CursorProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const findOnPath = deps.findOnPath ?? findCursorExecutableOnPath;

  return runDetect(async (): Promise<DetectOutcome> => {
    const pathBinary = findOnPath(env);
    if (pathBinary) {
      return { installed: true, runtimeSource: "path", runtimePath: pathBinary };
    }
    return {
      installed: false,
      error: formatCursorBinaryMissingMessage("no `agent` or `cursor-agent` binary found on PATH"),
    };
  });
}
