import { realpathSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

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

/** Bytes per read call — one reusable buffer of (at most) this size per drain. */
const DRAIN_CHUNK_BYTES = 256 * 1024;
/**
 * Raw-byte ceiling for a single `drainEntries()` batch. Keeps per-drain memory
 * constant regardless of how much the transcript grew between polls; callers
 * loop until an empty batch to fully catch up. Both sizes are deliberately
 * hard-coded (with test-only overrides): they are private tuning knobs of this
 * tailer, not user configuration.
 */
const MAX_DRAIN_BATCH_BYTES = 4 * 1024 * 1024;

/** Test-only overrides for the read sizes; production paths use the defaults. */
type TranscriptTailerOptions = {
  chunkBytes?: number;
  maxBatchBytes?: number;
};

/**
 * Tail an append-only JSONL transcript. Each `drainEntries()` returns raw
 * entries appended since the last call, reading a bounded number of bytes per
 * call — callers loop until an empty batch to fully catch up. A tailer
 * constructed over an already-existing file starts at its current EOF (resume
 * semantics): prior-session history is skipped via metadata only, never read,
 * because historical entries must not be replayed into the current turn.
 * Tolerates the file not yet existing (returns empty), partial lines across
 * reads, and malformed JSON (single bad line is skipped, not fatal).
 *
 * NOT thread-safe across instances — each session should own one tailer.
 */
export class TranscriptTailer {
  private readonly path: string;
  private readonly chunkBytes: number;
  private readonly maxBatchBytes: number;
  private offset = 0;
  /**
   * Trailing bytes of the last drained chunk that did not yet end in a
   * newline. Bounded by the length of a single JSONL line (claude writes one
   * entry per line), not by file size. There is deliberately no hard cap:
   * enforcing one would need a skip-until-next-newline recovery state machine,
   * which today's writer behaviour does not justify.
   */
  private partial = "";
  /** Carries multi-byte UTF-8 sequences split across chunk AND drain boundaries. */
  private decoder = new StringDecoder("utf8");

  constructor(path: string, options?: TranscriptTailerOptions) {
    this.path = path;
    this.chunkBytes = options?.chunkBytes ?? DRAIN_CHUNK_BYTES;
    this.maxBatchBytes = options?.maxBatchBytes ?? MAX_DRAIN_BATCH_BYTES;
    // Resume-at-EOF: when the transcript already exists (resume), start at its
    // current end. The history was already consumed by the prior session and
    // must never re-enter this one — see skipToEnd(). A single O(1) metadata
    // stat per session start.
    try {
      this.offset = statSync(path).size;
    } catch {
      // Not created yet (claude writes the file lazily) — start at 0.
    }
  }

  /**
   * Jump the tail position to the file's current EOF without reading any
   * content, discarding buffered partial-line state. This is the pre-turn
   * flush: whatever the prior turn (or, on resume, the prior session) left in
   * the transcript is dropped in O(1). Historical entries must never reach the
   * turn consumers — they would be replayed as this turn's output.
   */
  async skipToEnd(): Promise<void> {
    try {
      this.offset = (await stat(this.path)).size;
    } catch {
      // Keep the current offset on stat failure (lazy-creation window, or a
      // transient error such as EMFILE/EACCES). Resetting to 0 would make the
      // next drain re-read — and replay — the entire transcript.
    }
    this.partial = "";
    this.decoder = new StringDecoder("utf8");
  }

  /**
   * Read raw JSONL entries appended since the last call, up to
   * `maxBatchBytes` raw bytes per call. Best-effort.
   */
  async drainEntries(): Promise<RawTranscriptEntry[]> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      // File not created yet — claude writes it on the first message flush.
      return [];
    }

    if (size < this.offset) {
      // The file shrank: external truncation/rotation, never claude's own
      // append-only writes. Bytes at the old offset no longer mean what they
      // did, so clamp to the new EOF (mirroring resume-at-EOF) instead of
      // re-reading from 0, which would replay the rewritten file's content as
      // this turn's output. All three pieces of tail state reset together.
      this.offset = size;
      this.partial = "";
      this.decoder = new StringDecoder("utf8");
      return [];
    }
    // `partial`/`decoder` must survive this early return: a half-written line
    // from the previous drain may still be waiting for its terminator.
    if (size === this.offset) return [];

    const target = Math.min(size, this.offset + this.maxBatchBytes);
    const buf = Buffer.allocUnsafe(Math.min(this.chunkBytes, target - this.offset));
    let text = "";
    const fd = await open(this.path, "r");
    try {
      while (this.offset < target) {
        const wanted = Math.min(buf.length, target - this.offset);
        // Position is passed explicitly on every read — never rely on the
        // fd's implicit cursor.
        const { bytesRead } = await fd.read(buf, 0, wanted, this.offset);
        // stat→read TOCTOU: a zero-byte read means the file was truncated
        // after the stat above — treat it as EOF for this batch.
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        // Decode only the freshly read prefix — the buffer's tail still holds
        // stale bytes from the previous iteration. The decoder buffers a
        // trailing incomplete UTF-8 sequence instead of emitting U+FFFD.
        text += this.decoder.write(buf.subarray(0, bytesRead));
      }
    } finally {
      await fd.close();
    }

    const chunk = this.partial + text;
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
