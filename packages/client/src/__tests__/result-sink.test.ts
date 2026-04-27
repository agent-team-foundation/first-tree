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

  it("omits mentions metadata in a 2-person direct chat (peer is always full-mode)", async () => {
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m1", senderId: "agent-peer" },
      participants: [mkParticipant(ME, "me"), mkParticipant("agent-peer", "peer")],
    });

    await sink("final answer");

    const body = sendMessage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.metadata).toBeUndefined();
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
