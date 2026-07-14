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
 * Cursor is external-only — there is no bundled fallback, so the probe answers
 * exactly one question: does an operator-installed `cursor-agent` / `agent`
 * exist on this host? Existence only: no `--version`, no `status`, no `models`,
 * no credential or network judgment. A logged-out or unreachable Cursor is
 * discovered when a session actually runs and surfaced as an in-chat
 * credential failure. `runtimeSource` is always `"path"` for cursor.
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
      error: formatCursorBinaryMissingMessage("no cursor-agent or agent binary resolved on this host"),
    };
  });
}
