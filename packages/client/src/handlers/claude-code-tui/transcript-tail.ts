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
 * Tail an append-only JSONL transcript. Each `drainEntries()` returns raw
 * entries appended since the last call. Tolerates the file not yet existing
 * (returns empty), partial lines across reads, and malformed JSON (single
 * bad line is skipped, not fatal).
 *
 * NOT thread-safe across instances — each session should own one tailer.
 */
export class TranscriptTailer {
  private readonly path: string;
  private offset = 0;
  private partial = "";

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Skip everything currently in the file without reading or parsing it.
   * Used to initialize a resume tail at EOF (the historical transcript is
   * never consumed) and to pre-flush a prior turn's leftover entries.
   * A missing file is a no-op — the tailer still starts at offset 0 for
   * the not-yet-created transcript.
   */
  seekToEnd(): void {
    if (!existsSync(this.path)) return;
    this.offset = statSync(this.path).size;
    this.partial = "";
  }

  /** Read raw JSONL entries appended since the last call. Best-effort. */
  drainEntries(): RawTranscriptEntry[] {
    if (!existsSync(this.path)) return [];
    const stat = statSync(this.path);
    if (stat.size <= this.offset) return [];

    const fd = openSync(this.path, "r");
    let chunk = "";
    try {
      const buf = Buffer.allocUnsafe(stat.size - this.offset);
      const read = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += read;
      chunk = this.partial + buf.subarray(0, read).toString("utf-8");
    } finally {
      closeSync(fd);
    }

    const parts = chunk.split("\n");
    this.partial = parts.pop() ?? "";

    const entries: RawTranscriptEntry[] = [];
    for (const raw of parts) {
      if (!raw.trim()) continue;
      try {
        entries.push(JSON.parse(raw) as RawTranscriptEntry);
      } catch {
        // skip malformed line
      }
    }
    return entries;
  }
}
