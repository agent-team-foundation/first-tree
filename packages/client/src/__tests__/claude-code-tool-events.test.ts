import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolCallProcessor, treeNodePathOf } from "../handlers/claude-code.js";
import type { ContextTreeGitWriteTracker } from "../runtime/context-tree-git-status.js";
import { clearGitRepoIdentityCacheForTests } from "../runtime/git-repo-identity.js";

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

  it("chunks long assistant_text across multiple events with no loss (final-text mirror retired)", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    const full = "a".repeat(10_000);
    processor.onMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: full }] },
    });

    // 10_000 chars → two assistant_text events (8000 + 2000), each within the
    // per-event cap, and concatenating them reproduces the full text exactly —
    // session events stay the complete troubleshooting record.
    const texts = emit.mock.calls
      .map(([ev]) => ev)
      .filter((ev): ev is Extract<SessionEvent, { kind: "assistant_text" }> => ev?.kind === "assistant_text")
      .map((ev) => ev.payload.text);
    const boundaries = emit.mock.calls
      .map(([ev]) => ev)
      .filter((ev): ev is Extract<SessionEvent, { kind: "assistant_text" }> => ev?.kind === "assistant_text")
      .map((ev) => ev.payload.continuation);
    expect(texts).toHaveLength(2);
    expect(boundaries).toEqual([false, true]);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(8000);
    expect(texts.join("")).toBe(full);
  });

  it("emits a thinking marker (no content) for thinking blocks", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "private reasoning the UI must not see" }],
      },
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const ev = emit.mock.calls[0]?.[0];
    if (!ev || ev.kind !== "thinking") throw new Error("expected thinking event");
    // Payload is intentionally empty — thinking content is never persisted.
    expect(ev.payload).toEqual({});
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

  it("adds git status delta refs to successful tool calls", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const gitWriteTracker: ContextTreeGitWriteTracker = {
      captureBaseline: vi.fn(),
      refsForSuccessfulToolCall: vi.fn(() => [
        {
          origin: "git_status_delta" as const,
          localPath: `${TREE}/NODE.md`,
          repoUrl: "https://github.com/example/tree",
          repoRelativePath: "NODE.md",
          pathKind: "file" as const,
          metadata: {
            gitStatus: " M",
            toolName: "Bash",
            toolUseId: "r7-write",
          },
        },
      ]),
    };
    const processor = createToolCallProcessor(emit, binding, { cwd: "/home/op/project", gitWriteTracker });

    processor.onMessage(assistantToolUse("r7-write", "Bash", { command: `cat <<'EOF' > ${TREE}/NODE.md\nx\nEOF` }));
    processor.onMessage(userToolResult("r7-write", "wrote"));

    expect(gitWriteTracker.captureBaseline).toHaveBeenCalledTimes(1);
    expect(gitWriteTracker.refsForSuccessfulToolCall).toHaveBeenCalledWith({
      toolName: "Bash",
      toolUseId: "r7-write",
      existingRefs: [],
    });
    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r7-write" && event.payload.status === "ok",
    );
    expect(final?.payload.toolFileRefs).toEqual([
      {
        origin: "git_status_delta",
        localPath: `${TREE}/NODE.md`,
        repoUrl: "https://github.com/example/tree",
        repoRelativePath: "NODE.md",
        pathKind: "file",
        metadata: {
          gitStatus: " M",
          toolName: "Bash",
          toolUseId: "r7-write",
        },
      },
    ]);
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

  it("advances git status baseline without refs when a tool call fails", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const gitWriteTracker: ContextTreeGitWriteTracker = {
      captureBaseline: vi.fn(),
      refsForSuccessfulToolCall: vi.fn(() => []),
    };
    const processor = createToolCallProcessor(emit, binding, { cwd: "/home/op/project", gitWriteTracker });

    processor.onMessage(assistantToolUse("r7-failed-write", "Bash", { command: `echo x > ${TREE}/NODE.md` }));
    processor.onMessage(userToolResult("r7-failed-write", "failed", true));

    expect(gitWriteTracker.captureBaseline).toHaveBeenCalledTimes(2);
    expect(gitWriteTracker.refsForSuccessfulToolCall).not.toHaveBeenCalled();
    const final = toolCallEvents(emit).find(
      (event) => event.payload.toolUseId === "r7-failed-write" && event.payload.status === "error",
    );
    expect(final?.payload.toolFileRefs).toBeUndefined();
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

/**
 * W1 cloud layout: the shared external tree clone is exposed inside the agent
 * home as a `<workspace>/context-tree` symlink (runtime/workspace-manifest.ts),
 * while the binding carries the external clone's real path. Refs must map
 * regardless of which spelling the tool call used.
 */
describe("createToolCallProcessor — symlinked Context Tree (W1 cloud layout)", () => {
  let root: string;
  let realTree: string;
  let link: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "first-tree-symlink-refs-"));
    realTree = join(root, "context-tree-repos", "abc123");
    mkdirSync(join(realTree, "members"), { recursive: true });
    writeFileSync(join(realTree, "NODE.md"), "root");
    writeFileSync(join(realTree, "members", "NODE.md"), "members");
    const workspace = join(root, "workspaces", "agent-home");
    mkdirSync(workspace, { recursive: true });
    link = join(workspace, "context-tree");
    symlinkSync(realTree, link);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function bindingFor(path: string) {
    return { path, repoUrl: "https://github.com/example/tree", branch: "main" } as const;
  }

  function finalRefs(emit: ReturnType<typeof vi.fn<(event: SessionEvent) => void>>, id: string) {
    const final = emit.mock.calls
      .map((c) => c[0])
      .filter((ev) => ev.kind === "tool_call")
      .find((event) => event.payload.toolUseId === id && event.payload.status === "ok");
    return final?.payload.toolFileRefs;
  }

  it("maps a Read through the workspace symlink to the real-clone binding", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, bindingFor(realTree));

    processor.onMessage(assistantToolUse("s1", "Read", { file_path: join(link, "members", "NODE.md") }));
    processor.onMessage(userToolResult("s1", "contents"));

    expect(finalRefs(emit, "s1")).toEqual([
      {
        origin: "tool_arg",
        localPath: join(link, "members", "NODE.md"),
        repoUrl: "https://github.com/example/tree",
        repoBranch: "main",
        repoRelativePath: "members/NODE.md",
        pathKind: "file",
      },
    ]);
  });

  it("maps a Write creating a NEW file through the symlink (no existing path to realpath)", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, bindingFor(realTree));

    processor.onMessage(
      assistantToolUse("s2", "Write", { file_path: join(link, "domains", "new-leaf.md"), content: "x" }),
    );
    processor.onMessage(userToolResult("s2", "created"));

    expect(finalRefs(emit, "s2")?.[0]).toMatchObject({
      repoUrl: "https://github.com/example/tree",
      repoRelativePath: "domains/new-leaf.md",
    });
  });

  it("maps a Read of the real clone path when the binding is spelled as the symlink", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, bindingFor(link));

    processor.onMessage(assistantToolUse("s3", "Read", { file_path: join(realTree, "NODE.md") }));
    processor.onMessage(userToolResult("s3", "contents"));

    expect(finalRefs(emit, "s3")?.[0]).toMatchObject({
      repoUrl: "https://github.com/example/tree",
      repoRelativePath: "NODE.md",
    });
  });

  it("attaches a write ref for NotebookEdit via its notebook_path argument", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, bindingFor(realTree));

    processor.onMessage(
      assistantToolUse("s4", "NotebookEdit", { notebook_path: join(realTree, "members", "NODE.md") }),
    );
    processor.onMessage(userToolResult("s4", "edited"));

    expect(finalRefs(emit, "s4")?.[0]).toMatchObject({
      repoUrl: "https://github.com/example/tree",
      repoRelativePath: "members/NODE.md",
      pathKind: "file",
    });
  });

  it("attaches a directory-level ref for Grep with an explicit tree path", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, bindingFor(realTree));

    processor.onMessage(assistantToolUse("s5", "Grep", { pattern: "owners", path: join(link, "members") }));
    processor.onMessage(userToolResult("s5", "matches"));

    expect(finalRefs(emit, "s5")).toEqual([
      {
        origin: "tool_arg",
        localPath: join(link, "members"),
        repoUrl: "https://github.com/example/tree",
        repoBranch: "main",
        repoRelativePath: "members",
        pathKind: "directory",
      },
    ]);
  });

  it("attaches a repo-level ref for Glob rooted at the tree itself", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, bindingFor(realTree));

    processor.onMessage(assistantToolUse("s6", "Glob", { pattern: "**/*.md", path: realTree }));
    processor.onMessage(userToolResult("s6", "files"));

    expect(finalRefs(emit, "s6")?.[0]).toMatchObject({
      repoRelativePath: "/",
      pathKind: "repo",
    });
  });

  it("does NOT attach refs for Grep without an explicit path argument", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, bindingFor(realTree), { cwd: realTree });

    processor.onMessage(assistantToolUse("s7", "Grep", { pattern: "owners" }));
    processor.onMessage(userToolResult("s7", "matches"));

    expect(finalRefs(emit, "s7")).toBeUndefined();
  });

  it("attaches a local-only ref for Grep over a non-tree directory", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, bindingFor(realTree));
    const outside = join(root, "workspaces", "agent-home");

    processor.onMessage(assistantToolUse("s8", "Grep", { pattern: "x", path: outside }));
    processor.onMessage(userToolResult("s8", "matches"));

    expect(finalRefs(emit, "s8")).toEqual([
      {
        origin: "tool_arg",
        localPath: outside,
        pathKind: "directory",
      },
    ]);
  });

  it("maps a Bash read through the workspace symlink", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, bindingFor(realTree), { cwd: root });

    processor.onMessage(assistantToolUse("s9", "Bash", { command: `cat ${join(link, "NODE.md")}` }));
    processor.onMessage(userToolResult("s9", "contents"));

    expect(finalRefs(emit, "s9")?.[0]).toMatchObject({
      repoUrl: "https://github.com/example/tree",
      repoRelativePath: "NODE.md",
      pathKind: "file",
    });
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

