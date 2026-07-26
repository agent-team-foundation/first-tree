/**
 * Print layer — the only place CLI code should write to stdout/stderr.
 *
 * Contract:
 * - `print.result(data)` / `print.fail(...)` emit machine-readable JSON on
 *   stdout / stderr respectively. Scripts pipe into `jq` and expect a clean
 *   envelope, so nothing else may touch stdout.
 * - `print.status` / `print.check` / `print.blank` / `print.line` are
 *   human-friendly and go to stderr so they never pollute a redirected stdout.
 *   In `--json` mode they are silenced — scripted consumers only care about
 *   the envelope.
 */

let jsonMode = false;

export type PrintErrorMetadata = {
  status?: string;
};

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

function result(data: unknown): void {
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
}

function fail(code: string, message: string, exitCode = 1, metadata?: PrintErrorMetadata): never {
  const status = metadata?.status;
  const error = status === undefined ? { code, message } : { code, message, status };
  process.stderr.write(`${JSON.stringify({ ok: false, error })}\n`);
  process.exit(exitCode);
}

function status(label: string, message: string): void {
  if (jsonMode) return;
  process.stderr.write(`  ${label.padEnd(20)} ${message}\n`);
}

function check(pass: boolean, label: string, detail = ""): void {
  if (jsonMode) return;
  const icon = pass ? "✓" : "✗";
  const tail = detail ? ` ${detail}` : "";
  process.stderr.write(`  ${icon} ${label.padEnd(22)}${tail}\n`);
}

function blank(): void {
  if (jsonMode) return;
  process.stderr.write("\n");
}

/**
 * Generic stderr writer for pre-formatted human text (multi-line tables,
 * interactive prompts). Prefer `status` / `check` when the text fits; this
 * exists so the `--json` mode gate can silence arbitrary human chatter.
 */
function line(text: string): void {
  if (jsonMode) return;
  process.stderr.write(text);
}

export const print = { result, fail, status, check, blank, line };

// Backward-compatible named exports — callers that still import `status`
// / `blank` directly keep working while the sweep to `print.*` completes.
export { blank, status };
