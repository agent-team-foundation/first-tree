import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { classify, ERROR_KINDS, getChildProcessRegistry } from "@first-tree/client";
import { errorMessage } from "./error-message.js";
import { print } from "./output.js";

/**
 * The npm package that carries the native Codex engine. Installing it globally
 * exposes a `codex` executable on PATH (and pulls the platform-specific
 * `@openai/codex-{platform}` binary as an optionalDependency). This is the
 * package First Tree intentionally does NOT bundle by default — the runtime
 * resolves a system `codex` on PATH, and this one-click install is the
 * remediation when none exists.
 */
const CODEX_RUNTIME_PACKAGE = "@openai/codex";

/** Hard ceiling on the install (the native engine download is large; 8 min). */
const CODEX_INSTALL_TIMEOUT_MS = 8 * 60 * 1000;

export type InstallCodexResult =
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
  return existsSync(sibling) ? sibling : binName;
}

function parseInstalledVersion(stdout: string): string | null {
  // npm prints `+ @openai/codex@0.140.0` (legacy) or `added 1 package` lines.
  const match = stdout.match(/@openai\/codex@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)/);
  return match ? match[1] : null;
}

/**
 * Install the native Codex runtime globally (`npm install -g @openai/codex@<spec>`).
 *
 * This is the daemon's one-click remediation for a host with no `codex` on
 * PATH: it runs the same tracked-subprocess install path the CLI self-update
 * uses (reaped on shutdown, hard-timeout, error-taxonomy classification), then
 * the caller is expected to re-probe the codex capability so the new binary is
 * picked up via PATH resolution. Does not exit the process.
 */
export async function installCodexRuntime(spec = "latest"): Promise<InstallCodexResult> {
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
    const npmArgs = ["install", "-g", `${CODEX_RUNTIME_PACKAGE}@${spec}`];
    const { child } = getChildProcessRegistry().spawn(npmCmd, npmArgs, {
      category: "npm-install",
      label: `npm install -g ${CODEX_RUNTIME_PACKAGE}@${spec}`,
      timeoutMs: CODEX_INSTALL_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
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
      const message = errorMessage(err);
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
      const reason = `npm install -g ${CODEX_RUNTIME_PACKAGE} ${
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
