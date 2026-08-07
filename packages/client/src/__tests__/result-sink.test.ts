import { describe, expect, it } from "vitest";
import { createResultSink } from "../runtime/result-sink.js";

/**
 * Contract tests for the turn-completion sink.
 *
 * The final-text mirror is RETIRED (first-tree#941): `forwardResult` no longer
 * delivers an agent's final text to chat. These tests pin that it writes
 * nothing — for both a non-empty turn and a silent one — and still clears the
 * turn trigger so the next inject() starts clean.
 */

function buildSink(initialTrigger: { messageId: string; senderId: string } | null) {
  const logs: string[] = [];
  let trigger = initialTrigger;

  const sink = createResultSink({
    clearTrigger: () => {
      trigger = null;
    },
    log: (msg) => logs.push(msg),
  });

  return { sink, logs, readTrigger: () => trigger };
}

describe("createResultSink — final-text delivery retired", () => {
  it("clears trigger and logs retired delivery for a non-empty turn", async () => {
    const { sink, logs, readTrigger } = buildSink({ messageId: "m1", senderId: "agent-peer" });

    await sink("final answer");

    expect(readTrigger()).toBeNull();
    expect(logs.some((m) => /retired/.test(m))).toBe(true);
  });

  it("logs a silent turn for empty / whitespace-only output", async () => {
    const { sink, logs } = buildSink(null);

    await sink("   ");

    expect(logs.some((m) => /silent turn/.test(m))).toBe(true);
  });

  it("clears the turn trigger so a concurrent inject() starts clean", async () => {
    const { sink, readTrigger } = buildSink({ messageId: "m1", senderId: "agent-peer" });
    expect(readTrigger()).not.toBeNull();

    await sink("final answer");

    expect(readTrigger()).toBeNull();
  });
});
