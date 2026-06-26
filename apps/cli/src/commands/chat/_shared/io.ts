import { readFile, stat } from "node:fs/promises";
import { fail } from "../../../cli/output.js";
import { channelConfig } from "../../../core/channel.js";
import { print } from "../../../core/output.js";

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
 * Resolve an outbound body from a `--message-file <path>` spec. `-` reads
 * stdin (the clig.dev convention); any other value is a filesystem path read
 * verbatim. Routing the body through a file or stdin — never an inline shell
 * argument — is the one robust fix for shell mangling: backticks (command
 * substitution), double quotes (early argument termination), apostrophes, and
 * newlines all reach the server byte-for-byte because the shell never
 * word-parses the file's contents. Unlike an inline body, a file body is NOT
 * run through `looksLikeEscapedNewlineBody`: a file can legitimately contain a
 * literal `\n`, and its real newlines already survive intact. Returns null
 * only when `-` is given but stdin is a TTY (nothing piped); the caller
 * surfaces its own "no body" error.
 */
export async function readMessageBody(spec: string): Promise<string | null> {
  if (spec === "-") return readStdin();

  // `.catch(() => null)` swallows only the stat() rejection (missing path /
  // permissions); the fail() calls below stay OUTSIDE any try so their
  // exit-throwing envelope is never caught and remapped here.
  const info = await stat(spec).catch(() => null);
  if (info === null) {
    return fail("MESSAGE_FILE_NOT_FOUND", `--message-file path does not exist or is not readable: ${spec}`, 2);
  }
  if (!info.isFile()) {
    return fail("MESSAGE_FILE_NOT_FILE", `--message-file is not a regular file: ${spec}`, 2);
  }
  if (info.size > MAX_STDIN_BYTES) {
    return fail("MESSAGE_FILE_TOO_LARGE", `--message-file exceeds the ${MAX_STDIN_BYTES}-byte limit: ${spec}`, 2);
  }
  return (await readFile(spec)).toString("utf-8");
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

/**
 * Guard an inline `--description` (chat update / create) exactly the way
 * `chat send` guards a message body. A chat description is authored markdown,
 * surfaced verbatim in the chat sidebar and in every agent's prompt. When its
 * newlines arrive as literal `\n` escapes — a one-line
 * `chat update --description "line1\n\nline2"` whose shell quotes never expand
 * `\n` — the stored value differs from the intended markdown structure and
 * renders as one long line with visible `\n` tokens. The correction belongs
 * before the write, not in UI rendering, so reject the malformed value here
 * with a copyable fix instead of persisting it.
 *
 * `supportsStdin` selects the escape hatch the hint offers: `chat update` has
 * no message body, so it can take the description from stdin via
 * `--description -`; `chat create` already consumes stdin for its initial
 * message, so it points to ANSI-C `$'...\n...'` quoting instead. Detection is
 * shared with the send-body guard (`looksLikeEscapedNewlineBody`): narrow by
 * design, so prose that merely mentions `\n` once stays writable.
 */
export function guardInlineDescription(value: string, opts: { supportsStdin: boolean }): void {
  if (!looksLikeEscapedNewlineBody(value)) return;
  const bin = channelConfig.binName;
  // The copyable retry form goes through `print.line` — plain multi-line
  // stderr text (silenced in --json mode). The fail envelope below stays a
  // single-line JSON object per the Print-layer contract; embedding the
  // heredoc example there would itself arrive `\n`-escaped, the exact bug.
  if (opts.supportsStdin) {
    print.line(
      "chat update: --description arrived with literal \\n escapes — shell quotes do not expand \\n, " +
        "so it would render as one long unformatted line in the chat sidebar. Resend with real newlines " +
        "via stdin:\n\n" +
        `  cat <<'EOF' | ${bin} chat update --description -\n` +
        "  first line\n" +
        "\n" +
        "  **second** line\n" +
        "  EOF\n\n" +
        "(or pass an ANSI-C quoted string: --description $'first line\\n\\n**second** line'. " +
        "stdin is not checked — pipe the body if literal \\n text is intentional.)\n\n",
    );
  } else {
    print.line(
      "chat create: --description arrived with literal \\n escapes — shell quotes do not expand \\n, " +
        "so it would render as one long unformatted line in the chat sidebar. Pass real newlines via an " +
        "ANSI-C quoted string instead:\n\n" +
        "  --description $'first line\\n\\n**second** line'\n\n",
    );
  }
  fail(
    "ESCAPED_NEWLINES",
    'Inline --description contains literal "\\n" escapes and no real newlines — it would render as one ' +
      "long unformatted line in the chat sidebar. " +
      (opts.supportsStdin
        ? "Resend the description via stdin (`--description -`) with real newlines, or use an ANSI-C $'...' " +
          "string (copyable forms printed above)."
        : "Use an ANSI-C $'...\\n...' string with real newlines (copyable form printed above)."),
    2,
  );
}

export function parseLimit(value: string, max: number): number {
  const limit = Number.parseInt(value, 10);
  if (Number.isNaN(limit) || limit < 1 || limit > max) {
    fail("INVALID_LIMIT", `Limit must be between 1 and ${max}.`, 2);
  }
  return limit;
}
