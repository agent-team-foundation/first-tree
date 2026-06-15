import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { CapabilityEntry } from "@first-tree/shared";
import { type ClaudeExecutableResolution, resolveClaudeCodeExecutable } from "../../handlers/claude-executable.js";
import { CLAUDE_SMOKE_PROMPT, CLAUDE_SMOKE_TIMEOUT_MS, classifyClaudeSmokeFailure } from "./claude-code.js";
import { detectClaudeAuth } from "./claude-shared.js";
import {
  type AuthPrecheckOutcome,
  commandFailureDigest,
  type ResolveOutcome,
  runCommand,
  runLaunchProbe,
  type SmokeOutcome,
  verifyLaunchable,
} from "./launch-probe.js";

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
 * Real launch smoke for the TUI runtime: a headless 1-turn `claude -p` run of
 * the resolved binary. This launches the exact binary the tmux handler would
 * spawn with the exact credentials the session would use; tmux itself is
 * infrastructure validated separately in the resolve stage (`tmux -V` +
 * version gate), so the smoke does not need to drive a real pane to prove the
 * provider end of the contract.
 */
/**
 * Args the TUI smoke launches with. Mirrors the real TUI handler's launch
 * contract — it spawns `claude` with `--setting-sources user,project` (see
 * `handlers/claude-code-tui/index.ts`), so the smoke loads the same settings
 * sources. Exported for a regression test that pins this parity.
 */
export const TUI_SMOKE_ARGS: readonly string[] = [
  "-p",
  CLAUDE_SMOKE_PROMPT,
  "--model",
  "haiku",
  "--setting-sources",
  "user,project",
];

export async function defaultTuiSmoke(binary: string, run: typeof runCommand = runCommand): Promise<SmokeOutcome> {
  // Match the real TUI handler's launch contract (see TUI_SMOKE_ARGS):
  // otherwise a machine whose Claude runtime depends on `~/.claude/settings.json`
  // (provider endpoint / proxy / model alias / hooks / plugins) would be probed
  // under a different config than it actually runs.
  const res = await run(binary, [...TUI_SMOKE_ARGS], {
    timeoutMs: CLAUDE_SMOKE_TIMEOUT_MS,
    // Neutral cwd — a tmp dir has no `project` settings, so this stays
    // equivalent to the handler's source contract without picking up an
    // arbitrary repo's .claude/ project settings.
    cwd: tmpdir(),
  });
  if (res.ok) return { state: "ok" };
  // Verified on a real machine: an invalid API key exits 1 and prints
  // "Invalid API key · Please run /login" on STDOUT, so classification reads
  // both streams via the digest.
  return classifyClaudeSmokeFailure(commandFailureDigest("`claude -p` smoke", res));
}

/**
 * Injectable seams so the probe is deterministic under test without spawning a
 * real tmux/claude or touching the developer's PATH (mirrors `resolveClaudeCodeExecutable`).
 */
export type ClaudeCodeTuiProbeDeps = {
  resolveExecutable?: (opts?: { env?: NodeJS.ProcessEnv }) => ClaudeExecutableResolution;
  probeTmux?: () => TmuxVersion | null;
  verifyBinary?: (binary: string) => Promise<{ ok: true; version: string | null } | { ok: false; error: string }>;
  detectAuth?: () => { authenticated: boolean; method: "api_key" | "oauth" | "none" };
  runSmoke?: (binary: string) => Promise<SmokeOutcome>;
};

/**
 * Launch-verified probe for the `claude-code-tui` runtime.
 *
 * Unlike `claude-code` (which can fall back to the SDK's bundled native
 * binary), the TUI runtime spawns the real `claude` CLI inside a tmux pane —
 * so the resolve stage requires BOTH a resolvable AND launch-verified `claude`
 * executable (env override / PATH / well-known dirs; the SDK bundle's
 * `source: "default"` does not count) AND tmux >= 3.0. Auth is the same
 * Claude login the SDK path uses, so the precheck reuses the shared detector
 * — as a negative gate only. `ok` comes exclusively from a real headless
 * 1-turn run of the resolved binary.
 *
 * `sdkVersion` carries the `claude` CLI version (the runtime engine); tmux is
 * infrastructure, so its version only surfaces in the failure `error` reason.
 */
export async function probeClaudeCodeTuiCapability(deps: ClaudeCodeTuiProbeDeps = {}): Promise<CapabilityEntry> {
  const resolveExecutable = deps.resolveExecutable ?? resolveClaudeCodeExecutable;
  const probeTmux = deps.probeTmux ?? defaultProbeTmux;
  const verifyBinary = deps.verifyBinary ?? ((binary: string) => verifyLaunchable("claude", binary));
  const detectAuth = deps.detectAuth ?? detectClaudeAuth;
  const runSmoke = deps.runSmoke ?? defaultTuiSmoke;

  let resolvedBinary: string | undefined;

  return runLaunchProbe({
    resolve: async (): Promise<ResolveOutcome> => {
      const reasons: string[] = [];
      let version: string | null = null;

      const resolution = resolveExecutable();
      // `source: "default"` means no real binary was found — the SDK bundle is
      // not usable by the tmux runtime, so treat it as missing.
      const claudeBinary = resolution.source === "default" ? undefined : resolution.path;
      if (!claudeBinary) {
        reasons.push(
          "`claude` not found (checked CLAUDE_CODE_EXECUTABLE, PATH, and well-known install dirs like ~/.local/bin)",
        );
      } else {
        // existsSync is not enough — confirm the binary actually launches. A
        // failure here (non-executable, wrong arch, dud override) means the
        // runtime could not spawn the CLI at session time.
        const verified = await verifyBinary(claudeBinary);
        if (!verified.ok) {
          reasons.push(`\`claude\` at ${claudeBinary} could not be executed (${verified.error})`);
        } else {
          version = verified.version;
          resolvedBinary = claudeBinary;
        }
      }

      const tmux = probeTmux();
      if (tmux === null) reasons.push("tmux not found");
      else if (!tmuxMeetsMinimum(tmux)) {
        reasons.push(`tmux ${tmux.raw} is older than ${MIN_TMUX_MAJOR}.${MIN_TMUX_MINOR}`);
      }

      if (reasons.length > 0) return { ok: false, error: reasons.join("; ") };
      return { ok: true, binary: resolvedBinary, version };
    },
    authPrecheck: async (): Promise<AuthPrecheckOutcome> => {
      const auth = detectAuth();
      if (!auth.authenticated) {
        return {
          ok: false,
          error:
            "no Claude credentials found (ANTHROPIC_API_KEY unset and ~/.claude.json has no OAuth account); run `claude login` on this machine",
        };
      }
      return { ok: true, method: auth.method };
    },
    smoke: async (): Promise<SmokeOutcome> => {
      if (!resolvedBinary) {
        // Unreachable in practice: resolve fails when no binary verified.
        return { state: "error", error: "no resolved claude binary for smoke" };
      }
      return runSmoke(resolvedBinary);
    },
  });
}
