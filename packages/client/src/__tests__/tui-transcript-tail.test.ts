import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { type FileHandle, open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  type RawTranscriptEntry,
  TRANSCRIPT_MAX_LINE_BYTES,
  TRANSCRIPT_READ_CHUNK_BYTES,
  type TranscriptDrainResult,
  TranscriptTailer,
  transcriptPathFor,
} from "../handlers/claude-code-tui/transcript-tail.js";

describe("transcriptPathFor", () => {
  it("replaces forward-slashes and dots with dashes and prefixes with dash", () => {
    const path = transcriptPathFor("/Users/alice/work.cd", "abc-123");
    expect(path.endsWith("/.claude/projects/-Users-alice-work-cd/abc-123.jsonl")).toBe(true);
  });

  it("normalises to an absolute path before encoding", () => {
    const abs = transcriptPathFor("./relative", "id");
    // resolve() applied: starts from process.cwd() so the encoding includes more dashes
    expect(abs).toMatch(/\/\.claude\/projects\/-.+\/id\.jsonl$/);
  });
});

type FileHandleReadTarget = { read: FileHandle["read"] };

function hasFileHandleRead(value: unknown): value is FileHandleReadTarget {
  return typeof value === "object" && value !== null && "read" in value && typeof value.read === "function";
}

function transcriptLine(type: string, content: string): string {
  return JSON.stringify({ type, message: { content } });
}

function exactTranscriptLine(byteLength: number): string {
  const empty = transcriptLine("user", "");
  const fillerBytes = byteLength - Buffer.byteLength(empty);
  if (fillerBytes < 0) throw new Error(`line limit ${byteLength} is too small for the fixture`);
  const line = transcriptLine("user", "x".repeat(fillerBytes));
  if (Buffer.byteLength(line) !== byteLength) throw new Error("fixture did not reach the requested byte length");
  return line;
}

type DrainSummary = {
  entries: RawTranscriptEntry[];
  results: TranscriptDrainResult[];
  skippedOversizedLines: number;
};

async function drainWatermark(tailer: TranscriptTailer, watermark: number): Promise<DrainSummary> {
  const entries: RawTranscriptEntry[] = [];
  const results: TranscriptDrainResult[] = [];
  let skippedOversizedLines = 0;

  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    const result = await tailer.drainEntries(watermark);
    results.push(result);
    entries.push(...result.entries);
    skippedOversizedLines += result.skippedOversizedLines;
    if (result.bytesRead === 0 || !result.hasMore) return { entries, results, skippedOversizedLines };
  }
  throw new Error("tailer did not finish its fixed watermark");
}

async function drainCurrent(tailer: TranscriptTailer): Promise<DrainSummary> {
  return drainWatermark(tailer, await tailer.captureWatermark());
}

