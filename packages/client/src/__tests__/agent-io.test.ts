import type { ChatParticipantDetail } from "@agent-team-foundation/first-tree-hub-shared";
import { describe, expect, it, vi } from "vitest";
import {
  buildAgentEnv,
  createParticipantCache,
  formatInboundContent,
  resolveSenderLabel,
} from "../runtime/agent-io.js";
import type { SessionMessage } from "../runtime/handler.js";
import type { FirstTreeHubSDK } from "../sdk.js";

function mkParticipant(agentId: string, name: string | null, displayName?: string): ChatParticipantDetail {
  return {
    agentId,
    role: "member",
    mode: "full",
    joinedAt: new Date().toISOString(),
    name,
    // Post-Phase 2 the wire shape requires a non-null display name; fall
    // back to a synthetic label when the caller doesn't provide one.
    displayName: displayName ?? `agent-${agentId}`,
    type: "autonomous_agent",
  };
}

function mkSdk(listImpl?: () => Promise<ChatParticipantDetail[]>): FirstTreeHubSDK {
  const sdk = {
    serverUrl: "http://test",
    listChatParticipants: listImpl ? vi.fn(listImpl) : vi.fn().mockResolvedValue([]),
  } as unknown as FirstTreeHubSDK;
  return sdk;
}

describe("resolveSenderLabel", () => {
  const ps = [
    mkParticipant("agent-a", "alice", "Alice Smith"),
    mkParticipant("agent-b", null, "Bob Only"),
    mkParticipant("agent-c", null),
  ];

  it("returns the participant name when available", () => {
    expect(resolveSenderLabel("agent-a", ps)).toBe("alice");
  });

  it("falls back to displayName when name is null", () => {
    expect(resolveSenderLabel("agent-b", ps)).toBe("Bob Only");
  });

  it("falls back to the raw senderId when the name is null (displayName post-Phase 2 is non-null but may be synthetic)", () => {
    // Post-Phase 2 displayName is guaranteed non-null at the DB level, so
    // the prior "both null" case is unreachable. The next best fallback
    // `resolveSenderLabel` covers is still the raw senderId for rows whose
    // displayName was synthesised from the agentId; the `mkParticipant`
    // helper mirrors that (`agent-${agentId}`).
    expect(resolveSenderLabel("agent-c", ps)).toBe("agent-agent-c");
  });

  it("returns the raw senderId when not present among participants (stale cache / ex-member)", () => {
    expect(resolveSenderLabel("agent-unknown", ps)).toBe("agent-unknown");
  });
});

describe("formatInboundContent", () => {
  const participants = [mkParticipant("agent-a", "alice")];

  it("prefixes [From: <name>] when the sender is a known participant", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "text",
      content: "hello",
      metadata: null,
    };
    expect(await formatInboundContent(msg, cache)).toBe("[From: alice]\n\nhello");
  });

  it("falls back to senderId in the prefix when the sender is not a participant", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-ghost",
      format: "text",
      content: "hi",
      metadata: null,
    };
    expect(await formatInboundContent(msg, cache)).toBe("[From: agent-ghost]\n\nhi");
  });

  it("serialises non-string content to JSON under the same attribution", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "card",
      content: { title: "hi" },
      metadata: null,
    };
    expect(await formatInboundContent(msg, cache)).toBe(`[From: alice]\n\n${JSON.stringify({ title: "hi" })}`);
  });

  it("omits the attribution prefix when senderId is empty", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "",
      format: "text",
      content: "anon",
      metadata: null,
    };
    expect(await formatInboundContent(msg, cache)).toBe("anon");
  });

  it("only calls listChatParticipants once across many messages (cache hit)", async () => {
    const listFn = vi.fn().mockResolvedValue(participants);
    const sdk = { serverUrl: "http://test", listChatParticipants: listFn } as unknown as FirstTreeHubSDK;
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "text",
      content: "x",
      metadata: null,
    };
    await formatInboundContent(msg, cache);
    await formatInboundContent(msg, cache);
    await formatInboundContent(msg, cache);
    expect(listFn).toHaveBeenCalledTimes(1);
  });

  it("returns [] from the cache on fetch failure and logs (graceful degrade)", async () => {
    const logs: string[] = [];
    const sdk = mkSdk(() => Promise.reject(new Error("hub down")));
    const cache = createParticipantCache(sdk, "chat-1", (m) => logs.push(m));
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "text",
      content: "hi",
      metadata: null,
    };
    // Without participants we can't resolve "agent-a" → "alice"; fall back to id.
    expect(await formatInboundContent(msg, cache)).toBe("[From: agent-a]\n\nhi");
    expect(logs.some((l) => l.includes("listChatParticipants failed"))).toBe(true);
  });
});

describe("buildAgentEnv", () => {
  it("layers the four Hub envelope vars on top of parent env (parent wins on unrelated keys)", () => {
    const parent = { PATH: "/usr/bin", FOO: "bar" } as NodeJS.ProcessEnv;
    const env = buildAgentEnv(parent, {
      sdk: { serverUrl: "http://hub" },
      agent: {
        agentId: "agent-a",
        inboxId: "inbox-a",
        displayName: "agent-a",
        type: "autonomous_agent",
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-1",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FOO).toBe("bar");
    expect(env.FIRST_TREE_HUB_SERVER_URL).toBe("http://hub");
    expect(env.FIRST_TREE_HUB_AGENT_ID).toBe("agent-a");
    expect(env.FIRST_TREE_HUB_INBOX_ID).toBe("inbox-a");
    expect(env.FIRST_TREE_HUB_CHAT_ID).toBe("chat-1");
  });

  it("overrides any pre-existing FIRST_TREE_HUB_* value in the parent env", () => {
    const parent = { FIRST_TREE_HUB_CHAT_ID: "wrong-chat" } as NodeJS.ProcessEnv;
    const env = buildAgentEnv(parent, {
      sdk: { serverUrl: "http://hub" },
      agent: {
        agentId: "agent-a",
        inboxId: "inbox-a",
        displayName: "agent-a",
        type: "autonomous_agent",
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-right",
    });
    expect(env.FIRST_TREE_HUB_CHAT_ID).toBe("chat-right");
  });
});
