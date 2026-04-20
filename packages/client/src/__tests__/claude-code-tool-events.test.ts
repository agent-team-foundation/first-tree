import type { SessionEvent } from "@agent-team-foundation/first-tree-hub-shared";
import { describe, expect, it, vi } from "vitest";
import { createToolCallProcessor } from "../handlers/claude-code.js";

/**
 * S11 (NC2 client handler) — tool-call processor fixtures.
 *
 * Covers the 4 shapes the Claude Agent SDK can emit inside an
 * `assistant` / `user` message stream:
 *   1. tool_use → tool_result (is_error=false) ⇒ `status:"ok"`
 *   2. tool_use → tool_result (is_error=true)  ⇒ `status:"error"`
 *   3. tool_use with no matching tool_result, then abort ⇒ flush as `status:"pending"`
 *   4. tool_result with an array-shaped `content` (mixed blocks) ⇒ text blocks
 *      are concatenated into `resultPreview`.
 *
 * The processor is extracted from the for-await consumer loop in
 * `claude-code.ts`, so these fixtures lock its behavior down without
 * needing to boot the whole handler + SDK + workspace.
 */

function assistantToolUse(id: string, name: string, input: unknown) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  };
}

function userToolResult(toolUseId: string, content: unknown, isError?: boolean) {
  const block: Record<string, unknown> = { type: "tool_result", tool_use_id: toolUseId, content };
  if (isError !== undefined) block.is_error = isError;
  return {
    type: "user",
    message: {
      role: "user",
      content: [block],
    },
  };
}

describe("createToolCallProcessor", () => {
  it("pairs tool_use with a successful tool_result and emits status:ok", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage(assistantToolUse("tu-1", "Bash", { command: "ls" }));
    processor.onMessage(userToolResult("tu-1", "a b c"));

    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0]?.[0];
    if (!call || call.kind !== "tool_call") throw new Error("expected tool_call event");
    expect(call.payload.toolUseId).toBe("tu-1");
    expect(call.payload.name).toBe("Bash");
    expect(call.payload.args).toEqual({ command: "ls" });
    expect(call.payload.status).toBe("ok");
    expect(call.payload.resultPreview).toBe("a b c");
    expect(call.payload.durationMs).toBeGreaterThanOrEqual(0);

    // No pending left to flush
    processor.flush();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("marks tool_result with is_error=true as status:error", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage(assistantToolUse("tu-2", "Read", { file_path: "/tmp/x" }));
    processor.onMessage(userToolResult("tu-2", "permission denied", true));

    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0]?.[0];
    if (!call || call.kind !== "tool_call") throw new Error("expected tool_call event");
    expect(call.payload.status).toBe("error");
    expect(call.payload.resultPreview).toBe("permission denied");
  });

  it("flushes unpaired tool_use entries as status:pending", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage(assistantToolUse("tu-3", "Bash", { command: "sleep 99" }));
    // No tool_result — simulate session abort by invoking flush() directly.
    processor.flush();

    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0]?.[0];
    if (!call || call.kind !== "tool_call") throw new Error("expected tool_call event");
    expect(call.payload.toolUseId).toBe("tu-3");
    expect(call.payload.status).toBe("pending");
    expect(call.payload.resultPreview).toBeUndefined();
    expect(call.payload.durationMs).toBeGreaterThanOrEqual(0);

    // Second flush is idempotent
    processor.flush();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("extracts text from array-shaped tool_result content for resultPreview", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage(assistantToolUse("tu-4", "Grep", { pattern: "foo" }));
    processor.onMessage(
      userToolResult("tu-4", [
        { type: "text", text: "line1" },
        { type: "image", source: { type: "base64", data: "...", media_type: "image/png" } },
        { type: "text", text: "line2" },
      ]),
    );

    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0]?.[0];
    if (!call || call.kind !== "tool_call") throw new Error("expected tool_call event");
    expect(call.payload.resultPreview).toBe("line1\nline2");
    expect(call.payload.status).toBe("ok");
  });

  it("ignores tool_result without matching tool_use (no spurious emit)", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    // No preceding tool_use — processor should drop this silently.
    processor.onMessage(userToolResult("tu-orphan", "ghost"));
    processor.flush();

    expect(emit).not.toHaveBeenCalled();
  });

  it("truncates resultPreview to 400 chars", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    const longText = "x".repeat(1000);
    processor.onMessage(assistantToolUse("tu-5", "Bash", {}));
    processor.onMessage(userToolResult("tu-5", longText));

    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0]?.[0];
    if (!call || call.kind !== "tool_call") throw new Error("expected tool_call event");
    expect(call.payload.resultPreview?.length).toBe(400);
  });

  it("handles multiple tool_use blocks in a single assistant message", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "running both" },
          { type: "tool_use", id: "a1", name: "Bash", input: { cmd: "x" } },
          { type: "tool_use", id: "a2", name: "Read", input: { path: "y" } },
        ],
      },
    });
    processor.onMessage(userToolResult("a1", "ok1"));
    processor.onMessage(userToolResult("a2", "ok2"));

    expect(emit).toHaveBeenCalledTimes(2);
    const ids = emit.mock.calls.map((c) => {
      const ev = c[0];
      if (ev.kind !== "tool_call") throw new Error("expected tool_call");
      return ev.payload.toolUseId;
    });
    expect(ids).toEqual(["a1", "a2"]);
  });

  it("ignores non-relevant SDK message types", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage({ type: "system", subtype: "init" });
    processor.onMessage({ type: "result", subtype: "success", result: "done" });
    processor.onMessage(null);
    processor.onMessage("garbage");
    processor.flush();

    expect(emit).not.toHaveBeenCalled();
  });
});
