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

  it("seekToEnd skips existing content without parsing it", () => {
    // Simulate a resumed transcript: a full history, including a malformed
    // line that would fail JSON.parse if it were read.
    writeFileSync(filePath, `${JSON.stringify({ type: "user", message: { content: "old" } })}\nnot json\n`);
    const tailer = new TranscriptTailer(filePath);

    tailer.seekToEnd();
    expect(tailer.drainEntries()).toEqual([]);

    appendFileSync(filePath, `${JSON.stringify({ type: "assistant", message: { content: [] } })}\n`);
    const entries = tailer.drainEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "assistant" });
  });

  it("seekToEnd discards a buffered partial line", () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);

    appendFileSync(filePath, '{"type":"user","message":{"content":"half');
    expect(tailer.drainEntries()).toEqual([]);

    tailer.seekToEnd();

    // The leftover partial is gone: completing it must not surface the old
    // fragment, only genuinely new entries are returned.
    appendFileSync(filePath, ' message"}}\n');
    expect(tailer.drainEntries()).toEqual([]);
    appendFileSync(filePath, `${JSON.stringify({ type: "assistant", message: { content: [] } })}\n`);
    expect(tailer.drainEntries()).toHaveLength(1);
  });

  it("seekToEnd tolerates a missing file and still tails once it appears", () => {
    const tailer = new TranscriptTailer(filePath);

    expect(() => tailer.seekToEnd()).not.toThrow();

    writeFileSync(filePath, `${JSON.stringify({ type: "user", message: { content: "first" } })}\n`);
    expect(tailer.drainEntries()).toHaveLength(1);
  });
});
