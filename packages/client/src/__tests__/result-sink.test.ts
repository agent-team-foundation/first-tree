import type { ChatParticipantDetail } from "@agent-team-foundation/first-tree-hub-shared";
import { describe, expect, it, vi } from "vitest";
import { createParticipantCache } from "../runtime/agent-io.js";
import { createResultSink, type Trigger } from "../runtime/result-sink.js";
import type { FirstTreeHubSDK } from "../sdk.js";

/**
 * Contract tests for the forward-to-chat sink (runtime-owned, handler-agnostic).
 * These guard the **InReplyTo-required** and **Mention-default** invariants
 * from proposals/hub-agent-messaging-reply-and-mentions §3.4 without needing
 * a live Hub or a full handler. When a second handler (Gemini / Cursor / …)
 * is wired up, these remain the authoritative sink behaviour tests.
 */

const ME = "agent-me";

function mkParticipant(agentId: string, name: string, type = "autonomous_agent"): ChatParticipantDetail {
  return {
    agentId,
    role: "member",
    mode: "full",
    joinedAt: new Date().toISOString(),
    name,
    displayName: name,
    type,
  };
}

type SinkFixtures = {
  trigger: Trigger | null;
  participants: ChatParticipantDetail[];
  sendMessage?: ReturnType<typeof vi.fn>;
  listChatParticipants?: ReturnType<typeof vi.fn>;
};

function buildSink(fx: SinkFixtures) {
  const sendMessage = fx.sendMessage ?? vi.fn().mockResolvedValue(undefined);
  const listChatParticipants = fx.listChatParticipants ?? vi.fn().mockResolvedValue(fx.participants);
  const logs: string[] = [];

  let trigger = fx.trigger;
  const sdk = {
    serverUrl: "http://test",
    sendMessage,
    listChatParticipants,
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
    participants: createParticipantCache(sdk, "chat-1", (msg) => logs.push(msg)),
  });

  return { sink, sendMessage, listChatParticipants, logs };
}