/**
 * Repo-identity attribution: tree PRs are authored in `worktrees/<task>`
 * checkouts of the Context Tree repo, not in the bound shared clone. A Write
 * there must still carry repo evidence — this is where real tree writes live.
 */
describe("createToolCallProcessor — tree PR worktree attribution", () => {
  let root: string;
  let sharedClone: string;
  let treeWorktree: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args])
      .toString("utf8")
      .trim();
  }

  beforeEach(() => {
    clearGitRepoIdentityCacheForTests();
    root = mkdtempSync(join(tmpdir(), "first-tree-worktree-refs-"));
    sharedClone = join(root, "context-tree-repos", "abc123");
    mkdirSync(sharedClone, { recursive: true });
    git(join(root, "context-tree-repos"), "init", "abc123");
    git(sharedClone, "config", "user.email", "agent@example.com");
    git(sharedClone, "config", "user.name", "Agent");
    git(sharedClone, "remote", "add", "origin", "git@github.com:example/tree.git");
    writeFileSync(join(sharedClone, "NODE.md"), "root");
    git(sharedClone, "add", ".");
    git(sharedClone, "commit", "-m", "initial");
    treeWorktree = join(root, "worktrees", "task-tree");
    mkdirSync(join(root, "worktrees"), { recursive: true });
    git(sharedClone, "worktree", "add", treeWorktree, "-b", "task-branch");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    clearGitRepoIdentityCacheForTests();
  });

  it("attaches repo evidence when Write targets a tree PR worktree file", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit, {
      path: sharedClone,
      repoUrl: "https://github.com/example/tree",
      branch: "main",
    });

    processor.onMessage(
      assistantToolUse("wt1", "Write", {
        file_path: join(treeWorktree, "system", "new-node.md"),
        content: "x",
      }),
    );
    processor.onMessage(userToolResult("wt1", "created"));

    const final = emit.mock.calls
      .map((c) => c[0])
      .filter((ev) => ev.kind === "tool_call")
      .find((event) => event.payload.toolUseId === "wt1" && event.payload.status === "ok");
    expect(final?.payload.toolFileRefs).toEqual([
      {
        origin: "tool_arg",
        localPath: join(treeWorktree, "system", "new-node.md"),
        repoUrl: "https://github.com/example/tree",
        repoBranch: "main",
        repoRelativePath: "system/new-node.md",
        pathKind: "file",
      },
    ]);
  });
});
