import { describe, expect, it, vi } from "vitest";
import { createResultSink, type Trigger } from "../runtime/result-sink.js";
import type { FirstTreeHubSDK } from "../sdk.js";

/**
 * Contract tests for the forward-to-chat sink (runtime-owned, handler-agnostic).
 *
 * v1 §四 改造 4: the trigger-sender mention auto-injection branch was
 * deleted to break the agent ↔ agent echo loop. These tests pin:
 *
 *   1. final-text deliveries no longer inject `metadata.mentions`
 *      (case 1, case 5);
 *   2. the documentContext metadata branch (PR #356) is preserved
 *      (case 1.5 — the v1.5 regression guard);
 *   3. silent-turn + `inReplyTo` invariants survive (case 2 / case 3);
 *   4. `chat send <target>` wake-ups stay outside this sink (server side).
 */

const ME = "agent-me";

type SinkFixtures = {
  trigger: Trigger | null;
  sendMessage?: ReturnType<typeof vi.fn>;
  getDocumentBasePath?: () => Promise<string | null>;
};

function buildSink(fx: SinkFixtures) {
  const sendMessage = fx.sendMessage ?? vi.fn().mockResolvedValue(undefined);
  const logs: string[] = [];

  let trigger = fx.trigger;
  const sdk = {
    serverUrl: "http://test",
    sendMessage,
  } as unknown as FirstTreeHubSDK;

  const sink = createResultSink({
    sdk,
    agent: {
      agentId: ME,
      inboxId: "inbox-me",
      displayName: "test-agent",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    },
    chatId: "chat-1",
    getTrigger: () => trigger,
    clearTrigger: () => {
      trigger = null;
    },
    log: (msg) => logs.push(msg),
    getDocumentBasePath: fx.getDocumentBasePath,
  });

  return { sink, sendMessage, logs };
}

