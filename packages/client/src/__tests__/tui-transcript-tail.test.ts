import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RawTranscriptEntry,
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

describe("TranscriptTailer", () => {
  let testDir: string;
  let filePath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "tui-tail-"));
    filePath = join(testDir, "session.jsonl");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function line(type: string, content: unknown): string {
    return `${JSON.stringify({ type, message: { content } })}\n`;
  }

  async function drainAll(tailer: TranscriptTailer): Promise<RawTranscriptEntry[]> {
    const all: RawTranscriptEntry[] = [];
    while (true) {
      const batch = await tailer.drainEntries();
      if (batch.length === 0) return all;
      all.push(...batch);
    }
  }

  it("returns empty when the file does not exist yet", async () => {
    const tailer = new TranscriptTailer(filePath);
    expect(await tailer.drainEntries()).toEqual([]);
  });

  it("returns only new entries on each drain", async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    appendFileSync(filePath, line("user", "first"));
    const first = await tailer.drainEntries();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: "user" });

    appendFileSync(filePath, line("assistant", []));
    const second = await tailer.drainEntries();
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ type: "assistant" });

    expect(await tailer.drainEntries()).toEqual([]);
  });

  it("buffers partial lines across reads", async () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    const piece1 = '{"type":"user","message":{"content":"half';
    const piece2 = ' message"}}\n';
    appendFileSync(filePath, piece1);
    expect(await tailer.drainEntries()).toEqual([]);

    appendFileSync(filePath, piece2);
    const entries = await tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "user", message: { content: "half message" } });
  });

  it("tolerates malformed lines without failing the drain", async () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    appendFileSync(filePath, "this is not json\n");
    appendFileSync(filePath, line("user", "ok"));

    const entries = await tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "user" });
  });

  it("starts at EOF when the file already contains history (resume)", async () => {
    writeFileSync(filePath, "");
    for (let i = 0; i < 50; i++) {
      appendFileSync(filePath, line("user", `old ${i}`));
    }

    const tailer = new TranscriptTailer(filePath);
    expect(await tailer.drainEntries()).toEqual([]);

    appendFileSync(filePath, line("assistant", "fresh"));
    const entries = await tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "assistant", message: { content: "fresh" } });
  });

  it("does not read a large pre-existing transcript on resume", async () => {
    // ~10 MiB of history. Behavioural assertion only (no timing, which would
    // flake under CI load): a tailer that read the file would surface its
    // thousands of entries; resume-at-EOF surfaces none.
    const row = line("user", "x".repeat(1024));
    writeFileSync(filePath, row.repeat(Math.ceil((10 * 1024 * 1024) / row.length)));

    const tailer = new TranscriptTailer(filePath);
    await tailer.skipToEnd();
    expect(await tailer.drainEntries()).toEqual([]);

    appendFileSync(filePath, line("assistant", "fresh"));
    const entries = await tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "assistant", message: { content: "fresh" } });
  });

  it("skipToEnd discards pending unread data", async () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    appendFileSync(filePath, line("user", "stale 1"));
    appendFileSync(filePath, line("user", "stale 2"));
    await tailer.skipToEnd();
    expect(await tailer.drainEntries()).toEqual([]);

    appendFileSync(filePath, line("assistant", "fresh"));
    const entries = await tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "assistant" });
  });

  it("skipToEnd clears a buffered partial line", async () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    appendFileSync(filePath, '{"type":"user","message":{"content":"doomed');
    expect(await tailer.drainEntries()).toEqual([]);

    await tailer.skipToEnd();
    appendFileSync(filePath, line("assistant", "fresh"));
    // A leftover partial would glue onto the new line and corrupt it into an
    // unparsable blob — the fresh entry must come through intact.
    const entries = await tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "assistant", message: { content: "fresh" } });
  });

  it("skipToEnd keeps its position when stat transiently fails", async () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    const history = line("user", "history");
    appendFileSync(filePath, history);
    expect(await tailer.drainEntries()).toHaveLength(1);

    rmSync(filePath);
    await tailer.skipToEnd();

    // The file reappears with the same content: a position reset to 0 would
    // re-surface (replay) the old entry; the kept position must not.
    writeFileSync(filePath, history);
    expect(await tailer.drainEntries()).toEqual([]);

    appendFileSync(filePath, line("assistant", "fresh"));
    const entries = await tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "assistant" });
  });

  it("returns bounded batches and preserves order", async () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath, { maxBatchBytes: 64 });

    const contents = ["one", "two", "three", "four", "five"];
    for (const content of contents) {
      appendFileSync(filePath, line("user", content));
    }

    const first = await tailer.drainEntries();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(contents.length);

    const rest = await drainAll(tailer);
    const all = [...first, ...rest];
    expect(all.map((entry) => entry.message?.content)).toEqual(contents);
  });

  it("reassembles a JSONL line split across chunk boundaries", async () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath, { chunkBytes: 8 });

    const entry = { type: "user", message: { content: "a long line that spans many eight-byte chunks" } };
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`);

    const entries = await tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject(entry);
  });

  it("decodes multi-byte UTF-8 split across chunk boundaries", async () => {
    writeFileSync(filePath, "");
    // A 3-byte chunk cannot align with the 4-byte emoji sequence, so the
    // decoder is guaranteed to see a split character.
    const tailer = new TranscriptTailer(filePath, { chunkBytes: 3 });

    const entry = { type: "assistant", message: { content: "中文🙂 done" } };
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`);

    const entries = await tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject(entry);
    expect(JSON.stringify(entries[0])).not.toContain("�");
  });

  it("decodes a multi-byte character split across separate drains", async () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    const bytes = Buffer.from(line("assistant", "🙂"), "utf-8");
    const emojiStart = bytes.indexOf(0xf0);
    expect(emojiStart).toBeGreaterThan(-1);

    // First half of the 4-byte emoji lands in one drain, the rest in the
    // next: the decoder state must persist across drainEntries() calls, not
    // just across chunks within one call.
    appendFileSync(filePath, bytes.subarray(0, emojiStart + 2));
    expect(await tailer.drainEntries()).toEqual([]);

    appendFileSync(filePath, bytes.subarray(emojiStart + 2));
    const entries = await tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "assistant", message: { content: "🙂" } });
    expect(JSON.stringify(entries[0])).not.toContain("�");
  });

  it("clamps to the new EOF after truncation", async () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    appendFileSync(filePath, line("user", "one"));
    appendFileSync(filePath, line("user", "two"));
    expect(await tailer.drainEntries()).toHaveLength(2);

    writeFileSync(filePath, "x\n");
    expect(await tailer.drainEntries()).toEqual([]);

    appendFileSync(filePath, line("assistant", "after"));
    const entries = await tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "assistant", message: { content: "after" } });
  });

  it("truncation clamp clears a buffered partial line", async () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    appendFileSync(filePath, line("user", "one"));
    appendFileSync(filePath, '{"type":"user","message":{"content":"half');
    expect(await tailer.drainEntries()).toHaveLength(1);

    writeFileSync(filePath, "x\n");
    expect(await tailer.drainEntries()).toEqual([]);

    appendFileSync(filePath, line("assistant", "after"));
    // A leftover partial would glue onto the post-truncation line and turn it
    // into an unparsable blob — the new entry must come through intact.
    const entries = await tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "assistant", message: { content: "after" } });
  });
});
