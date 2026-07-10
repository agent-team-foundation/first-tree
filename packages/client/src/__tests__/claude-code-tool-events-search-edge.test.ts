import type { SessionEvent } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import { createToolCallProcessor } from "../handlers/claude-code.js";

function assistantToolUse(id: string, name: string, input: unknown) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  };
}

function userToolResult(toolUseId: string, content: unknown) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  };
}

function finalToolCall(events: readonly SessionEvent[]): Extract<SessionEvent, { kind: "tool_call" }> {
  const event = events.find((candidate) => candidate.kind === "tool_call" && candidate.payload.status === "ok");
  if (!event || event.kind !== "tool_call") throw new Error("expected final tool_call event");
  return event;
}

describe("createToolCallProcessor — search path edge refs", () => {
  it("emits a directory search ref for an absolute missing path without a Context Tree binding", () => {
    const events: SessionEvent[] = [];
    const emit = vi.fn<(event: SessionEvent) => void>((event) => events.push(event));
    const processor = createToolCallProcessor(emit);

    processor.onMessage(assistantToolUse("grep-missing", "Grep", { path: "/tmp/first-tree-missing-search-root" }));
    processor.onMessage(userToolResult("grep-missing", "no matches"));

    const event = finalToolCall(events);
    expect(event.payload.toolFileRefs).toEqual([
      {
        origin: "tool_arg",
        localPath: "/tmp/first-tree-missing-search-root",
        pathKind: "directory",
      },
    ]);
  });
});