describe("createResultSink — forwardResult enrichment", () => {
  it("populates inReplyTo with the current trigger messageId (InReplyTo-required)", async () => {
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m1", senderId: "agent-peer" },
      participants: [mkParticipant(ME, "me"), mkParticipant("agent-peer", "peer")],
    });

    await sink("final answer");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, body] = sendMessage.mock.calls[0] ?? [];
    expect(chatId).toBe("chat-1");
    expect(body).toMatchObject({ format: "text", content: "final answer", inReplyTo: "m1" });
  });

  it("omits mentions metadata in a 2-person direct chat when peer is full-mode (human↔agent)", async () => {
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m1", senderId: "agent-peer" },
      participants: [mkParticipant(ME, "me"), mkParticipant("agent-peer", "peer")],
    });

    await sink("final answer");

    const body = sendMessage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.metadata).toBeUndefined();
  });

  it("emits default trigger mention in a 2-person direct chat when peer is mention_only (agent↔agent)", async () => {
    // Migration 0029 + findOrCreateDirectChat seed both participants as
    // `mention_only` in agent↔agent direct chats so courtesy replies don't
    // wake the peer and produce A↔B reply loops. The sink has to
    // explicitly @-mention the trigger sender to route the genuine reply
    // back to them; without this branch, B's answer to A's question would
    // land silently and A would never see it.
    const peer = mkParticipant("agent-peer", "peer");
    peer.mode = "mention_only";
    const me = mkParticipant(ME, "me");
    me.mode = "mention_only";
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m1", senderId: "agent-peer" },
      participants: [me, peer],
    });

    await sink("final answer");

    const body = sendMessage.mock.calls[0]?.[1] as { metadata?: { mentions?: string[] } };
    expect(body.metadata?.mentions).toEqual(["agent-peer"]);
  });

  it("defaults mentions to [trigger.senderId] in a group chat (Mention-default)", async () => {
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m2", senderId: "agent-peer" },
      participants: [mkParticipant(ME, "me"), mkParticipant("agent-peer", "peer"), mkParticipant("agent-obs", "obs")],
    });

    await sink("hi there");

    const body = sendMessage.mock.calls[0]?.[1] as { metadata?: { mentions?: string[] } };
    expect(body.metadata?.mentions).toEqual(["agent-peer"]);
  });

  it("does NOT itself parse `@name` tokens from the reply — server is authoritative", async () => {
    // `@name` → agentId resolution lives server-side in sendMessage (see
    // services/message.ts). The sink only contributes the default trigger
    // mention; unmatched tokens are server-logged. This test pins that the
    // client does not emit a local attempt at resolution that could diverge
    // from the server.
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m3", senderId: "agent-peer" },
      participants: [mkParticipant(ME, "me"), mkParticipant("agent-peer", "peer"), mkParticipant("agent-obs", "obs")],
    });

    await sink("planning: @obs please double-check");

    const body = sendMessage.mock.calls[0]?.[1] as { metadata?: { mentions?: string[] } };
    // Only the default trigger mention — @obs is NOT added client-side.
    expect(body.metadata?.mentions).toEqual(["agent-peer"]);
  });

  it("filters self out of the default mention when the trigger sender is ourselves", async () => {
    // Pathological: server-side filtering usually drops self-fanouts, but the
    // sink must degrade gracefully without emitting self-mentions.
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m4", senderId: ME },
      participants: [mkParticipant(ME, "me"), mkParticipant("agent-peer", "peer"), mkParticipant("agent-obs", "obs")],
    });

    await sink("status update");

    const body = sendMessage.mock.calls[0]?.[1] as { metadata?: { mentions?: string[] } };
    expect(body.metadata).toBeUndefined();
  });

  it("still sends the reply even if listChatParticipants rejects (defensive fallback)", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const listChatParticipants = vi.fn().mockRejectedValue(new Error("hub down"));
    const { sink, logs } = buildSink({
      trigger: { messageId: "m5", senderId: "agent-peer" },
      participants: [],
      sendMessage,
      listChatParticipants,
    });

    await sink("going out anyway");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes("listChatParticipants failed"))).toBe(true);
  });

  describe("L4 silent-turn protocol — empty output skips delivery", () => {
    // The agent prompt in bootstrap.ts tells agents: "if you have nothing
    // new for the recipient, output nothing and the runtime will end the
    // turn silently". This block is the matching code-side enforcement —
    // empty/whitespace output is the agent's explicit "I choose silent
    // turn" signal and the runtime must honor it without firing
    // sendMessage. Decision-vs-execution split: only purely empty output
    // is treated as silence; non-empty content is never length-filtered.

    it("skips sendMessage when the agent produces an empty string", async () => {
      const { sink, sendMessage, logs } = buildSink({
        trigger: { messageId: "m-silent", senderId: "agent-peer" },
        participants: [mkParticipant(ME, "me"), mkParticipant("agent-peer", "peer")],
      });

      await sink("");

      expect(sendMessage).not.toHaveBeenCalled();
      expect(logs.some((l) => l.includes("silent turn"))).toBe(true);
    });

    it("skips sendMessage when the agent produces whitespace-only output", async () => {
      const { sink, sendMessage, logs } = buildSink({
        trigger: { messageId: "m-ws", senderId: "agent-peer" },
        participants: [mkParticipant(ME, "me"), mkParticipant("agent-peer", "peer")],
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
        participants: [mkParticipant(ME, "me"), mkParticipant("agent-peer", "peer")],
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
        listChatParticipants: vi.fn().mockResolvedValue([mkParticipant(ME, "me")]),
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
        participants: createParticipantCache(sdk, "chat-1", () => {}),
      });

      await sink("");

      // The trigger was cleared while it still held the silent-turn's
      // originating message — observed exactly once. After the call the
      // runtime sees a clean slate, so any next injection starts fresh
      // rather than re-using m-clear's senderId for the next reply.
      expect(observedTrigger).toHaveLength(1);
      expect(observedTrigger[0]?.messageId).toBe("m-clear");
      expect(trigger).toBeNull();
    });
  });

  it("clears the trigger before awaiting sendMessage so a concurrent inject-driven trigger isn't consumed", async () => {
    // Regression for the race the handler used to guard. The sink's
    // `clearTrigger` must fire synchronously before the async transport, so
    // a new trigger set mid-await is attached to the NEXT forward, not this one.
    let trigger: Trigger | null = { messageId: "m-current", senderId: "agent-peer" };
    const observedTriggers: (Trigger | null)[] = [];
    const sendMessage = vi.fn().mockImplementation(async () => {
      observedTriggers.push(trigger);
    });

    const sdkForRace = {
      serverUrl: "http://test",
      sendMessage,
      listChatParticipants: vi.fn().mockResolvedValue([mkParticipant(ME, "me")]),
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
      participants: createParticipantCache(sdkForRace, "chat-1", () => {}),
    });

    const done = sink("reply text");
    // Simulate an inject mid-flight installing a new trigger.
    trigger = { messageId: "m-next", senderId: "agent-other" };
    await done;

    // The in-flight forward used m-current's inReplyTo (captured before clear);
    // the mid-await trigger sets the stage for the NEXT turn.
    const body = sendMessage.mock.calls[0]?.[1] as { inReplyTo?: string };
    expect(body.inReplyTo).toBe("m-current");
    expect(observedTriggers[0]?.messageId).toBe("m-next"); // sanity: mid-await change observed
  });
});
