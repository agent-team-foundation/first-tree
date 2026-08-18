import { describe, expect, it } from "vitest";
import { AmpStreamParser, parseAmpStreamLine } from "../parser.js";

describe("Amp stream-json parser", () => {
  it("parses init, thinking, assistant text, tools, and a successful result", () => {
    const parser = new AmpStreamParser();
    const events = [
      ...parser.push(
        [
          JSON.stringify({ type: "system", subtype: "init", session_id: "T-11111111-1111-4111-8111-111111111111" }),
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "thinking", thinking: "plan the answer" }] },
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              content: [{ type: "tool_use", id: "call_read", name: "read", input: { path: "README.md" } }],
            },
          }),
          JSON.stringify({
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "call_read", content: "hello" }] },
          }),
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "done" }] },
          }),
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "done",
            session_id: "T-11111111-1111-4111-8111-111111111111",
            usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 },
          }),
          "",
        ].join("\n"),
      ),
      ...parser.flush(),
    ];

    expect(events).toEqual([
      { kind: "init", sessionId: "T-11111111-1111-4111-8111-111111111111" },
      { kind: "thinking_delta", text: "plan the answer" },
      { kind: "tool_started", callId: "call_read", tool: { name: "read", args: { path: "README.md" } } },
      { kind: "tool_completed", callId: "call_read", preview: "hello", failed: false },
      { kind: "assistant_message", text: "done" },
      {
        kind: "result",
        isError: false,
        text: "done",
        sessionId: "T-11111111-1111-4111-8111-111111111111",
        usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 0 },
      },
    ]);
  });

  it("never throws on unparsable or unknown lines", () => {
    expect(parseAmpStreamLine("not-json")).toMatchObject([{ kind: "unknown", note: "unparsable stream line" }]);
    expect(parseAmpStreamLine('{"type":"mystery"}')).toMatchObject([
      {
        kind: "unknown",
        note: "unknown stream type mystery",
      },
    ]);
    expect(parseAmpStreamLine("")).toEqual([]);
  });

  it("maps system execution errors and result is_error to a failed result", () => {
    expect(
      parseAmpStreamLine(
        JSON.stringify({
          type: "system",
          subtype: "error_during_execution",
          error: "not logged in",
          session_id: "T-1",
        }),
      ),
    ).toMatchObject([{ kind: "result", isError: true, text: "not logged in", sessionId: "T-1" }]);
    expect(
      parseAmpStreamLine(JSON.stringify({ type: "result", is_error: true, error: "amp login required" })),
    ).toMatchObject([{ kind: "result", isError: true, text: "amp login required" }]);
  });

  it("emits every assistant and user content block in order, including parallel tools", () => {
    expect(
      parseAmpStreamLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "plan the write" },
              { type: "text", text: "mutating then reading" },
              { type: "tool_use", id: "call_write", name: "write", input: { path: "secret.txt" } },
              { type: "tool_use", id: "call_read", name: "read", input: { path: "README.md" } },
            ],
          },
        }),
      ),
    ).toEqual([
      { kind: "thinking_delta", text: "plan the write" },
      { kind: "assistant_message", text: "mutating then reading" },
      { kind: "tool_started", callId: "call_write", tool: { name: "write", args: { path: "secret.txt" } } },
      { kind: "tool_started", callId: "call_read", tool: { name: "read", args: { path: "README.md" } } },
    ]);
    expect(
      parseAmpStreamLine(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "call_write", content: "wrote" },
              { type: "tool_result", tool_use_id: "call_read", content: "hello", is_error: false },
            ],
          },
        }),
      ),
    ).toEqual([
      { kind: "tool_completed", callId: "call_write", preview: "wrote", failed: false },
      { kind: "tool_completed", callId: "call_read", preview: "hello", failed: false },
    ]);
  });

  it("retains assistant message.usage when the terminal result omits usage", () => {
    const parser = new AmpStreamParser();
    const events = [
      ...parser.push(
        [
          JSON.stringify({ type: "system", subtype: "init", session_id: "T-usage-1" }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "8" }],
              usage: {
                input_tokens: 10,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 0,
                output_tokens: 4,
              },
            },
            session_id: "T-usage-1",
          }),
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "8",
            session_id: "T-usage-1",
          }),
          "",
        ].join("\n"),
      ),
      ...parser.flush(),
    ];
    expect(events).toEqual([
      { kind: "init", sessionId: "T-usage-1" },
      { kind: "assistant_message", text: "8" },
      {
        kind: "usage",
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 100 },
      },
      {
        kind: "result",
        isError: false,
        text: "8",
        sessionId: "T-usage-1",
        usage: null,
      },
    ]);
  });
});
