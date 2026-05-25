import type { SessionEvent } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { sanitizeSessionEventForTransport } from "../client-connection.js";

/**
 * Outbound boundary for client-to-server WS frames. Binary tool stdout that
 * survives Buffer.toString('utf8') (NULs + U+FFFD bursts) must be replaced with
 * a placeholder so the event still persists server-side and the timeline shows
 * the call happened. The matching last-mile gate (NUL strip on the JSON before
 * the JSONB insert) lives in the server-side appendEvent.
 */

const NUL = String.fromCharCode(0);
const FFFD = String.fromCharCode(0xfffd);

describe("sanitizeSessionEventForTransport", () => {
  function toolCall(resultPreview: string | undefined): SessionEvent {
    return {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-1",
        name: "Bash",
        args: { command: "gh api repos/foo/bar/actions/runs/1/logs" },
        status: "ok",
        durationMs: 1234,
        ...(resultPreview !== undefined ? { resultPreview } : {}),
      },
    };
  }

  it("passes plain text previews through unchanged", () => {
    const event = toolCall("clean stdout output\nwith newlines");
    expect(sanitizeSessionEventForTransport(event)).toBe(event);
  });

  it("passes events without resultPreview through unchanged", () => {
    const event = toolCall(undefined);
    expect(sanitizeSessionEventForTransport(event)).toBe(event);
  });

  it("replaces a preview containing a NUL with a placeholder", () => {
    const preview = `PK${NUL}enforce/system.txt${NUL}ZIP-bytes`;
    const sanitized = sanitizeSessionEventForTransport(toolCall(preview));
    if (sanitized.kind !== "tool_call") throw new Error("expected tool_call");
    expect(sanitized.payload.resultPreview).toBe(`[binary content, ${preview.length} chars elided]`);
  });

  it("replaces a preview with many U+FFFD replacement chars", () => {
    const preview = `garbage ${FFFD.repeat(20)} bytes`;
    const sanitized = sanitizeSessionEventForTransport(toolCall(preview));
    if (sanitized.kind !== "tool_call") throw new Error("expected tool_call");
    expect(sanitized.payload.resultPreview).toBe(`[binary content, ${preview.length} chars elided]`);
  });

  it("keeps previews with only a few U+FFFD (below threshold) intact", () => {
    const preview = `some text with one ${FFFD} and another ${FFFD} elsewhere`;
    const event = toolCall(preview);
    expect(sanitizeSessionEventForTransport(event)).toBe(event);
  });

  it("does not mutate the original event", () => {
    const preview = `before${NUL}after`;
    const event = toolCall(preview);
    sanitizeSessionEventForTransport(event);
    if (event.kind !== "tool_call") throw new Error("expected tool_call");
    expect(event.payload.resultPreview).toBe(preview);
  });

  it("ignores non-tool_call events", () => {
    const event: SessionEvent = { kind: "error", payload: { source: "sdk", message: `boom${NUL}` } };
    expect(sanitizeSessionEventForTransport(event)).toBe(event);
  });
});
