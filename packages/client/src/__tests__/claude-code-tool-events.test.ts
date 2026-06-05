import type { SessionEvent } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import { createToolCallProcessor, treeNodePathOf } from "../handlers/claude-code.js";

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
  it("pairs tool_use with a successful tool_result and emits pending + ok", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage(assistantToolUse("tu-1", "Bash", { command: "ls" }));
    processor.onMessage(userToolResult("tu-1", "a b c"));

    // Two emits per tool call: pending row on tool_use (so the UI shows
    // "using Bash…" live), final ok/error row on tool_result. Frontend
    // dedupes by toolUseId.
    expect(emit).toHaveBeenCalledTimes(2);
    const pending = emit.mock.calls[0]?.[0];
    const final = emit.mock.calls[1]?.[0];
    if (!pending || pending.kind !== "tool_call") throw new Error("expected pending tool_call");
    if (!final || final.kind !== "tool_call") throw new Error("expected final tool_call");
    expect(pending.payload.toolUseId).toBe("tu-1");
    expect(pending.payload.name).toBe("Bash");
    expect(pending.payload.args).toEqual({ command: "ls" });
    expect(pending.payload.status).toBe("pending");
    expect(pending.payload.durationMs).toBeUndefined();
    expect(pending.payload.resultPreview).toBeUndefined();

    expect(final.payload.toolUseId).toBe("tu-1");
    expect(final.payload.status).toBe("ok");
    expect(final.payload.resultPreview).toBe("a b c");
    expect(final.payload.durationMs).toBeGreaterThanOrEqual(0);

    // No pending left to flush
    processor.flush();
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("marks tool_result with is_error=true as status:error (final emit)", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage(assistantToolUse("tu-2", "Read", { file_path: "/tmp/x" }));
    processor.onMessage(userToolResult("tu-2", "permission denied", true));

    expect(emit).toHaveBeenCalledTimes(2);
    const final = emit.mock.calls[1]?.[0];
    if (!final || final.kind !== "tool_call") throw new Error("expected tool_call event");
    expect(final.payload.status).toBe("error");
    expect(final.payload.resultPreview).toBe("permission denied");
  });

  it("unpaired tool_use leaves only the up-front pending emit", () => {
    // The `pending` row emitted when tool_use arrives already signals the
    // in-progress state — flush no longer emits a second pending, it just
    // clears the in-memory pairing map. The active-turn events (including
    // this orphaned pending row) are hidden once the next turn_end lands.
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

    // Second flush is a no-op
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

    // First is pending, second is final ok with the extracted preview.
    expect(emit).toHaveBeenCalledTimes(2);
    const final = emit.mock.calls[1]?.[0];
    if (!final || final.kind !== "tool_call") throw new Error("expected tool_call event");
    expect(final.payload.resultPreview).toBe("line1\nline2");
    expect(final.payload.status).toBe("ok");
  });

  it("ignores tool_result without matching tool_use (no spurious emit)", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    // No preceding tool_use — processor should drop this silently.
    processor.onMessage(userToolResult("tu-orphan", "ghost"));
    processor.flush();

    expect(emit).not.toHaveBeenCalled();
  });

  it("truncates resultPreview to 400 chars on the final emit", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    const longText = "x".repeat(1000);
    processor.onMessage(assistantToolUse("tu-5", "Bash", {}));
    processor.onMessage(userToolResult("tu-5", longText));

    expect(emit).toHaveBeenCalledTimes(2);
    const final = emit.mock.calls[1]?.[0];
    if (!final || final.kind !== "tool_call") throw new Error("expected tool_call event");
    expect(final.payload.resultPreview?.length).toBe(400);
  });

  it("emits the pending tool_call BEFORE the first tool_result is observed", () => {
    // Regression guard: the whole point of the pending emit is that the UI
    // sees "using Bash…" while the tool is still executing. If the handler
    // only emitted after the result arrived, a 5-second Bash run would show
    // nothing live.
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage(assistantToolUse("tu-live", "Bash", { command: "sleep 5" }));

    // Just from tool_use: exactly one emit, status pending.
    expect(emit).toHaveBeenCalledTimes(1);
    const ev = emit.mock.calls[0]?.[0];
    if (!ev || ev.kind !== "tool_call") throw new Error("expected pending tool_call");
    expect(ev.payload.status).toBe("pending");
    expect(ev.payload.toolUseId).toBe("tu-live");

    // Later, the result arrives — a second emit supersedes the pending one.
    processor.onMessage(userToolResult("tu-live", "done"));
    expect(emit).toHaveBeenCalledTimes(2);
    const finalEv = emit.mock.calls[1]?.[0];
    if (!finalEv || finalEv.kind !== "tool_call") throw new Error("expected final tool_call");
    expect(finalEv.payload.status).toBe("ok");
    expect(finalEv.payload.toolUseId).toBe("tu-live");
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

    // 1 assistant_text ("running both") + 2 pending tool_use + 2 final
    // tool_result = 5 events total.
    expect(emit).toHaveBeenCalledTimes(5);

    const toolEvents = emit.mock.calls.map((c) => c[0]).filter((ev) => ev.kind === "tool_call");
    expect(toolEvents).toHaveLength(4);
    // Order: a1 pending, a2 pending (both from the assistant message), then
    // a1 ok, a2 ok (from the user messages).
    const seq = toolEvents.map((ev) => (ev.kind === "tool_call" ? `${ev.payload.toolUseId}:${ev.payload.status}` : ""));
    expect(seq).toEqual(["a1:pending", "a2:pending", "a1:ok", "a2:ok"]);

    const textEv = emit.mock.calls.map((c) => c[0]).find((ev) => ev.kind === "assistant_text");
    if (!textEv || textEv.kind !== "assistant_text") throw new Error("expected assistant_text event");
    expect(textEv.payload.text).toBe("running both");
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

  it("emits assistant_text for non-empty text blocks", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "  I'll check the file  " },
          { type: "text", text: "" },
          { type: "text", text: "   " },
        ],
      },
    });

    // Only the non-empty trimmed text is emitted
    expect(emit).toHaveBeenCalledTimes(1);
    const ev = emit.mock.calls[0]?.[0];
    if (!ev || ev.kind !== "assistant_text") throw new Error("expected assistant_text");
    expect(ev.payload.text).toBe("I'll check the file");
  });

  it("truncates assistant_text to 8000 chars", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "a".repeat(10_000) }] },
    });

    const ev = emit.mock.calls[0]?.[0];
    if (!ev || ev.kind !== "assistant_text") throw new Error("expected assistant_text");
    expect(ev.payload.text.length).toBe(8000);
  });

  it("emits a thinking marker carrying head-truncated reasoning text", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning the analysis layer wants to see" }],
      },
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const ev = emit.mock.calls[0]?.[0];
    if (!ev || ev.kind !== "thinking") throw new Error("expected thinking event");
    expect(ev.payload.text).toBe("reasoning the analysis layer wants to see");
  });

  it("head-truncates over-long thinking text to 8000 chars", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "a".repeat(9000) }],
      },
    });

    const ev = emit.mock.calls[0]?.[0];
    if (!ev || ev.kind !== "thinking") throw new Error("expected thinking event");
    expect(ev.payload.text).toHaveLength(8000);
  });

  it("does not throw on a thinking block whose `thinking` is not a string", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    expect(() =>
      processor.onMessage({
        type: "assistant",
        message: {
          role: "assistant",
          // Contract-violating shape: type is "thinking" but the field is not a
          // string. Must degrade to "" rather than crashing the message loop.
          content: [{ type: "thinking", thinking: { unexpected: "object" } }],
        },
      }),
    ).not.toThrow();

    const ev = emit.mock.calls[0]?.[0];
    if (!ev || ev.kind !== "thinking") throw new Error("expected thinking event");
    expect(ev.payload.text).toBe("");
  });
});

