import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { classify, ERROR_KINDS, getChildProcessRegistry } from "@first-tree/client";
import { print } from "./output.js";

/**
 * The npm package that carries the native Claude Code engine. Installing it
 * globally exposes a `claude` executable on PATH. This is the engine First Tree
 * intentionally does NOT bundle by default — the runtime resolves a system
 * `claude` (env override / PATH / well-known install dirs; see
 * packages/client/src/handlers/claude-executable.ts), and this one-click
 * install is the remediation when none exists.
 */
const CLAUDE_RUNTIME_PACKAGE = "@anthropic-ai/claude-code";

/** Hard ceiling on the install (the native engine download is large; 8 min). */
const CLAUDE_INSTALL_TIMEOUT_MS = 8 * 60 * 1000;

export type InstallClaudeResult =
  | { ok: true; installedVersion: string | null }
  | { ok: false; reason: string; retryable: boolean; reasonCode: string };

/** Same defensive contract as the self-update spec guard. */
function isSafeInstallSpec(spec: string): boolean {
  if (typeof spec !== "string" || spec.length === 0 || spec.length > 128) return false;
  if (spec.startsWith("-")) return false;
  return /^[A-Za-z0-9.+-]+$/.test(spec);
}

/** Pick the `npm` binary, preferring the sibling of the launching Node. */
function resolveNpmCommand(): string {
  const binName = process.platform === "win32" ? "npm.cmd" : "npm";
  const sibling = join(dirname(process.execPath), binName);
  if (existsSync(sibling)) return sibling;
  return "npm";
}

function parseInstalledVersion(stdout: string): string | null {
  // npm prints `+ @anthropic-ai/claude-code@2.1.84` (legacy) or `added N packages` lines.
  const match = stdout.match(/@anthropic-ai\/claude-code@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)/);
  return match ? match[1] : null;
}

/**
 * Install the native Claude Code runtime globally
 * (`npm install -g @anthropic-ai/claude-code@<spec>`).
 *
 * This is the daemon's one-click remediation for a host with no `claude` on
 * PATH: it runs the same tracked-subprocess install path the CLI self-update
 * uses (reaped on shutdown, hard-timeout, error-taxonomy classification), then
 * the caller is expected to re-probe the claude-code capability so the new
 * binary is picked up via PATH resolution. Does not exit the process.
 */
export async function installClaudeRuntime(spec = "latest"): Promise<InstallClaudeResult> {
  if (!isSafeInstallSpec(spec)) {
    return {
      ok: false,
      reason: `Refusing to install: invalid npm spec ${JSON.stringify(spec)}`,
      retryable: false,
      reasonCode: "invalid_spec",
    };
  }

  return new Promise((resolvePromise) => {
    const npmCmd = resolveNpmCommand();
    const npmArgs = ["install", "-g", `${CLAUDE_RUNTIME_PACKAGE}@${spec}`];
    const { child } = getChildProcessRegistry().spawn(npmCmd, npmArgs, {
      category: "npm-install",
      label: `npm install -g ${CLAUDE_RUNTIME_PACKAGE}@${spec}`,
      timeoutMs: CLAUDE_INSTALL_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      print.line(chunk.toString("utf8"));
    });

    child.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      const classification = classify(err, { source: "update" });
      resolvePromise({
        ok: false,
        reason: message,
        retryable: classification.kind === ERROR_KINDS.TRANSIENT,
        reasonCode: classification.reasonCode,
      });
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        resolvePromise({ ok: true, installedVersion: parseInstalledVersion(stdout) });
        return;
      }
      if (code === null && signal) timedOut = true;
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const reason = `npm install -g ${CLAUDE_RUNTIME_PACKAGE} ${
        timedOut ? `killed by signal ${signal} (timeout)` : `exited with code ${code}`
      }${stderr ? `: ${stderr.split("\n").slice(-3).join(" | ")}` : ""}`;
      const classification = timedOut
        ? { kind: ERROR_KINDS.TRANSIENT, reasonCode: "npm_timeout" as const }
        : classify(new Error(reason), { source: "update" });
      resolvePromise({
        ok: false,
        reason,
        retryable: classification.kind === ERROR_KINDS.TRANSIENT,
        reasonCode: classification.reasonCode,
      });
    });
  });
}
