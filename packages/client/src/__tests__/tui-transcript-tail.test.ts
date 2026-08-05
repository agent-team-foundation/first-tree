import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptTailer, transcriptPathFor } from "../handlers/claude-code-tui/transcript-tail.js";

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

  it("returns empty when the file does not exist yet", () => {
    const tailer = new TranscriptTailer(filePath);
    expect(tailer.drainEntries()).toEqual([]);
  });

  it("returns only new entries on each drain", () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    appendFileSync(filePath, `${JSON.stringify({ type: "user", message: { content: "first" } })}\n`);
    const first = tailer.drainEntries();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: "user" });

    appendFileSync(filePath, `${JSON.stringify({ type: "assistant", message: { content: [] } })}\n`);
    const second = tailer.drainEntries();
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ type: "assistant" });

    expect(tailer.drainEntries()).toEqual([]);
  });

  it("buffers partial lines across reads", () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    const piece1 = '{"type":"user","message":{"content":"half';
    const piece2 = ' message"}}\n';
    appendFileSync(filePath, piece1);
    expect(tailer.drainEntries()).toEqual([]);

    appendFileSync(filePath, piece2);
    const entries = tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "user", message: { content: "half message" } });
  });

  it("tolerates malformed lines without failing the drain", () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    appendFileSync(filePath, "this is not json\n");
    appendFileSync(filePath, `${JSON.stringify({ type: "user", message: { content: "ok" } })}\n`);

    const entries = tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "user" });
  });

  it("startAtEnd skips pre-existing history and returns only new entries (resume)", () => {
    const history = Array.from({ length: 500 }, (_, i) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `old ${i}` }] } }),
    ).join("\n");
    writeFileSync(filePath, `${history}\n`);

    const tailer = new TranscriptTailer(filePath, { startAtEnd: true });
    expect(tailer.drainEntries()).toEqual([]);

    appendFileSync(filePath, `${JSON.stringify({ type: "user", message: { content: "fresh" } })}\n`);
    const entries = tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "user", message: { content: "fresh" } });
  });

  it("startAtEnd on a missing file behaves like a fresh tail from offset zero", () => {
    const tailer = new TranscriptTailer(filePath, { startAtEnd: true });
    expect(tailer.drainEntries()).toEqual([]);

    writeFileSync(filePath, `${JSON.stringify({ type: "user", message: { content: "first" } })}\n`);
    const entries = tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "user", message: { content: "first" } });
  });

  it("parses entries larger than a single read chunk", () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    // READ_CHUNK_BYTES is 64 KiB — make one line span several chunks.
    const big = "x".repeat(256 * 1024);
    appendFileSync(filePath, `${JSON.stringify({ type: "assistant", message: { content: big } })}\n`);
    appendFileSync(filePath, `${JSON.stringify({ type: "user", message: { content: "after" } })}\n`);

    const entries = tailer.drainEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: "assistant", message: { content: big } });
    expect(entries[1]).toMatchObject({ type: "user", message: { content: "after" } });
  });

  it("reassembles a multi-byte UTF-8 character split across two drains", () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    const line = Buffer.from(`${JSON.stringify({ type: "user", message: { content: "汉字🎉" } })}\n`, "utf-8");
    // Split inside the multi-byte sequence of "汉" (well before the newline).
    const splitAt = line.indexOf(Buffer.from("汉", "utf-8")) + 1;
    appendFileSync(filePath, line.subarray(0, splitAt));
    expect(tailer.drainEntries()).toEqual([]);

    appendFileSync(filePath, line.subarray(splitAt));
    const entries = tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "user", message: { content: "汉字🎉" } });
  });
});
