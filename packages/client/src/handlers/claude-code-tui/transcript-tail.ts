import { realpathSync } from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Maximum content bytes read by one {@link TranscriptTailer.drainEntries} call. */
export const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;

/**
 * Maximum bytes retained for one incomplete JSONL record.
 *
 * This is a First Tree ingestion safety limit, not a guarantee made by the
 * provider. A larger record is skipped through its newline so a corrupt or
 * unterminated transcript line cannot grow one runtime session without bound.
 */
export const TRANSCRIPT_MAX_LINE_BYTES = 8 * 1024 * 1024;

const NEWLINE_BYTE = 0x0a;

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
 * missing-file guards inside the tailer handle the lazy-create window).
 *
 * The file is created lazily by claude on first message flush, so consumers
 * must tolerate the path not existing for a brief window after session start.
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

export type TranscriptStartPosition = "start" | "end";

export type TranscriptTailerOptions = {
  startAt?: TranscriptStartPosition;
  maxReadBytes?: number;
  maxLineBytes?: number;
};

export type TranscriptDrainResult = {
  entries: RawTranscriptEntry[];
  bytesRead: number;
  /** Whether unread bytes remain below the fixed watermark supplied by the caller. */
  hasMore: boolean;
  /** Oversized records first encountered in this chunk. Each record is counted once. */
  skippedOversizedLines: number;
};

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertBoundedPositiveInteger(name: string, value: number, upperBound: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > upperBound) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${upperBound}`);
  }
}

function isRawTranscriptEntry(value: unknown): value is RawTranscriptEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tail an append-only JSONL transcript.
 *
 * Callers freeze an EOF watermark with {@link captureWatermark}, then call
 * {@link drainEntries} until `hasMore` is false. Every content read is bounded
 * and relative to that fixed watermark, so a continuously-growing writer
 * cannot keep one drain pass alive forever. Incomplete records are retained as
 * byte fragments (not repeatedly-concatenated strings) and are bounded by
 * {@link TRANSCRIPT_MAX_LINE_BYTES}.
 *
 * NOT thread-safe across instances or overlapping drains — each session owns
 * one tailer and serialises calls through its handler turn loop.
 */
export class TranscriptTailer {
  private offset = 0;
  private partialFragments: Buffer[] = [];
  private partialBytes = 0;
  private droppingOversizedLine = false;
  private droppingDiscardedLine = false;
  private discardedBoundaryProbe: number | null = null;

  private constructor(
    private readonly path: string,
    private readonly maxReadBytes: number,
    private readonly maxLineBytes: number,
  ) {}

  /**
   * Create a tailer and, for resume mode, establish its EOF baseline before
   * returning. ENOENT is the expected lazy-create window; other metadata
   * failures reject so the handler can tear down the provider session.
   */
  static async create(path: string, options: TranscriptTailerOptions = {}): Promise<TranscriptTailer> {
    const startAt = options.startAt ?? "start";
    const maxReadBytes = options.maxReadBytes ?? TRANSCRIPT_READ_CHUNK_BYTES;
    const maxLineBytes = options.maxLineBytes ?? TRANSCRIPT_MAX_LINE_BYTES;
    assertBoundedPositiveInteger("maxReadBytes", maxReadBytes, TRANSCRIPT_READ_CHUNK_BYTES);
    assertBoundedPositiveInteger("maxLineBytes", maxLineBytes, TRANSCRIPT_MAX_LINE_BYTES);

    const tailer = new TranscriptTailer(path, maxReadBytes, maxLineBytes);
    if (startAt === "end") {
      const size = await tailer.statSize();
      if (size !== null) {
        tailer.offset = size;
        if (size > 0) tailer.discardedBoundaryProbe = size - 1;
      }
    }
    return tailer;
  }

  /**
   * Freeze the current EOF for one finite catch-up pass.
   *
   * A transcript absent during construction is baselined at the then-current
   * EOF of zero, so bytes created afterward are eligible for the next drain.
   */
  async captureWatermark(): Promise<number> {
    const size = await this.statSize();
    if (size === null) return this.offset;
    return size;
  }

  /**
   * Discard everything present before a provider turn without reading or
   * parsing content. This is the turn preflush boundary.
   */
  async discardToEnd(): Promise<void> {
    const previousOffset = this.offset;
    const hadIncompleteLine =
      this.partialBytes > 0 ||
      this.droppingOversizedLine ||
      this.droppingDiscardedLine ||
      this.discardedBoundaryProbe !== null;
    const size = await this.statSize();
    this.offset = size ?? 0;
    const needsBoundaryResolution = hadIncompleteLine || this.offset > previousOffset;
    this.clearParserState();

    // A metadata-only discard cannot tell whether unseen growth, or the new
    // EOF of an already-observed partial record, ends at a JSONL boundary.
    // Retain only the final byte's offset, not its content: once fresh bytes
    // exist, the next bounded drain probes that byte. LF proves the baseline
    // is at a record boundary; any other byte means a later suffix must be
    // ignored through its newline. This avoids both stale replay and dropping
    // the first fresh record in the ambiguous race.
    if (needsBoundaryResolution && this.offset > 0) {
      this.discardedBoundaryProbe = this.offset - 1;
    } else {
      this.droppingDiscardedLine = needsBoundaryResolution;
    }
  }

  /** Read at most one bounded chunk up to a caller-frozen EOF watermark. */
  async drainEntries(watermark: number): Promise<TranscriptDrainResult> {
    if (!Number.isSafeInteger(watermark) || watermark < 0) {
      throw new RangeError("watermark must be a non-negative safe integer");
    }
    if (watermark <= this.offset) return this.emptyDrain();
    const discardedBoundaryProbe = this.discardedBoundaryProbe;

    const readOffset = discardedBoundaryProbe ?? this.offset;
    const requestedBytes = discardedBoundaryProbe === null ? Math.min(this.maxReadBytes, watermark - this.offset) : 1;

    let handle: FileHandle;
    try {
      handle = await open(this.path, "r");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return this.emptyDrain(this.discardedBoundaryProbe !== null || this.offset < watermark);
      }
      throw error;
    }

    let bytesRead = 0;
    let chunk = Buffer.alloc(0);
    try {
      const buffer = Buffer.allocUnsafe(requestedBytes);
      const result = await handle.read(buffer, 0, requestedBytes, readOffset);
      bytesRead = result.bytesRead;
      chunk = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }

    if (bytesRead === 0) {
      return this.emptyDrain(this.discardedBoundaryProbe !== null || this.offset < watermark);
    }
    if (discardedBoundaryProbe !== null) {
      this.discardedBoundaryProbe = null;
      this.droppingDiscardedLine = chunk[0] !== NEWLINE_BYTE;
      return {
        entries: [],
        bytesRead,
        hasMore: this.offset < watermark,
        skippedOversizedLines: 0,
      };
    }

    this.offset = readOffset + bytesRead;
    const parsed = this.parseChunk(chunk);
    return {
      ...parsed,
      bytesRead,
      // Zero progress is handled above. `hasMore` is deliberately relative to
      // this call's fixed watermark, never a newly-statted live EOF.
      hasMore: this.offset < watermark,
    };
  }

  private async statSize(): Promise<number | null> {
    try {
      const metadata = await stat(this.path);
      return metadata.size;
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  private emptyDrain(hasMore = false): TranscriptDrainResult {
    return { entries: [], bytesRead: 0, hasMore, skippedOversizedLines: 0 };
  }

  private clearParserState(): void {
    this.partialFragments = [];
    this.partialBytes = 0;
    this.droppingOversizedLine = false;
    this.droppingDiscardedLine = false;
    this.discardedBoundaryProbe = null;
  }

  private dropThroughNewline(chunk: Buffer, cursor: number): number | null {
    const newline = chunk.indexOf(NEWLINE_BYTE, cursor);
    if (newline < 0) return null;
    this.droppingOversizedLine = false;
    this.droppingDiscardedLine = false;
    return newline + 1;
  }

  private parseChunk(chunk: Buffer): Pick<TranscriptDrainResult, "entries" | "skippedOversizedLines"> {
    const entries: RawTranscriptEntry[] = [];
    let skippedOversizedLines = 0;
    let cursor = 0;

    while (cursor < chunk.length) {
      if (this.droppingOversizedLine || this.droppingDiscardedLine) {
        const next = this.dropThroughNewline(chunk, cursor);
        if (next === null) break;
        cursor = next;
        continue;
      }

      const newline = chunk.indexOf(NEWLINE_BYTE, cursor);
      const segmentEnd = newline < 0 ? chunk.length : newline;
      const segment = chunk.subarray(cursor, segmentEnd);
      const remainingLineBytes = this.maxLineBytes - this.partialBytes;

      if (segment.length > remainingLineBytes) {
        // Count at the first byte beyond the limit, then retain no content
        // while skipping through this record's newline (possibly in a later
        // chunk). This makes one oversized record exactly one skip.
        skippedOversizedLines += 1;
        this.partialFragments = [];
        this.partialBytes = 0;
        if (newline < 0) {
          this.droppingOversizedLine = true;
          break;
        }
        cursor = newline + 1;
        continue;
      }

      if (newline < 0) {
        if (segment.length > 0) {
          // Copy only the exact fragment; retaining a subarray would keep the
          // whole read buffer alive and defeat the incomplete-record bound.
          this.partialFragments.push(Buffer.from(segment));
          this.partialBytes += segment.length;
        }
        break;
      }

      const entry = this.parseCompleteLine(segment);
      if (entry) entries.push(entry);
      cursor = newline + 1;
    }

    return { entries, skippedOversizedLines };
  }

  private parseCompleteLine(finalSegment: Buffer): RawTranscriptEntry | null {
    const lineBytes = this.partialBytes + finalSegment.length;
    let line: Buffer;
    if (this.partialFragments.length === 0) {
      line = finalSegment;
    } else {
      const fragments = finalSegment.length > 0 ? [...this.partialFragments, finalSegment] : this.partialFragments;
      line = Buffer.concat(fragments, lineBytes);
    }
    this.partialFragments = [];
    this.partialBytes = 0;

    const raw = line.toString("utf-8");
    if (!raw.trim()) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRawTranscriptEntry(parsed) ? parsed : null;
    } catch {
      // One malformed completed line is best-effort skipped, not fatal.
      return null;
    }
  }
}
