import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CursorStreamEvent, CursorStreamParser, parseCursorStreamLine } from "../handlers/cursor/parser.js";

/**
 * Parser fixtures are REAL Phase 0 captures from the Cursor CLI
 * (2026.07.09-a3815c0) — see the design doc's acceptance matrix. Shapes are
 * locked against actual provider output, not hand-written approximations.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cursor");

function parseFixture(name: string): CursorStreamEvent[] {
  const text = readFileSync(join(FIXTURES, name), "utf-8");
  const parser = new CursorStreamParser();
  return [...parser.push(text), ...parser.flush()];
}

describe("cursor stream-json parser — real Phase 0 fixtures", () => {
  it("successful turn: init + thinking + assistant + shell tool + result with usage", () => {
    const events = parseFixture("success-connectivity.stream.jsonl");

    const init = events.find((e) => e.kind === "init");
    expect(init).toMatchObject({ sessionId: "f5d358d1-94f9-411d-adc0-d75ddbe60117", model: "Composer 2.5" });

    expect(events.filter((e) => e.kind === "thinking_delta").length).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === "thinking_completed")).toBe(true);

    // `assistant` fragments are captured but are NOT the canonical final text.
    const assistant = events.filter((e) => e.kind === "assistant_message");
    expect(assistant.length).toBeGreaterThan(0);

    const started = events.find((e) => e.kind === "tool_started");
    const completed = events.find((e) => e.kind === "tool_completed");
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    if (started?.kind !== "tool_started" || completed?.kind !== "tool_completed") throw new Error("unreachable");
    expect(started.callId).toBe(completed.callId);
    expect(started.tool.name).toBe("shell");
    expect(completed.result.failed).toBe(false);

    const result = events.at(-1);
    expect(result).toMatchObject({
      kind: "result",
      isError: false,
      sessionId: "f5d358d1-94f9-411d-adc0-d75ddbe60117",
      usage: { inputTokens: 6528, outputTokens: 165, cacheReadTokens: 18107, cacheWriteTokens: 0 },
    });
    if (result?.kind !== "result") throw new Error("unreachable");
    expect(result.text).toContain("FT_CONNECTIVITY_OK");
  });

  it("multi-tool turn: edit/read/shell started+completed interleave, correlated by call_id", () => {
    const events = parseFixture("multitool-interleaved.stream.jsonl");
    const started = events.filter(
      (e): e is Extract<CursorStreamEvent, { kind: "tool_started" }> => e.kind === "tool_started",
    );
    const completed = events.filter(
      (e): e is Extract<CursorStreamEvent, { kind: "tool_completed" }> => e.kind === "tool_completed",
    );
    expect(new Set(started.map((e) => e.tool.name))).toEqual(new Set(["edit", "read", "shell"]));
    // Every started tool eventually completes under the same call_id.
    for (const s of started) {
      expect(completed.some((c) => c.callId === s.callId)).toBe(true);
    }
    // Native path rides the edit/read unions.
    const read = started.find((e) => e.tool.name === "read");
    if (read?.tool.name !== "read") throw new Error("unreachable");
    expect(read.tool.path).toMatch(/phase0-proof\.txt$/);
  });

  it("shell exit 7 marks the TOOL failed while the overall result stays success", () => {
    const events = parseFixture("shell-exit7-turn-success.stream.jsonl");
    const failedTool = events.find((e) => e.kind === "tool_completed" && e.result.failed);
    expect(failedTool).toBeDefined();
    if (failedTool?.kind !== "tool_completed") throw new Error("unreachable");
    expect(failedTool.result.exitCode).toBe(7);
    expect(failedTool.result.preview).toContain("FT_EXPECTED_STDERR");

    const result = events.at(-1);
    expect(result).toMatchObject({ kind: "result", isError: false });
    if (result?.kind !== "result") throw new Error("unreachable");
    expect(result.text).toBe("FT_TOOL_FAILURE_OBSERVED");
  });

  it("quota failure: partial system/user JSON then stream ends with NO result event", () => {
    const events = parseFixture("quota-failure.stream.jsonl");
    expect(events.some((e) => e.kind === "init")).toBe(true);
    expect(events.some((e) => e.kind === "result")).toBe(false);
  });

  it("resume turns carry the same stream-confirmed session id", () => {
    const turn1 = parseFixture("resume-turn1.stream.jsonl");
    const turn2 = parseFixture("resume-turn2.stream.jsonl");
    const init1 = turn1.find((e) => e.kind === "init");
    const init2 = turn2.find((e) => e.kind === "init");
    if (init1?.kind !== "init" || init2?.kind !== "init") throw new Error("unreachable");
    expect(init1.sessionId).toBeTruthy();
    expect(init2.sessionId).toBe(init1.sessionId);
  });
});

describe("cursor stream-json parser — tolerance contract", () => {
  it("unknown event types degrade to diagnostics, never throw", () => {
    const event = parseCursorStreamLine(JSON.stringify({ type: "future_event", payload: { x: 1 } }));
    expect(event).toMatchObject({ kind: "unknown" });
  });

  it("unknown tool unions surface as name=unknown with the union key preserved", () => {
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "tool_x",
      tool_call: { futureToolCall: { args: { anything: true } } },
      session_id: "s",
    });
    const event = parseCursorStreamLine(line);
    expect(event).toMatchObject({
      kind: "tool_started",
      callId: "tool_x",
      tool: { name: "unknown", unionKey: "futureToolCall" },
    });
  });

  it("unparsable and non-object lines degrade to diagnostics", () => {
    expect(parseCursorStreamLine("not json at all")).toMatchObject({ kind: "unknown" });
    expect(parseCursorStreamLine('"just a string"')).toMatchObject({ kind: "unknown" });
    expect(parseCursorStreamLine("   ")).toBeNull();
  });

  it("result with empty text still parses as a result (silent/tool-only turn)", () => {
    const event = parseCursorStreamLine(
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", session_id: "s", usage: null }),
    );
    expect(event).toMatchObject({ kind: "result", isError: false, text: "", usage: null });
  });

  it("incremental chunking reassembles split lines and flush() drains an unterminated tail", () => {
    const parser = new CursorStreamParser();
    const line = `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, session_id: "s" })}\n`;
    const mid = Math.floor(line.length / 2);
    expect(parser.push(line.slice(0, mid))).toEqual([]);
    const events = parser.push(line.slice(mid));
    expect(events).toMatchObject([{ kind: "assistant_message", text: "hi" }]);

    parser.push(JSON.stringify({ type: "thinking", subtype: "completed", session_id: "s" }));
    expect(parser.flush()).toMatchObject([{ kind: "thinking_completed" }]);
  });
});
