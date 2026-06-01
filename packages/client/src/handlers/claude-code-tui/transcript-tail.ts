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

/** Mapped event used by tests and for the askuser/text-accumulation paths in the handler. */
export type TranscriptEvent =
  | { kind: "user_text"; text: string; ts?: string }
  | { kind: "assistant_text"; text: string; ts?: string }
  | { kind: "tool_use"; toolUseId: string; name: string; input: unknown; ts?: string }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; content: unknown; ts?: string }
  | { kind: "thinking"; text: string; ts?: string };

type AnthropicBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  thinking?: string;
};

/**
 * Convert one transcript entry into zero or more TranscriptEvents. Mostly
 * used in tests; the live handler also uses it to pick out assistant text
 * (for forwardResult) and AskUser tool_use blocks (for the text-degrade path).
 */
export function transcriptEntryToEvents(entry: RawTranscriptEntry): TranscriptEvent[] {
  if (entry?.type === "user") {
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      const out: TranscriptEvent[] = [];
      for (const blk of content as AnthropicBlock[]) {
        if (blk.type === "tool_result") {
          out.push({
            kind: "tool_result",
            toolUseId: blk.tool_use_id ?? "",
            isError: blk.is_error === true,
            content: blk.content,
            ts: entry.timestamp,
          });
        }
      }
      return out;
    }
    if (typeof content === "string") {
      return [{ kind: "user_text", text: content, ts: entry.timestamp }];
    }
    return [];
  }
  if (entry?.type === "assistant") {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return [];
    const out: TranscriptEvent[] = [];
    for (const blk of content as AnthropicBlock[]) {
      if (blk.type === "text" && typeof blk.text === "string") {
        out.push({ kind: "assistant_text", text: blk.text, ts: entry.timestamp });
      } else if (blk.type === "tool_use") {
        out.push({
          kind: "tool_use",
          toolUseId: blk.id ?? "",
          name: blk.name ?? "",
          input: blk.input,
          ts: entry.timestamp,
        });
      } else if (blk.type === "thinking" && typeof blk.thinking === "string") {
        out.push({ kind: "thinking", text: blk.thinking, ts: entry.timestamp });
      }
    }
    return out;
  }
  return [];
}

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

  /** Convenience wrapper: read entries and immediately map them to events. */
  drainEvents(): TranscriptEvent[] {
    const out: TranscriptEvent[] = [];
    for (const entry of this.drainEntries()) {
      for (const ev of transcriptEntryToEvents(entry)) {
        out.push(ev);
      }
    }
    return out;
  }
}
