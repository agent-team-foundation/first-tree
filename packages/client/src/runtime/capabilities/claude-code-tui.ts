import { spawnSync } from "node:child_process";
import type { CapabilityEntry } from "@first-tree/shared";
import { type ClaudeExecutableResolution, resolveClaudeCodeExecutable } from "../../handlers/claude-executable.js";
import { detectClaudeAuth } from "./claude-shared.js";

/**
 * Minimum tmux version the TUI runtime requires. 3.0 is the first release with
 * the stable `-f /dev/null` + `set-hook` + `capture-pane -p -S -` behaviour the
 * handler relies on (PR3). Older tmux silently differs on hook firing and
 * scrollback capture, so we gate at probe time rather than fail mid-session.
 */
export const MIN_TMUX_MAJOR = 3;
export const MIN_TMUX_MINOR = 0;

type TmuxVersion = { raw: string; major: number; minor: number };

/**
 * Parse `tmux -V` output. Accepts the common shapes:
 *   "tmux 3.4"        → {3, 4}
 *   "tmux 3.2a"       → {3, 2}   (letter suffix on patch releases)
 *   "tmux next-3.5"   → {3, 5}   (pre-release builds)
 * Returns null when no `<major>.<minor>` pair can be found.
 */
export function parseTmuxVersion(output: string): TmuxVersion | null {
  const match = output.match(/(\d+)\.(\d+)/);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) return null;
  return { raw: output.trim(), major, minor };
}

function tmuxMeetsMinimum(v: TmuxVersion): boolean {
  if (v.major !== MIN_TMUX_MAJOR) return v.major > MIN_TMUX_MAJOR;
  return v.minor >= MIN_TMUX_MINOR;
}

/** Real `tmux -V` probe. Returns null when tmux is absent or unreadable. */
function defaultProbeTmux(): TmuxVersion | null {
  try {
    const res = spawnSync("tmux", ["-V"], { encoding: "utf-8", timeout: 5000 });
    if (res.error || res.status !== 0 || typeof res.stdout !== "string") return null;
    return parseTmuxVersion(res.stdout);
  } catch {
    return null;
  }
}

/**
 * Real `claude --version` probe. Returns the version string (e.g. "1.0.42") or
 * null when the binary is absent / unreadable / prints no recognizable version.
 * Output shapes vary ("1.0.42 (Claude Code)", "claude 1.0.42"), so we extract
 * the first dotted-number triplet/pair.
 */
function defaultProbeClaudeVersion(binary: string): string | null {
  try {
    const res = spawnSync(binary, ["--version"], { encoding: "utf-8", timeout: 5000 });
    if (res.error || res.status !== 0 || typeof res.stdout !== "string") return null;
    const match = res.stdout.match(/\d+\.\d+(?:\.\d+)?/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * Injectable seams so the probe is deterministic under test without spawning a
 * real tmux/claude or touching the developer's PATH (mirrors `resolveClaudeCodeExecutable`).
 */
export type ClaudeCodeTuiProbeDeps = {
  resolveExecutable?: (opts?: { env?: NodeJS.ProcessEnv }) => ClaudeExecutableResolution;
  probeTmux?: () => TmuxVersion | null;
  probeClaudeVersion?: (binary: string) => string | null;
  detectAuth?: () => { authenticated: boolean; method: "api_key" | "oauth" | "none" };
};

/**
 * Probe whether the `claude-code-tui` runtime is usable on this machine.
 *
 * Unlike `claude-code` (which can fall back to the SDK's bundled native binary),
 * the TUI runtime spawns the real `claude` CLI inside a tmux pane — so it needs
 * BOTH a resolvable AND runnable `claude` executable (env override or PATH; the
 * SDK bundle's `source: "default"` does not count) AND tmux >= 3.0. Auth is the
 * same Claude login the SDK path uses, so it reuses the shared detector.
 *
 * "Runnable" matters: `resolveClaudeCodeExecutable` only does `existsSync`, so a
 * present-but-broken binary (non-executable, wrong arch, or a
 * `CLAUDE_CODE_EXECUTABLE` pointing at a dud) still resolves. We require a
 * successful `claude --version` — if it cannot be executed the runtime would
 * fail to spawn at session time, so we report `missing` here rather than let the
 * server gate bind a machine that cannot actually run the CLI.
 *
 * `sdkVersion` carries the `claude` CLI version (the runtime engine), matching
 * how `claude-code` reports the SDK version — the web surface renders it as the
 * runtime version. tmux is infrastructure, so its version only surfaces in the
 * failure `error` reason when it is missing or too old.
 *
 * State precedence: missing (claude absent/not runnable / no tmux / tmux too old)
 * > unauthenticated (runtime present, not logged in) > ok.
 */
export async function probeClaudeCodeTuiCapability(deps: ClaudeCodeTuiProbeDeps = {}): Promise<CapabilityEntry> {
  const detectedAt = new Date().toISOString();
  const resolveExecutable = deps.resolveExecutable ?? resolveClaudeCodeExecutable;
  const probeTmux = deps.probeTmux ?? defaultProbeTmux;
  const probeClaudeVersion = deps.probeClaudeVersion ?? defaultProbeClaudeVersion;
  const detectAuth = deps.detectAuth ?? detectClaudeAuth;

  try {
    const resolution = resolveExecutable();
    // `source: "default"` means no real binary was found — the SDK bundle is
    // not usable by the tmux runtime, so treat it as missing.
    const claudeBinary = resolution.source === "default" ? undefined : resolution.path;
    // existsSync is not enough — confirm the binary actually runs. A null here
    // (absent / non-executable / non-zero `--version`) means the CLI cannot be
    // spawned, so it fails the gate rather than reporting a false-positive `ok`.
    const claudeVersion = claudeBinary ? probeClaudeVersion(claudeBinary) : null;
    const claudeRunnable = claudeBinary !== undefined && claudeVersion !== null;

    const tmux = probeTmux();
    const tmuxOk = tmux !== null && tmuxMeetsMinimum(tmux);

    if (!claudeRunnable || !tmuxOk) {
      const reasons: string[] = [];
      if (!claudeBinary) reasons.push("`claude` not found on PATH (and CLAUDE_CODE_EXECUTABLE unset)");
      else if (claudeVersion === null)
        reasons.push(`\`claude\` at ${claudeBinary} could not be executed (\`claude --version\` failed)`);
      if (tmux === null) reasons.push("tmux not found");
      else if (!tmuxOk) reasons.push(`tmux ${tmux.raw} is older than ${MIN_TMUX_MAJOR}.${MIN_TMUX_MINOR}`);
      return {
        state: "missing",
        available: false,
        authenticated: false,
        sdkVersion: claudeVersion,
        authMethod: "none",
        error: reasons.join("; "),
        detectedAt,
      };
    }

    const auth = detectAuth();
    if (!auth.authenticated) {
      return {
        state: "unauthenticated",
        available: true,
        authenticated: false,
        sdkVersion: claudeVersion,
        authMethod: "none",
        detectedAt,
      };
    }

    return {
      state: "ok",
      available: true,
      authenticated: true,
      sdkVersion: claudeVersion,
      authMethod: auth.method,
      detectedAt,
    };
  } catch (err) {
    return {
      state: "error",
      available: false,
      authenticated: false,
      sdkVersion: null,
      authMethod: "none",
      error: err instanceof Error ? err.message : String(err),
      detectedAt,
    };
  }
}
