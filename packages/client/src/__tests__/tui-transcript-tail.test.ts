import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TranscriptTailer,
  transcriptEntryToEvents,
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

describe("transcriptEntryToEvents", () => {
  it("maps user string content to user_text", () => {
    const events = transcriptEntryToEvents({ type: "user", message: { content: "hi" }, timestamp: "t0" });
    expect(events).toEqual([{ kind: "user_text", text: "hi", ts: "t0" }]);
  });

  it("maps user array content with tool_result block", () => {
    const events = transcriptEntryToEvents({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "u1", is_error: false, content: "done" }],
      },
      timestamp: "t1",
    });
    expect(events).toEqual([{ kind: "tool_result", toolUseId: "u1", isError: false, content: "done", ts: "t1" }]);
  });

  it("maps assistant content with mixed block types", () => {
    const events = transcriptEntryToEvents({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reasoning..." },
          { type: "tool_use", id: "u2", name: "Bash", input: { command: "ls" } },
          { type: "thinking", thinking: "internal monologue" },
        ],
      },
      timestamp: "t2",
    });
    expect(events).toEqual([
      { kind: "assistant_text", text: "Reasoning...", ts: "t2" },
      { kind: "tool_use", toolUseId: "u2", name: "Bash", input: { command: "ls" }, ts: "t2" },
      { kind: "thinking", text: "internal monologue", ts: "t2" },
    ]);
  });

  it("ignores entries the runtime doesn't care about", () => {
    expect(transcriptEntryToEvents({ type: "permission-mode" })).toEqual([]);
    expect(transcriptEntryToEvents({ type: "file-history-snapshot" })).toEqual([]);
    expect(transcriptEntryToEvents({ type: "system" })).toEqual([]);
    expect(transcriptEntryToEvents({})).toEqual([]);
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

  it("drainEvents is the mapped convenience over drainEntries", () => {
    writeFileSync(filePath, "");
    const tailer = new TranscriptTailer(filePath);
    appendFileSync(filePath, `${JSON.stringify({ type: "user", message: { content: "x" } })}\n`);
    const events = tailer.drainEvents();
    expect(events).toEqual([{ kind: "user_text", text: "x", ts: undefined }]);
  });
});
