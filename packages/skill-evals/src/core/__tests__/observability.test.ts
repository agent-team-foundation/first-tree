import { describe, expect, it } from "vitest";

import { deriveRunObservability } from "../observability.js";

describe("run observability", () => {
  it("derives turns and first response latency from assistant codex events", () => {
    const observability = deriveRunObservability([
      {
        timestamp: "2026-06-29T01:00:00.000Z",
        type: "codex_run_started",
      },
      {
        event: {
          content: "I will inspect the repo.",
          type: "agent_message",
        },
        timestamp: "2026-06-29T01:00:01.250Z",
        type: "codex_event",
      },
      {
        event: {
          item: {
            role: "assistant",
          },
          text: "Final response.",
          type: "message",
        },
        timestamp: "2026-06-29T01:00:05.000Z",
        type: "codex_event",
      },
    ]);

    expect(observability).toEqual({
      firstResponseLatencyMs: 1250,
      turns: 2,
    });
  });

  it("returns nulls when no assistant response event is derivable", () => {
    expect(
      deriveRunObservability([
        {
          timestamp: "2026-06-29T01:00:00.000Z",
          type: "codex_run_started",
        },
        {
          event: {
            type: "exec_command",
          },
          timestamp: "2026-06-29T01:00:01.000Z",
          type: "codex_event",
        },
      ]),
    ).toEqual({
      firstResponseLatencyMs: null,
      turns: null,
    });
  });

  it("derives first response latency from Claude provider start events", () => {
    const observability = deriveRunObservability([
      {
        timestamp: "2026-06-29T01:00:00.000Z",
        type: "claude_run_started",
      },
      {
        event: {
          content: "Claude response.",
          type: "assistant_message",
        },
        timestamp: "2026-06-29T01:00:02.000Z",
        type: "codex_event",
      },
    ]);

    expect(observability).toEqual({
      firstResponseLatencyMs: 2000,
      turns: 1,
    });
  });
});
