import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Resolve Claude Code's per-session transcript path.
 *
 * Encoding: cwd's `/` and `.` are replaced by `-`, prefixed with `-`. So
 * `/Users/alice/work.cd` becomes `-Users-alice-work-cd`. Verified empirically
 * on macOS during the PoC; if claude changes this rule, this is the single
 * point of update.
 *
 * Symlink note: claude derives the encoding from `process.cwd()` inside the
 * spawned binary, which the kernel returns with symlinks resolved (e.g. on
 * macOS `/var/folders/...` surfaces as `/private/var/folders/...`). Apply
 * `realpath` here so the tailer points at the same file claude writes,
 * even when the caller's `cwd` argument still contains an unresolved
 * symlink component. Falls back to the input on realpath errors so the
 * tailer can still operate against not-yet-created workspaces (the
 * existsSync guard inside drainEntries handles the missing-file window).
 *
 * The file is created lazily by claude on first message flush, so consumers
 * must tolerate `existsSync(path) === false` for a brief window after
 * session start.
 */
export function transcriptPathFor(cwd: string, sessionId: string): string {
  const absCwd = resolve(cwd);
  let realCwd = absCwd;
  try {
    realCwd = realpathSync(absCwd);
  } catch {
    // realpath fails if the dir doesn't exist yet — fall back to the
    // unresolved path; the caller may be racing dir creation.
  }
  const encoded = `-${realCwd.replace(/^\//, "").replace(/[/.]/g, "-")}`;
  return join(homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`);
}

/** Raw transcript entry — the JSON object claude wrote, in Anthropic message-stream shape. */
export type RawTranscriptEntry = {
  type?: string;
  message?: { content?: unknown };
  timestamp?: string;
  [key: string]: unknown;
};

/**
 * Fixed read-chunk size. Bounds the per-`drainEntries` peak allocation: new
 * data is streamed through one reused buffer of this size instead of a single
 * allocation proportional to the unread backlog.
 */
const READ_CHUNK_BYTES = 64 * 1024;

/** Newline as a byte. Never appears inside a multi-byte UTF-8 sequence. */
const NEWLINE_BYTE = 0x0a;

/**
 * Tail an append-only JSONL transcript. Each `drainEntries()` returns raw
 * entries appended since the last call. Tolerates the file not yet existing
 * (returns empty), partial lines across reads, and malformed JSON (single
 * bad line is skipped, not fatal).
 *
 * Pass `startAtEnd: true` to tail from the file's current end instead of
 * offset zero — required for resumed sessions, whose transcript already
 * contains the complete prior history. Reading that history would allocate
 * and parse the entire file just to discard it (see PERF-016).
 *
 * NOT thread-safe across instances — each session should own one tailer.
 */
export class TranscriptTailer {
  private readonly path: string;
  private offset = 0;
  /**
   * Bytes of a trailing incomplete line carried to the next read, as a list
   * of buffers so a line spanning many chunks is copied once when it
   * completes instead of re-concatenated per chunk. Kept as bytes (not a
   * string) so a multi-byte UTF-8 character split across two reads is
   * reassembled instead of decoded into replacement characters. Invariant:
   * never contains a newline byte.
   */
  private partialChunks: Buffer[] = [];

  constructor(path: string, options?: { startAtEnd?: boolean }) {
    this.path = path;
    if (options?.startAtEnd) {
      try {
        this.offset = statSync(path).size;
      } catch {
        // File not created yet (fresh session) — start from offset zero.
      }
    }
  }

  /** Read raw JSONL entries appended since the last call. Best-effort. */
  drainEntries(): RawTranscriptEntry[] {
    if (!existsSync(this.path)) return [];
    const stat = statSync(this.path);
    if (stat.size <= this.offset) return [];

    const entries: RawTranscriptEntry[] = [];
    const fd = openSync(this.path, "r");
    try {
      // Stream up to the stat-time size in bounded chunks. Data appended
      // after the stat is picked up by the next drain.
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, stat.size - this.offset));
      while (this.offset < stat.size) {
        const toRead = Math.min(chunk.length, stat.size - this.offset);
        const read = readSync(fd, chunk, 0, toRead, this.offset);
        if (read <= 0) break; // truncated/raced — retry on the next drain
        this.offset += read;
        this.consumeChunk(chunk.subarray(0, read), entries);
      }
    } finally {
      closeSync(fd);
    }
    return entries;
  }

  /**
   * Split a chunk on newline bytes, parse complete lines, carry the rest.
   * Only the new chunk is searched — the carry holds no newline by invariant.
   */
  private consumeChunk(chunk: Buffer, out: RawTranscriptEntry[]): void {
    const lastNewline = chunk.lastIndexOf(NEWLINE_BYTE);
    if (lastNewline === -1) {
      // No line completed in this chunk. Copy — `chunk` views a reused
      // read buffer that the next iteration overwrites.
      this.partialChunks.push(Buffer.from(chunk));
      return;
    }

    const complete =
      this.partialChunks.length > 0
        ? Buffer.concat([...this.partialChunks, chunk.subarray(0, lastNewline)])
        : chunk.subarray(0, lastNewline);
    this.partialChunks = lastNewline + 1 < chunk.length ? [Buffer.from(chunk.subarray(lastNewline + 1))] : [];

    for (const raw of complete.toString("utf-8").split("\n")) {
      if (!raw.trim()) continue;
      try {
        out.push(JSON.parse(raw) as RawTranscriptEntry);
      } catch {
        // skip malformed line
      }
    }
  }
}
