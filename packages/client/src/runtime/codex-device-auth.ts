import { type ChildProcess, spawn } from "node:child_process";

/**
 * Drive `codex login --device-auth` to completion on the daemon host and relay
 * its one-time device code to the operator's current screen (web console),
 * without the operator ever installing a separate `codex` CLI.
 *
 * Why this lives here, and why it parses human text:
 * codex (verified against codex-cli 0.130.0) has **no** `--json` for the
 * device-auth flow. The subcommand prints an ANSI-coloured, human-readable
 * prompt to stdout, then polls the provider until the user authorises on
 * another device, and on success writes `~/.codex/auth.json` itself (refresh
 * token included). So the only way to surface the verification URL + user code
 * to a headless/remote operator is to spawn the binary, parse that prompt, and
 * emit it as a STRUCTURED event upstream — raw stdout is ANSI noise and is not
 * safe to forward verbatim across channels. The parse is deliberately lenient
 * (strip ANSI, loose regex) and degrades to a raw-text fallback rather than
 * hard-failing, because the prompt wording is not a stable contract.
 *
 * Real 0.130.0 first-screen sample this parser is built against:
 *
 *   Follow these steps to sign in with ChatGPT using device code authorization:
 *   1. Open this link in your browser and sign in to your account
 *      https://auth.openai.com/codex/device
 *   2. Enter this one-time code (expires in 15 minutes)
 *      0WYJ-KDUHH
 */

/** Matches a CSI ANSI escape sequence (the colour codes in codex output). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping real ANSI escapes requires matching the ESC control char.
const ANSI_PATTERN = /\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** A verification URL pointing at the provider's device-authorization page. */
const VERIFICATION_URL_PATTERN = /https?:\/\/[^\s]*device[^\s]*/i;

/**
 * A device user code: groups of uppercase letters/digits joined by a dash
 * (e.g. `0WYJ-KDUHH`). Case-sensitive uppercase so prose words and the
 * dotted version string (`0.130.0`) cannot match.
 */
const USER_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;

const EXPIRES_PATTERN = /expires in (\d+)\s*minutes?/i;

export type DeviceCodePrompt = {
  /** Page the user opens on any device to enter the code. */
  verificationUrl: string;
  /** One-time code the user types on that page. */
  userCode: string;
  /** Minutes until the code expires, when the prompt states it. */
  expiresInMinutes?: number;
};

/**
 * Extract the device-code prompt from accumulated `codex login --device-auth`
 * output. Returns null until BOTH the verification URL and the user code are
 * present (they can arrive in separate stdout chunks), so a caller can re-run
 * this on a growing buffer and fire exactly once when the pair is complete.
 */
export function parseDeviceCodePrompt(rawOutput: string): DeviceCodePrompt | null {
  const text = stripAnsi(rawOutput);
  const url = text.match(VERIFICATION_URL_PATTERN);
  const code = text.match(USER_CODE_PATTERN);
  if (!url || !code) return null;
  const prompt: DeviceCodePrompt = { verificationUrl: url[0], userCode: code[0] };
  const minutesRaw = text.match(EXPIRES_PATTERN)?.[1];
  if (minutesRaw) {
    const minutes = Number.parseInt(minutesRaw, 10);
    if (Number.isFinite(minutes)) prompt.expiresInMinutes = minutes;
  }
  return prompt;
}

/** Terminal outcome of a device-auth login run. */
export type DeviceAuthOutcome =
  | { ok: true }
  | { ok: false; reason: "spawn-error" | "exit-nonzero" | "timeout" | "aborted" | "no-prompt"; error: string };

export type CodexDeviceAuthOptions = {
  /** Absolute path to the codex binary the runtime resolved (bundled or PATH). */
  binary: string;
  /** Environment for the child (e.g. CODEX_HOME); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Fired exactly once, when the verification URL + user code are first parsed
   * out of the child's output. This is the structured event the relay forwards
   * to the console.
   */
  onDeviceCode: (prompt: DeviceCodePrompt) => void;
  /**
   * Raw, ANSI-stripped output, for diagnostics / a raw-text fallback when the
   * parse never fires. Optional.
   */
  onRawOutput?: (chunk: string) => void;
  /** Abort the login (operator cancelled). */
  signal?: AbortSignal;
  /**
   * Hard ceiling for the whole flow. Codex states a 15-minute code expiry, so
   * the default leaves a little headroom past that.
   */
  timeoutMs?: number;
  /** Injectable spawn seam — tests pass a fake; production uses node spawn. */
  spawnFn?: typeof spawn;
};

/** Default whole-flow ceiling: just past codex's stated 15-minute code expiry. */
export const DEVICE_AUTH_TIMEOUT_MS = 16 * 60_000;

/**
 * Spawn `codex login --device-auth`, relay the device code as a structured
 * event, and resolve when the child exits. Success (`ok: true`) means codex
 * exited 0 — codex itself has written `~/.codex/auth.json`; the caller should
 * re-run the capability probe to flip the provider to `ok`.
 *
 * Never rejects: every failure mode resolves to `{ ok: false, reason, error }`
 * so the relay layer can map it onto a provider error state with a verbatim
 * reason rather than handling a throw.
 */
export function runCodexDeviceAuthLogin(options: CodexDeviceAuthOptions): Promise<DeviceAuthOutcome> {
  const { binary, onDeviceCode, onRawOutput, signal } = options;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEVICE_AUTH_TIMEOUT_MS;
  const spawnFn = options.spawnFn ?? spawn;

  return new Promise<DeviceAuthOutcome>((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, reason: "aborted", error: "device-auth aborted before start" });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnFn(binary, ["login", "--device-auth"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ ok: false, reason: "spawn-error", error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let buffer = "";
    let promptFired = false;
    let settled = false;
    let stderrTail = "";

    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout", error: `device-auth timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    const onAbort = (): void => {
      finish({ ok: false, reason: "aborted", error: "device-auth aborted by operator" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(outcome: DeviceAuthOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Kill the child on any non-clean-exit path (timeout/abort). A natural
      // exit has already gone; SIGKILL on an already-dead pid is a harmless noop.
      child.kill("SIGKILL");
      resolve(outcome);
    }

    function ingest(chunk: string): void {
      const clean = stripAnsi(chunk);
      onRawOutput?.(clean);
      buffer += chunk;
      if (promptFired) return;
      const prompt = parseDeviceCodePrompt(buffer);
      if (prompt) {
        promptFired = true;
        onDeviceCode(prompt);
      }
    }

    child.stdout?.on("data", (data: Buffer) => ingest(data.toString("utf-8")));
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf-8");
      stderrTail = stripAnsi(stderrTail + text).slice(-500);
      ingest(text);
    });

    child.on("error", (err) => {
      finish({ ok: false, reason: "spawn-error", error: err.message });
    });

    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      // Exited nonzero. If we never even surfaced a code, say so explicitly —
      // that is the parse-failure / version-drift signal the caller degrades on.
      const reason = promptFired ? "exit-nonzero" : "no-prompt";
      const detail = stderrTail.trim() || `codex login --device-auth exited with code ${code ?? "unknown"}`;
      finish({ ok: false, reason, error: detail });
    });
  });
}
