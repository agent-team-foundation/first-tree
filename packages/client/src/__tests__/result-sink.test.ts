import { describe, expect, it, vi } from "vitest";
import { createResultSink, type Trigger } from "../runtime/result-sink.js";
import type { FirstTreeHubSDK } from "../sdk.js";

/**
 * Contract tests for the turn-completion sink.
 *
 * The final-text mirror is RETIRED (first-tree#941): `forwardResult` no longer
 * delivers an agent's final text to chat. These tests pin that it writes
 * nothing — for both a non-empty turn and a silent one — and still clears the
 * turn trigger so the next inject() starts clean.
 */

const ME = "agent-me";

function buildSink(initialTrigger: Trigger | null) {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const logs: string[] = [];
  let trigger = initialTrigger;

  const sdk = { serverUrl: "http://test", sendMessage } as unknown as FirstTreeHubSDK;

  const sink = createResultSink({
    sdk,
    agent: {
      agentId: ME,
      inboxId: "inbox-me",
      displayName: "test-agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    chatId: "chat-1",
    getTrigger: () => trigger,
    clearTrigger: () => {
      trigger = null;
    },
    log: (msg) => logs.push(msg),
  });

  return { sink, sendMessage, logs, readTrigger: () => trigger };
}

describe("createResultSink — final-text delivery retired", () => {
  it("does NOT deliver a non-empty final text to chat", async () => {
    const { sink, sendMessage } = buildSink({ messageId: "m1", senderId: "agent-peer" });

    await sink("final answer");

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does NOT deliver an empty / whitespace-only (silent) turn either", async () => {
    const { sink, sendMessage } = buildSink(null);

    await sink("   ");

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("clears the turn trigger so a concurrent inject() starts clean", async () => {
    const { sink, readTrigger } = buildSink({ messageId: "m1", senderId: "agent-peer" });
    expect(readTrigger()).not.toBeNull();

    await sink("final answer");

    expect(readTrigger()).toBeNull();
  });

  it("logs that final-text delivery is retired on a non-empty turn", async () => {
    const { sink, logs } = buildSink(null);

    await sink("did the thing");

    expect(logs.some((m) => /retired/.test(m))).toBe(true);
  });
});