describe("createResultSink — forwardResult enrichment", () => {
  it("case 1: non-empty output WITHOUT documentBasePath omits metadata entirely (no mention auto-injection)", async () => {
    // v1 §四 改造 4: trigger-sender mention is no longer injected here.
    // Without a documentBasePath there's nothing else for buildMetadata to
    // contribute, so metadata is left off the wire.
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m1", senderId: "agent-peer" },
    });

    await sink("final answer");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, body] = sendMessage.mock.calls[0] ?? [];
    expect(chatId).toBe("chat-1");
    expect(body).toMatchObject({ format: "text", content: "final answer", inReplyTo: "m1" });
    expect((body as Record<string, unknown>).metadata).toBeUndefined();
    // v1 §四 改造 4 (b): final text always carries `purpose: "agent-final-text"`
    // so server bypasses enforceGroupMention + fan-out is forced notify=false.
    expect((body as Record<string, unknown>).purpose).toBe("agent-final-text");
  });

  it('every forward carries `purpose: "agent-final-text"` — server uses it to bypass group-chat mention enforcement', async () => {
    // Pin the bypass tag on the wire so AskUserQuestion + result-sink both
    // continue to land in group chats without 400s after改造 4 removed the
    // client-side mention auto-injection. Server匹配此 field 跳过
    // enforceGroupMention + 强制全员 notify=false.
    const { sink, sendMessage } = buildSink({ trigger: null });

    await sink("turn ended");

    const body = sendMessage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.purpose).toBe("agent-final-text");
  });

  it("case 1.5 (documentContext regression): writes metadata.documentContext + omits metadata.mentions", async () => {
    // v1.5 regression guard — PR #356's documentContext injection must
    // survive改造 4 surgery. Verifying the branch is still wired AND that
    // it is NOT accompanied by an automatic mentions array.
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m1", senderId: "agent-peer" },
      getDocumentBasePath: vi.fn().mockResolvedValue("first-tree-hub"),
    });

    await sink("see [design](docs/design.md)");

    const body = sendMessage.mock.calls[0]?.[1] as {
      metadata?: { documentContext?: { basePath?: string }; mentions?: unknown };
    };
    expect(body.metadata?.documentContext).toEqual({ basePath: "first-tree-hub" });
    expect(body.metadata?.mentions).toBeUndefined();
  });

  it("case 3: inReplyTo is set from the current trigger (InReplyTo-required)", async () => {
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m-abc", senderId: "agent-peer" },
    });

    await sink("final answer");

    const body = sendMessage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.inReplyTo).toBe("m-abc");
  });

  it("case 3b: no inReplyTo when there's no current trigger (unprompted forward)", async () => {
    const { sink, sendMessage } = buildSink({ trigger: null });

    await sink("status update");

    const body = sendMessage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.inReplyTo).toBeUndefined();
    expect(body.metadata).toBeUndefined();
  });

  it("case 5: never emits self-mention even when trigger senderId == own agentId", async () => {
    // Defensive: server-side filtering usually drops self-fanouts, but the
    // sink must degrade gracefully without emitting self-mentions.
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m-self", senderId: ME },
    });

    await sink("status update");

    const body = sendMessage.mock.calls[0]?.[1] as { metadata?: { mentions?: unknown } };
    expect(body.metadata).toBeUndefined();
  });

  it("does NOT itself parse `@name` tokens from the reply — server is authoritative", async () => {
    // `@name` → agentId resolution lives server-side in sendMessage (see
    // services/message.ts). The sink contributes no mention metadata at all
    // after改造 4. Any token resolution that happens is the server's job.
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m3", senderId: "agent-peer" },
    });

    await sink("planning: @obs please double-check");

    const body = sendMessage.mock.calls[0]?.[1] as { metadata?: { mentions?: unknown } };
    expect(body.metadata).toBeUndefined();
  });

  describe("case 2: silent-turn protocol — empty output skips delivery", () => {
    it("skips sendMessage when the agent produces an empty string", async () => {
      const { sink, sendMessage, logs } = buildSink({
        trigger: { messageId: "m-silent", senderId: "agent-peer" },
      });

      await sink("");

      expect(sendMessage).not.toHaveBeenCalled();
      expect(logs.some((l) => l.includes("silent turn"))).toBe(true);
    });

    it("skips sendMessage when the agent produces whitespace-only output", async () => {
      const { sink, sendMessage, logs } = buildSink({
        trigger: { messageId: "m-ws", senderId: "agent-peer" },
      });

      await sink("   \n\t  ");

      expect(sendMessage).not.toHaveBeenCalled();
      expect(logs.some((l) => l.includes("silent turn"))).toBe(true);
    });

    it("does NOT skip when the agent produces any non-empty content (no length filtering)", async () => {
      // Single-character replies, short statuses, and any non-empty content
      // must pass through untouched — the runtime never evaluates "is this
      // meaningful?". That's the agent's call (via prompt), not code's.
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m-short", senderId: "agent-peer" },
      });

      await sink(".");

      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("clears the trigger on silent turn so the next inbound message isn't accidentally still bound", async () => {
      let trigger: Trigger | null = { messageId: "m-clear", senderId: "agent-peer" };
      const observedTrigger: (Trigger | null)[] = [];
      const sdk = {
        serverUrl: "http://test",
        sendMessage: vi.fn().mockResolvedValue(undefined),
      } as unknown as FirstTreeHubSDK;
      const sink = createResultSink({
        sdk,
        agent: {
          agentId: ME,
          inboxId: "inbox-me",
          displayName: "test-agent",
          type: "autonomous_agent",
          delegateMention: null,
          metadata: {},
        },
        chatId: "chat-1",
        getTrigger: () => trigger,
        clearTrigger: () => {
          observedTrigger.push(trigger);
          trigger = null;
        },
        log: () => {},
      });

      await sink("");

      expect(observedTrigger).toHaveLength(1);
      expect(observedTrigger[0]?.messageId).toBe("m-clear");
      expect(trigger).toBeNull();
    });
  });

  it("clears the trigger before awaiting sendMessage so a concurrent inject-driven trigger isn't consumed", async () => {
    let trigger: Trigger | null = { messageId: "m-current", senderId: "agent-peer" };
    const observedTriggers: (Trigger | null)[] = [];
    const sendMessage = vi.fn().mockImplementation(async () => {
      observedTriggers.push(trigger);
    });

    const sdkForRace = {
      serverUrl: "http://test",
      sendMessage,
    } as unknown as FirstTreeHubSDK;
    const sink = createResultSink({
      sdk: sdkForRace,
      agent: {
        agentId: ME,
        inboxId: "inbox-me",
        displayName: "test-agent",
        type: "autonomous_agent",
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-1",
      getTrigger: () => trigger,
      clearTrigger: () => {
        trigger = null;
      },
      log: () => {},
    });

    const done = sink("reply text");
    trigger = { messageId: "m-next", senderId: "agent-other" };
    await done;

    const body = sendMessage.mock.calls[0]?.[1] as { inReplyTo?: string };
    expect(body.inReplyTo).toBe("m-current");
    expect(observedTriggers[0]?.messageId).toBe("m-next");
  });
});
