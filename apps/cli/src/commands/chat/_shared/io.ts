import { fail } from "../../../cli/output.js";

const MAX_STDIN_BYTES = 5 * 1024 * 1024;

/** Buffer stdin (text only). Returns null when stdin is a TTY (no pipe). */
export function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    process.stdin.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        reject(new Error(`stdin exceeds ${MAX_STDIN_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

/**
 * Detect an inline message body whose newlines arrived as the two-character
 * escape sequence `\n` instead of real newlines. POSIX shells do not expand
 * `\n` inside single or double quotes, so a one-line
 * `chat send <name> "line1\n\n**line2**"` stores a literal backslash-n body
 * that the web UI renders as one long unformatted line — the markdown
 * structure never starts at a line beginning. Models that compose one-line
 * shell commands hit this shape often (and self-imitate it for the rest of
 * the session), so `chat send` rejects it with a how-to-fix hint instead of
 * persisting a broken row.
 *
 * Deliberately narrow, to keep prose that *mentions* the token sendable:
 * - at least two escaped `\n` occurrences (a multi-line intent), and
 * - zero real newlines (any real newline proves the formatting arrived
 *   intact — e.g. ANSI-C `$'...\n...'` quoting expands before we see it).
 * Bodies piped via stdin are never checked: stdin/heredoc is both the fix
 * and the escape hatch for intentionally sending literal `\n` text.
 */
export function looksLikeEscapedNewlineBody(body: string): boolean {
  if (body.includes("\n")) return false;
  const escapes = body.match(/\\n/g);
  return (escapes?.length ?? 0) >= 2;
}

export function parseLimit(value: string, max: number): number {
  const limit = Number.parseInt(value, 10);
  if (Number.isNaN(limit) || limit < 1 || limit > max) {
    fail("INVALID_LIMIT", `Limit must be between 1 and ${max}.`, 2);
  }
  return limit;
}
