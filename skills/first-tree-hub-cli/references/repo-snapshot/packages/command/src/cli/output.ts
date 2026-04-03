/** Write a success JSON envelope to stdout. */
export function success(data: unknown): void {
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
}

/** Write an error JSON envelope to stderr and exit with the given code. */
export function fail(code: string, message: string, exitCode = 1): never {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  process.exit(exitCode);
}