/**
 * The processor reports generic local file facts on successful single-file
 * Claude tools. The server decides whether those facts are Context Tree IO.
 */
describe("createToolCallProcessor — Context Tree file refs", () => {
  const TREE = "/home/op/.first-tree/tree";
  const binding = { path: TREE, repoUrl: "https://github.com/example/tree" } as const;

  function toolCallEvents(emit: ReturnType<typeof vi.fn<(event: SessionEvent) => void>>) {
    return emit.mock.calls.map((c) => c[0]).filter((ev) => ev.kind === "tool_call");
  }

  function usageEventCount(emit: ReturnType<typeof vi.fn<(event: SessionEvent) => void>>): number {
    return emit.mock.calls.map((c) => c[0]).filter((ev) => ev.kind === "context_tree_usage").length;
  }

  it("attaches file refs when a tree Read succeeds", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, binding);

    processor.onMessage(assistantToolUse("r1", "Read", { file_path: `${TREE}/members/Gandy2025/NODE.md` }));
    processor.onMessage(userToolResult("r1", "file contents"));

    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r1" && event.payload.status === "ok",
    );
    expect(final?.payload.toolFileRefs).toEqual([
      {
        origin: "tool_arg",
        localPath: `${TREE}/members/Gandy2025/NODE.md`,
        repoUrl: "https://github.com/example/tree",
        repoRelativePath: "members/Gandy2025/NODE.md",
        pathKind: "file",
      },
    ]);
    expect(usageEventCount(emit)).toBe(0);
  });

  it("attaches file refs for NotebookRead under the tree as well", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, binding);

    processor.onMessage(assistantToolUse("r2", "NotebookRead", { file_path: `${TREE}/designs/spike.md` }));
    processor.onMessage(userToolResult("r2", "cells"));

    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r2" && event.payload.status === "ok",
    );
    expect(final?.payload.toolFileRefs?.[0]).toMatchObject({
      origin: "tool_arg",
      repoRelativePath: "designs/spike.md",
    });
    expect(usageEventCount(emit)).toBe(0);
  });

  it("does NOT attach file refs when a tree Read FAILS (is_error)", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, binding);

    processor.onMessage(assistantToolUse("r3", "Read", { file_path: `${TREE}/missing/NODE.md` }));
    processor.onMessage(userToolResult("r3", "ENOENT: no such file", true));

    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r3" && event.payload.status === "error",
    );
    expect(final?.payload.toolFileRefs).toBeUndefined();
    expect(usageEventCount(emit)).toBe(0);
  });

  it("does NOT attach file refs for an aborted tree Read that never returns a result", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, binding);

    processor.onMessage(assistantToolUse("r4", "Read", { file_path: `${TREE}/NODE.md` }));
    // Turn aborted before the tool_result arrives.
    processor.flush();

    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r4" && event.payload.status === "pending",
    );
    expect(final?.payload.toolFileRefs).toBeUndefined();
    expect(usageEventCount(emit)).toBe(0);
  });

  it("attaches local-only file refs when Read targets a file outside the tree", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, binding);

    processor.onMessage(assistantToolUse("r5", "Read", { file_path: "/home/op/project/src/index.ts" }));
    processor.onMessage(userToolResult("r5", "code"));

    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r5" && event.payload.status === "ok",
    );
    expect(final?.payload.toolFileRefs).toEqual([
      {
        origin: "tool_arg",
        localPath: "/home/op/project/src/index.ts",
        pathKind: "file",
      },
    ]);
    expect(usageEventCount(emit)).toBe(0);
  });

  it("does not attach repo evidence for a sibling dir that shares the tree-root prefix", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, binding);

    // `/home/op/.first-tree/tree-other/...` must not count as inside the tree.
    processor.onMessage(assistantToolUse("r6", "Read", { file_path: "/home/op/.first-tree/tree-other/NODE.md" }));
    processor.onMessage(userToolResult("r6", "x"));

    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r6" && event.payload.status === "ok",
    );
    expect(final?.payload.toolFileRefs).toEqual([
      {
        origin: "tool_arg",
        localPath: "/home/op/.first-tree/tree-other/NODE.md",
        pathKind: "file",
      },
    ]);
    expect(usageEventCount(emit)).toBe(0);
  });

  it("attaches file refs when Bash reads a Context Tree file", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, { ...binding, branch: "main" }, { cwd: "/home/op/project" });

    processor.onMessage(assistantToolUse("r7", "Bash", { command: `cat ${TREE}/NODE.md` }));
    processor.onMessage(userToolResult("r7", "contents"));

    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r7" && event.payload.status === "ok",
    );
    expect(final?.payload.toolFileRefs).toEqual([
      {
        origin: "tool_arg",
        localPath: `${TREE}/NODE.md`,
        repoUrl: "https://github.com/example/tree",
        repoBranch: "main",
        repoRelativePath: "NODE.md",
        pathKind: "file",
      },
    ]);
    expect(usageEventCount(emit)).toBe(0);
  });

  it("does NOT attach Bash file refs when the shell command fails", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, binding, { cwd: "/home/op/project" });

    processor.onMessage(assistantToolUse("r7-fail", "Bash", { command: `cat ${TREE}/NODE.md` }));
    processor.onMessage(userToolResult("r7-fail", "ENOENT", true));

    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r7-fail" && event.payload.status === "error",
    );
    expect(final?.payload.toolFileRefs).toBeUndefined();
    expect(usageEventCount(emit)).toBe(0);
  });

  it("does NOT attach file refs for unsupported tools even if an arg path is under the tree", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, binding);

    processor.onMessage(assistantToolUse("r7-unsupported", "TodoWrite", { file_path: `${TREE}/NODE.md` }));
    processor.onMessage(userToolResult("r7-unsupported", "contents"));

    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r7-unsupported" && event.payload.status === "ok",
    );
    expect(final?.payload.toolFileRefs).toBeUndefined();
    expect(usageEventCount(emit)).toBe(0);
  });

  it("attaches local-only file refs when no Context Tree binding is configured", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit); // no binding

    processor.onMessage(assistantToolUse("r8", "Read", { file_path: `${TREE}/NODE.md` }));
    processor.onMessage(userToolResult("r8", "x"));

    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r8" && event.payload.status === "ok",
    );
    expect(final?.payload.toolFileRefs).toEqual([
      {
        origin: "tool_arg",
        localPath: `${TREE}/NODE.md`,
        pathKind: "file",
      },
    ]);
    expect(usageEventCount(emit)).toBe(0);
  });

  it("attaches local-only file refs when the binding path is null", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, { path: null, repoUrl: null });

    processor.onMessage(assistantToolUse("r9", "Read", { file_path: `${TREE}/NODE.md` }));
    processor.onMessage(userToolResult("r9", "x"));

    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r9" && event.payload.status === "ok",
    );
    expect(final?.payload.toolFileRefs).toEqual([
      {
        origin: "tool_arg",
        localPath: `${TREE}/NODE.md`,
        pathKind: "file",
      },
    ]);
    expect(usageEventCount(emit)).toBe(0);
  });

  it("attaches local-only file refs when the binding has no repo url", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, { path: TREE, repoUrl: null });

    processor.onMessage(assistantToolUse("r10", "Read", { file_path: `${TREE}/NODE.md` }));
    processor.onMessage(userToolResult("r10", "x"));

    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r10" && event.payload.status === "ok",
    );
    expect(final?.payload.toolFileRefs).toEqual([
      {
        origin: "tool_arg",
        localPath: `${TREE}/NODE.md`,
        pathKind: "file",
      },
    ]);
    expect(usageEventCount(emit)).toBe(0);
  });

  it("does NOT attach file refs when Read input has no string file_path", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, binding);

    processor.onMessage(assistantToolUse("r11", "Read", { offset: 0 }));
    processor.onMessage(userToolResult("r11", "x"));

    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r11" && event.payload.status === "ok",
    );
    expect(final?.payload.toolFileRefs).toBeUndefined();
    expect(usageEventCount(emit)).toBe(0);
  });

  it("attaches file refs when a tree Write succeeds", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, { ...binding, branch: "main" });

    processor.onMessage(assistantToolUse("w1", "Write", { file_path: `${TREE}/members/Gandy2025/NODE.md` }));
    processor.onMessage(userToolResult("w1", "updated"));

    const toolCalls = toolCallEvents(emit);
    const final = toolCalls.find((event) => event.payload.toolUseId === "w1" && event.payload.status === "ok");
    expect(final?.payload.toolFileRefs).toEqual([
      {
        origin: "tool_arg",
        localPath: `${TREE}/members/Gandy2025/NODE.md`,
        repoUrl: "https://github.com/example/tree",
        repoBranch: "main",
        repoRelativePath: "members/Gandy2025/NODE.md",
        pathKind: "file",
      },
    ]);
    expect(usageEventCount(emit)).toBe(0);
  });
});

describe("treeNodePathOf", () => {
  const TREE = "/home/op/.first-tree/tree";

  it("relativizes a file under the tree root", () => {
    expect(treeNodePathOf(`${TREE}/members/x/NODE.md`, TREE)).toBe("members/x/NODE.md");
  });

  it("tolerates a trailing slash on the tree root", () => {
    expect(treeNodePathOf(`${TREE}/NODE.md`, `${TREE}/`)).toBe("NODE.md");
  });

  it("returns null for a path outside the tree", () => {
    expect(treeNodePathOf("/home/op/project/x.ts", TREE)).toBeNull();
  });

  it("returns null for a sibling dir sharing the prefix", () => {
    expect(treeNodePathOf("/home/op/.first-tree/tree-other/NODE.md", TREE)).toBeNull();
  });

  it("returns null for the tree root itself (no node path)", () => {
    expect(treeNodePathOf(TREE, TREE)).toBeNull();
  });

  it("returns null on empty inputs", () => {
    expect(treeNodePathOf("", TREE)).toBeNull();
    expect(treeNodePathOf(`${TREE}/NODE.md`, "")).toBeNull();
  });
});
