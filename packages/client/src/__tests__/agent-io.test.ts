import type { ChatParticipantDetail } from "@first-tree/shared";
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
    avatarColorToken: null,
    avatarImageUrl: null,
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
    // Pre-Phase-2 nullable displayName is gone, but `""` is still a
    // reachable DB state (the temporary DEFAULT '' added by migration
    // 0024 catches old INSERTs during a rolling deploy). Keep the
    // "both falsy" coverage by pinning the empty-string branch.
    mkParticipant("agent-c", null, ""),
  ];

  it("returns the participant name when available", () => {
    expect(resolveSenderLabel("agent-a", ps)).toBe("alice");
  });

  it("falls back to displayName when name is null", () => {
    expect(resolveSenderLabel("agent-b", ps)).toBe("Bob Only");
  });

  it("falls back to the raw senderId when name is null and displayName is empty", () => {
    // Covers the `return senderId` branch inside the participant-match
    // loop (runtime/agent-io.ts) — still reachable for rows that came
    // in under the migration 0024 rollout default.
    expect(resolveSenderLabel("agent-c", ps)).toBe("agent-c");
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

  it("renders precedingMessages as an [Earlier in chat] block before the trigger", async () => {
    const ps = [mkParticipant("agent-a", "alice"), mkParticipant("agent-b", "bob"), mkParticipant("agent-c", "carol")];
    const sdk = mkSdk(async () => ps);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m3",
      chatId: "chat-1",
      senderId: "agent-c",
      format: "text",
      content: "@me what do you think?",
      metadata: null,
      precedingMessages: [
        {
          id: "m1",
          senderId: "agent-a",
          format: "text",
          content: "anyone seen the report?",
          metadata: {},
          createdAt: new Date().toISOString(),
        },
        {
          id: "m2",
          senderId: "agent-b",
          format: "text",
          content: "yeah, working on it",
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      ],
    };
    const out = await formatInboundContent(msg, cache);
    expect(out).toContain("[Earlier in chat — context you missed]");
    expect(out).toContain("[From: alice] anyone seen the report?");
    expect(out).toContain("[From: bob] yeah, working on it");
    expect(out).toContain("[Now — message that woke you]");
    expect(out).toContain("[From: carol]\n\n@me what do you think?");
    // Ordering: earlier block must precede the trigger.
    expect(out.indexOf("[Earlier in chat")).toBeLessThan(out.indexOf("[Now — message"));
    expect(out.indexOf("[Now — message")).toBeLessThan(out.indexOf("[From: carol]"));
  });

  it("omits the [Earlier in chat] block when precedingMessages is empty / absent", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "text",
      content: "hi",
      metadata: null,
      precedingMessages: [],
    };
    const out = await formatInboundContent(msg, cache);
    expect(out).toBe("[From: alice]\n\nhi");
    expect(out).not.toContain("[Earlier in chat");
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
    expect(env.FIRST_TREE_SERVER_URL).toBe("http://hub");
    expect(env.FIRST_TREE_AGENT_ID).toBe("agent-a");
    expect(env.FIRST_TREE_INBOX_ID).toBe("inbox-a");
    expect(env.FIRST_TREE_CHAT_ID).toBe("chat-1");
  });

  it("overrides any pre-existing FIRST_TREE_* value in the parent env", () => {
    const parent = { FIRST_TREE_CHAT_ID: "wrong-chat" } as NodeJS.ProcessEnv;
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
    expect(env.FIRST_TREE_CHAT_ID).toBe("chat-right");
  });

  it("injects BOTH wide (agent home) and narrow (legacy base) doc fences + workspaces root + slug for `chat send`", () => {
    // Wide-fence vars enable the new worktree-fence behaviour; the legacy
    // `FIRST_TREE_DOC_BASE` is kept emitting so a stale pre-fix `chat send`
    // binary inherited from this process still snapshots like it used to.
    const env = buildAgentEnv({} as NodeJS.ProcessEnv, {
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
      docContext: {
        base: "/ws/coder/first-tree",
        agentHome: "/ws/coder",
        singleRepoLocalPath: "first-tree",
        workspacesRoot: "/ws",
        selfSlug: "coder",
      },
    });
    expect(env.FIRST_TREE_DOC_BASE).toBe("/ws/coder/first-tree");
    expect(env.FIRST_TREE_DOC_AGENT_HOME).toBe("/ws/coder");
    expect(env.FIRST_TREE_DOC_REPO_LOCAL_PATH).toBe("first-tree");
    expect(env.FIRST_TREE_WORKSPACES_ROOT).toBe("/ws");
    expect(env.FIRST_TREE_AGENT_SLUG).toBe("coder");
  });

  it("omits FIRST_TREE_DOC_REPO_LOCAL_PATH when the agent has no single declared source repo", () => {
    // Zero / multi-repo agents have nothing to promote — the env var is
    // suppressed so chat-send doesn't try to derive a promotion prefix from
    // garbage and accidentally widen the fence in a different way.
    const env = buildAgentEnv({} as NodeJS.ProcessEnv, {
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
      docContext: { base: "/ws/coder", agentHome: "/ws/coder", workspacesRoot: "/ws", selfSlug: "coder" },
    });
    expect(env.FIRST_TREE_DOC_AGENT_HOME).toBe("/ws/coder");
    expect(env.FIRST_TREE_DOC_REPO_LOCAL_PATH).toBeUndefined();
  });

  it("omits doc-preview env vars when no docContext is provided (self-only / non-agent shells)", () => {
    const env = buildAgentEnv({} as NodeJS.ProcessEnv, {
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
    expect(env.FIRST_TREE_DOC_BASE).toBeUndefined();
    expect(env.FIRST_TREE_DOC_AGENT_HOME).toBeUndefined();
    expect(env.FIRST_TREE_DOC_REPO_LOCAL_PATH).toBeUndefined();
    expect(env.FIRST_TREE_WORKSPACES_ROOT).toBeUndefined();
    expect(env.FIRST_TREE_AGENT_SLUG).toBeUndefined();
  });
});