describe("TranscriptTailer", () => {
  let testDir: string;
  let filePath: string;
  let readSpy: MockInstance;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "tui-tail-"));
    filePath = join(testDir, "session.jsonl");

    // Spy on the real FileHandle prototype so assertions observe the actual
    // fs content-read calls and requested byte lengths used by the tailer.
    const probePath = join(testDir, "read-probe");
    writeFileSync(probePath, "");
    const handle = await openFile(probePath, "r");
    const prototype: unknown = Object.getPrototypeOf(handle);
    await handle.close();
    if (!hasFileHandleRead(prototype)) throw new Error("FileHandle.read prototype is unavailable");
    readSpy = vi.spyOn(prototype, "read");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  function requestedReadLengths(): number[] {
    return readSpy.mock.calls.flatMap((call) => (typeof call[2] === "number" ? [call[2]] : []));
  }

  it("returns empty when the file does not exist yet", async () => {
    const tailer = await TranscriptTailer.create(filePath);
    expect((await drainCurrent(tailer)).entries).toEqual([]);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("returns only new entries on each drain", async () => {
    writeFileSync(filePath, "");
    const tailer = await TranscriptTailer.create(filePath);

    appendFileSync(filePath, `${transcriptLine("user", "first")}\n`);
    const first = await drainCurrent(tailer);
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({ type: "user" });

    appendFileSync(filePath, `${transcriptLine("assistant", "second")}\n`);
    const second = await drainCurrent(tailer);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toMatchObject({ type: "assistant" });

    expect((await drainCurrent(tailer)).entries).toEqual([]);
  });

  it("buffers partial lines across separate appends", async () => {
    writeFileSync(filePath, "");
    const tailer = await TranscriptTailer.create(filePath);

    const piece1 = '{"type":"user","message":{"content":"half';
    const piece2 = ' message"}}\n';
    appendFileSync(filePath, piece1);
    expect((await drainCurrent(tailer)).entries).toEqual([]);

    appendFileSync(filePath, piece2);
    const entries = (await drainCurrent(tailer)).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "user", message: { content: "half message" } });
  });

  it("tolerates blank and malformed lines without failing the drain", async () => {
    writeFileSync(filePath, `\nthis is not json\n${transcriptLine("user", "ok")}\n`);
    const tailer = await TranscriptTailer.create(filePath);

    const entries = (await drainCurrent(tailer)).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "user" });
  });

  it("baselines a large resumed transcript at EOF with zero content reads, allocation, or parse", async () => {
    writeFileSync(filePath, "");
    const historyBytes = 32 * 1024 * 1024;
    truncateSync(filePath, historyBytes);
    const boundaryHandle = await openFile(filePath, "r+");
    await boundaryHandle.write(Buffer.from("\n"), 0, 1, historyBytes - 1);
    await boundaryHandle.close();
    readSpy.mockClear();
    const allocationSpy = vi.spyOn(Buffer, "allocUnsafe");
    const parseSpy = vi.spyOn(JSON, "parse");

    const tailer = await TranscriptTailer.create(filePath, { startAt: "end" });
    await tailer.discardToEnd();
    expect((await drainCurrent(tailer)).entries).toEqual([]);

    expect(readSpy).not.toHaveBeenCalled();
    expect(allocationSpy).not.toHaveBeenCalled();
    expect(parseSpy).not.toHaveBeenCalled();

    appendFileSync(filePath, `${transcriptLine("assistant", "new after resume")}\n`);
    const drained = await drainCurrent(tailer);
    expect(drained.entries).toEqual([{ type: "assistant", message: { content: "new after resume" } }]);
    expect(requestedReadLengths()).toEqual([
      1,
      Buffer.byteLength(`${transcriptLine("assistant", "new after resume")}\n`),
    ]);
  });

  it("drops a suffix when an end-started resume baseline itself is a stale partial record", async () => {
    writeFileSync(filePath, " ");
    const tailer = await TranscriptTailer.create(filePath, { startAt: "end" });
    await tailer.discardToEnd();

    const staleSuffix = transcriptLine("assistant", "resumed stale suffix");
    const fresh = transcriptLine("assistant", "fresh");
    appendFileSync(filePath, `${staleSuffix}\n${fresh}\n`);

    expect((await drainCurrent(tailer)).entries).toEqual([{ type: "assistant", message: { content: "fresh" } }]);
  });

  it("treats a missing end-started file as an EOF-zero baseline", async () => {
    const tailer = await TranscriptTailer.create(filePath, { startAt: "end" });
    writeFileSync(filePath, `${transcriptLine("assistant", "created later")}\n`);

    expect((await drainCurrent(tailer)).entries).toEqual([
      { type: "assistant", message: { content: "created later" } },
    ]);
  });

  it("uses bounded reads against a fixed watermark and defers concurrent appends", async () => {
    const maxReadBytes = 37;
    const initialLines = Array.from({ length: 12 }, (_, index) => transcriptLine("user", `initial-${index}`));
    writeFileSync(filePath, `${initialLines.join("\n")}\n`);
    const tailer = await TranscriptTailer.create(filePath, { maxReadBytes });
    const watermark = await tailer.captureWatermark();

    const first = await tailer.drainEntries(watermark);
    const lateLine = transcriptLine("assistant", "late-watermark");
    appendFileSync(filePath, `${lateLine}\n`);
    const remainder = await drainWatermark(tailer, watermark);
    const initialEntries = [...first.entries, ...remainder.entries];

    expect(initialEntries.map((entry) => entry.message?.content)).toEqual(
      initialLines.map((_, index) => `initial-${index}`),
    );
    expect(initialEntries.some((entry) => entry.message?.content === "late-watermark")).toBe(false);
    expect(requestedReadLengths().length).toBeGreaterThan(3);
    expect(Math.max(...requestedReadLengths())).toBeLessThanOrEqual(maxReadBytes);

    expect((await drainCurrent(tailer)).entries).toEqual([
      { type: "assistant", message: { content: "late-watermark" } },
    ]);
  });

  it("preserves one JSON record and UTF-8 code point across internal chunks", async () => {
    const content = `prefix-${"x".repeat(80)}-🙂-suffix`;
    const line = transcriptLine("assistant", content);
    const bytes = Buffer.from(`${line}\n`);
    const emojiOffset = bytes.indexOf(Buffer.from("🙂"));
    const maxReadBytes = emojiOffset + 1;
    writeFileSync(filePath, bytes);
    const tailer = await TranscriptTailer.create(filePath, { maxReadBytes });

    const drained = await drainCurrent(tailer);
    expect(drained.results.length).toBeGreaterThan(1);
    expect(drained.entries).toEqual([{ type: "assistant", message: { content } }]);
  });

  it("keeps continuous partial appends ordered and exactly once", async () => {
    const lineA = transcriptLine("user", "A");
    const lineB = transcriptLine("user", "B");
    const lineC = transcriptLine("user", "C");
    const lineD = transcriptLine("user", "D");
    const splitB = Math.floor(lineB.length / 2);
    const splitD = Math.floor(lineD.length / 2);
    writeFileSync(filePath, `${lineA}\n${lineB.slice(0, splitB)}`);
    const tailer = await TranscriptTailer.create(filePath, { maxReadBytes: 19 });

    const observed: RawTranscriptEntry[] = [];
    observed.push(...(await drainCurrent(tailer)).entries);
    appendFileSync(filePath, `${lineB.slice(splitB)}\n${lineC}\n${lineD.slice(0, splitD)}`);
    observed.push(...(await drainCurrent(tailer)).entries);
    appendFileSync(filePath, `${lineD.slice(splitD)}\n`);
    observed.push(...(await drainCurrent(tailer)).entries);

    expect(observed.map((entry) => entry.message?.content)).toEqual(["A", "B", "C", "D"]);
  });

  it("accepts an exact-limit line and recovers after an oversized line in the same chunk", async () => {
    const maxLineBytes = 128;
    const exactLine = exactTranscriptLine(maxLineBytes);
    const nextLine = transcriptLine("assistant", "after oversize");
    writeFileSync(filePath, `${exactLine}\n${"x".repeat(maxLineBytes + 1)}\n${nextLine}\n`);
    const tailer = await TranscriptTailer.create(filePath, { maxLineBytes, maxReadBytes: 512 });

    const drained = await drainCurrent(tailer);
    expect(drained.skippedOversizedLines).toBe(1);
    expect(drained.entries.map((entry) => entry.message?.content)).toEqual([
      "x".repeat(maxLineBytes - Buffer.byteLength(transcriptLine("user", ""))),
      "after oversize",
    ]);
  });

  it("counts one unterminated oversized line once across chunks and recovers after its newline", async () => {
    const maxLineBytes = 64;
    writeFileSync(filePath, "x".repeat(maxLineBytes * 3));
    const tailer = await TranscriptTailer.create(filePath, { maxLineBytes, maxReadBytes: 11 });

    const oversized = await drainCurrent(tailer);
    expect(oversized.entries).toEqual([]);
    expect(oversized.skippedOversizedLines).toBe(1);

    appendFileSync(filePath, `\n${transcriptLine("assistant", "recovered")}\n`);
    const recovered = await drainCurrent(tailer);
    expect(recovered.skippedOversizedLines).toBe(0);
    expect(recovered.entries).toEqual([{ type: "assistant", message: { content: "recovered" } }]);
  });

  it("discards stale complete and partial data without content I/O before the next turn", async () => {
    const stalePrefix = '{"type":"assistant","message":{"content":"stale';
    writeFileSync(filePath, stalePrefix);
    const tailer = await TranscriptTailer.create(filePath, { maxReadBytes: 17 });
    expect((await drainCurrent(tailer)).entries).toEqual([]);

    readSpy.mockClear();
    const allocationSpy = vi.spyOn(Buffer, "allocUnsafe");
    const parseSpy = vi.spyOn(JSON, "parse");
    await tailer.discardToEnd();
    expect(readSpy).not.toHaveBeenCalled();
    expect(allocationSpy).not.toHaveBeenCalled();
    expect(parseSpy).not.toHaveBeenCalled();

    appendFileSync(filePath, ` suffix"}}\n${transcriptLine("assistant", "fresh")}\n`);
    const drained = await drainCurrent(tailer);
    expect(drained.entries).toEqual([{ type: "assistant", message: { content: "fresh" } }]);
  });

  it("drops a stale partial suffix even when that record grew before the metadata-only discard", async () => {
    writeFileSync(filePath, " ");
    const tailer = await TranscriptTailer.create(filePath);
    expect((await drainCurrent(tailer)).entries).toEqual([]);

    // More stale bytes arrive before the preflush, but the record remains
    // unterminated. The stat-only discard cannot inspect them to decide
    // whether the old line completed.
    appendFileSync(filePath, "  ");
    await tailer.discardToEnd();

    const staleSuffix = transcriptLine("assistant", "stale suffix");
    const fresh = transcriptLine("assistant", "fresh");
    appendFileSync(filePath, `${staleSuffix}\n${fresh}\n`);
    expect((await drainCurrent(tailer)).entries).toEqual([{ type: "assistant", message: { content: "fresh" } }]);
  });

  it("uses the EOF byte when a completed stale line is followed by another stale partial", async () => {
    writeFileSync(filePath, " ");
    const tailer = await TranscriptTailer.create(filePath);
    expect((await drainCurrent(tailer)).entries).toEqual([]);

    appendFileSync(filePath, "\n ");
    await tailer.discardToEnd();

    const staleSuffix = transcriptLine("assistant", "second stale suffix");
    const fresh = transcriptLine("assistant", "fresh");
    appendFileSync(filePath, `${staleSuffix}\n${fresh}\n`);
    expect((await drainCurrent(tailer)).entries).toEqual([{ type: "assistant", message: { content: "fresh" } }]);
  });

  it("detects an unobserved stale partial appended after the previous clean drain", async () => {
    writeFileSync(filePath, `${transcriptLine("assistant", "previous")}\n`);
    const tailer = await TranscriptTailer.create(filePath);
    expect((await drainCurrent(tailer)).entries).toHaveLength(1);

    appendFileSync(filePath, " ");
    await tailer.discardToEnd();

    const staleSuffix = transcriptLine("assistant", "unobserved stale suffix");
    const fresh = transcriptLine("assistant", "fresh");
    appendFileSync(filePath, `${staleSuffix}\n${fresh}\n`);
    expect((await drainCurrent(tailer)).entries).toEqual([{ type: "assistant", message: { content: "fresh" } }]);
  });

  it("keeps the first fresh record when the stale partial completed before discard", async () => {
    const stalePrefix = '{"type":"assistant","message":{"content":"stale';
    writeFileSync(filePath, stalePrefix);
    const tailer = await TranscriptTailer.create(filePath, { maxReadBytes: 19 });
    expect((await drainCurrent(tailer)).entries).toEqual([]);

    appendFileSync(filePath, ' completed"}}\n');
    readSpy.mockClear();
    await tailer.discardToEnd();
    expect(readSpy).not.toHaveBeenCalled();

    appendFileSync(filePath, `${transcriptLine("assistant", "fresh")}\n`);
    expect((await drainCurrent(tailer)).entries).toEqual([{ type: "assistant", message: { content: "fresh" } }]);
    expect(requestedReadLengths()[0]).toBe(1);
  });

  it("rejects test overrides that would exceed the production safety bounds", async () => {
    await expect(TranscriptTailer.create(filePath, { maxReadBytes: TRANSCRIPT_READ_CHUNK_BYTES + 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(TranscriptTailer.create(filePath, { maxLineBytes: TRANSCRIPT_MAX_LINE_BYTES + 1 })).rejects.toThrow(
      RangeError,
    );
  });
});
