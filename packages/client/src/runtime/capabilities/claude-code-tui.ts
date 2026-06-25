import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { CapabilityEntry } from "@first-tree/shared";
import { type ClaudeExecutableResolution, resolveClaudeCodeExecutable } from "../../handlers/claude-executable.js";
import { type DetectOutcome, runDetect } from "./detect.js";

/**
 * `which tmux` — true when an executable `tmux` exists on the daemon's PATH.
 * Install detection only: no `tmux -V`, no version gate (the launch-verified
 * probe used to require tmux >= 3.0; usability is no longer checked here).
 */
export function tmuxOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const binary = process.platform === "win32" ? "tmux.exe" : "tmux";
  const dirs = (env.PATH ?? "").split(delimiter).filter((d) => d.length > 0);
  return dirs.some((dir) => existsSync(join(dir, binary)));
}

/**
 * Injectable seams so the probe is deterministic under test without touching
 * the real PATH (mirrors `resolveClaudeCodeExecutable`).
 */
export type ClaudeCodeTuiProbeDeps = {
  resolveExecutable?: (opts?: { env?: NodeJS.ProcessEnv }) => ClaudeExecutableResolution;
  hasTmux?: () => boolean;
  exists?: (path: string) => boolean;
};

/**
 * Install-only probe for the `claude-code-tui` runtime.
 *
 * Unlike `claude-code` (which can fall back to the SDK's bundled native
 * binary), the TUI runtime spawns the real `claude` CLI inside a tmux pane — so
 * it is installed only when BOTH a real on-disk `claude` exists (env override /
 * PATH / well-known dirs; the SDK bundle's `source: "default"` does not count)
 * AND `tmux` is on PATH. Otherwise `missing`, with the reason listing which
 * piece is absent. No `--version`, no tmux version gate, no auth, no smoke.
 */
export async function probeClaudeCodeTuiCapability(deps: ClaudeCodeTuiProbeDeps = {}): Promise<CapabilityEntry> {
  const resolveExecutable = deps.resolveExecutable ?? resolveClaudeCodeExecutable;
  const hasTmux = deps.hasTmux ?? (() => tmuxOnPath());
  const exists = deps.exists ?? existsSync;

  return runDetect(async (): Promise<DetectOutcome> => {
    const reasons: string[] = [];

    const resolution = resolveExecutable();
    // `source: "default"` means no real binary was found — the SDK bundle is
    // not usable by the tmux runtime, so treat it as not installed.
    const claudeBinary = resolution.source === "default" ? undefined : resolution.path;
    if (!claudeBinary || !exists(claudeBinary)) {
      reasons.push(
        "`claude` not found (checked CLAUDE_CODE_EXECUTABLE, PATH, and well-known install dirs like ~/.local/bin)",
      );
    }

    if (!hasTmux()) reasons.push("tmux not found on PATH");

    if (reasons.length > 0) return { installed: false, error: reasons.join("; ") };
    return { installed: true, runtimeSource: "path", runtimePath: claudeBinary ?? null };
  });
}
