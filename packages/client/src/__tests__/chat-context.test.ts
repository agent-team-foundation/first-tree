import type { ChatDetail, ChatParticipantDetail } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import { fetchChatContext } from "../runtime/chat-context.js";
import { renderChatContextPrompt, renderChatContextSection } from "../runtime/chat-context-section.js";

function mkParticipant(extras: Partial<ChatParticipantDetail>): ChatParticipantDetail {
  return {
    agentId: extras.agentId ?? "agent-x",
    role: extras.role ?? "member",
    mode: extras.mode ?? "full",
    joinedAt: extras.joinedAt ?? new Date().toISOString(),
    name: extras.name ?? "default-name",
    displayName: extras.displayName ?? "Default Name",
    type: extras.type ?? "agent",
    avatarColorToken: extras.avatarColorToken ?? null,
    avatarImageUrl: extras.avatarImageUrl ?? null,
  };
}

function mkChatDetail(overrides?: Partial<ChatDetail>): ChatDetail {
  return {
    id: "chat-1",
    organizationId: "org-1",
    type: "group",
    topic: "v1 ship",
    description: null,
    lifecyclePolicy: null,
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    participants: [],
    title: "v1 ship",
    firstMessagePreview: null,
    engagementStatus: "active",
    viewerMembershipKind: "participant",
    ...overrides,
  };
}

describe("fetchChatContext", () => {
  it("returns a narrow ChatContext with only name/displayName/type for participants", async () => {
    const sdk = {
      getChatDetail: vi
        .fn()
        .mockResolvedValue(mkChatDetail({ description: "reviewing PR #42; CI green, awaiting approve" })),
      listChatParticipants: vi
        .fn()
        .mockResolvedValue([
          mkParticipant({ agentId: "u1", name: "alice", displayName: "Alice", type: "human" }),
          mkParticipant({ agentId: "u2", name: "bob-bot", displayName: "Bob Bot", type: "agent" }),
        ]),
    };

    const result = await fetchChatContext(sdk, "chat-1", { type: "agent", delegateMention: null });

    expect(result).toEqual({
      chatId: "chat-1",
      title: "v1 ship",
      topic: "v1 ship",
      description: "reviewing PR #42; CI green, awaiting approve",
      participants: [
        { name: "alice", displayName: "Alice", type: "human" },
        { name: "bob-bot", displayName: "Bob Bot", type: "agent" },
      ],
    });
    // detail.description maps straight through to context.description.
    expect(result.description).toBe("reviewing PR #42; CI green, awaiting approve");
    // Crucial: no internal IDs leak through.
    for (const p of result.participants) {
      // Cast to a permissive bag so we can probe forbidden keys without
      // tripping the type checker; the assertion fails the test if any of
      // these keys are present.
      const bag = p as unknown as Record<string, unknown>;
      expect(bag.agentId).toBeUndefined();
      expect(bag.role).toBeUndefined();
      expect(bag.mode).toBeUndefined();
      expect(bag.access_mode).toBeUndefined();
      expect(bag.joinedAt).toBeUndefined();
    }
  });

  it("returns title from detail.title (server-resolved) even when topic is null", async () => {
    // Real chats often have null `topic` (creator didn't set one); server's
    // `chats.title` falls back through `topic > first-message preview >
    // participant join` and is always non-empty. The agent should still
    // see a meaningful label.
    const sdk = {
      getChatDetail: vi.fn().mockResolvedValue(
        mkChatDetail({
          topic: null,
          title: "alice, bob-bot",
        }),
      ),
      listChatParticipants: vi
        .fn()
        .mockResolvedValue([mkParticipant({ name: "alice", displayName: "Alice", type: "human" })]),
    };

    const result = await fetchChatContext(sdk, "chat-1", { type: "agent", delegateMention: null });
    expect(result.title).toBe("alice, bob-bot");
    expect(result.topic).toBeNull();
  });

  it("drops participants whose `name` is null instead of falling back to displayName", async () => {
    // displayName is free text ("Alice Wong"); rendering it as `@<token>`
    // would teach the LLM an unresolvable mention. The list path filters
    // null-name rows so it stays symmetric with the resolveSelfOwner path,
    // which already hard-filters them. Defensive against future schema
    // relaxations — v1 server-side participants always have a name.
    // Build rows directly so `name: null` isn't coerced by mkParticipant's
    // `??` default.
    const sdk = {
      getChatDetail: vi.fn().mockResolvedValue(mkChatDetail()),
      listChatParticipants: vi
        .fn()
        .mockResolvedValue([
          { ...mkParticipant({ name: "alice", displayName: "Alice", type: "human" }) },
          { ...mkParticipant({ displayName: "Mystery Bot", type: "agent" }), name: null },
          { ...mkParticipant({ displayName: "Empty Name", type: "agent" }), name: "" },
        ]),
    };

    const result = await fetchChatContext(sdk, "chat-1", { type: "agent", delegateMention: null });
    expect(result.participants).toEqual([{ name: "alice", displayName: "Alice", type: "human" }]);
  });

  it("collapses any non-human participant type to 'agent' in the output", async () => {
    // The server seeds non-human participants as type='agent' (post-merge of
    // pre-existing `personal_assistant` / `autonomous_agent` types); the
    // LLM-facing chat-context contract still narrows any non-human to
    // 'agent' so the chat prompt only ever has the human/agent split.
    const sdk = {
      getChatDetail: vi.fn().mockResolvedValue(mkChatDetail()),
      listChatParticipants: vi
        .fn()
        .mockResolvedValue([
          mkParticipant({ name: "h", displayName: "Human", type: "human" }),
          mkParticipant({ name: "a1", displayName: "Auto", type: "agent" }),
          mkParticipant({ name: "a2", displayName: "Assistant", type: "agent" }),
        ]),
    };

    const result = await fetchChatContext(sdk, "chat-1", { type: "agent", delegateMention: null });

    expect(result.participants.map((p) => p.type)).toEqual(["human", "agent", "agent"]);
  });

  it("populates selfOwner from delegateMention only when self has a delegate", async () => {
    const sdk = {
      getChatDetail: vi.fn().mockResolvedValue(mkChatDetail()),
      listChatParticipants: vi
        .fn()
        .mockResolvedValue([
          mkParticipant({ agentId: "u1", name: "owner", displayName: "Owner Human", type: "human" }),
          mkParticipant({ agentId: "u2", name: "me", displayName: "Me PA", type: "agent" }),
        ]),
    };

    const result = await fetchChatContext(sdk, "chat-1", {
      type: "agent",
      delegateMention: "owner",
    });

    expect(result.selfOwner).toEqual({ name: "owner", displayName: "Owner Human" });
  });

  it("does NOT populate selfOwner for autonomous agents (no delegateMention)", async () => {
    const sdk = {
      getChatDetail: vi.fn().mockResolvedValue(mkChatDetail()),
      listChatParticipants: vi
        .fn()
        .mockResolvedValue([mkParticipant({ name: "anyone", displayName: "Anyone", type: "human" })]),
    };

    const result = await fetchChatContext(sdk, "chat-1", {
      type: "agent",
      delegateMention: null,
    });

    expect(result.selfOwner).toBeUndefined();
  });

  it("does NOT populate selfOwner for human identities", async () => {
    const sdk = {
      getChatDetail: vi.fn().mockResolvedValue(mkChatDetail()),
      listChatParticipants: vi
        .fn()
        .mockResolvedValue([mkParticipant({ name: "owner", displayName: "Owner Human", type: "human" })]),
    };

    const result = await fetchChatContext(sdk, "chat-1", {
      type: "human",
      delegateMention: "owner",
    });

    expect(result.selfOwner).toBeUndefined();
  });

  it("omits selfOwner when delegateMention points to nobody in the chat", async () => {
    const sdk = {
      getChatDetail: vi.fn().mockResolvedValue(mkChatDetail()),
      listChatParticipants: vi
        .fn()
        .mockResolvedValue([mkParticipant({ name: "stranger", displayName: "Stranger", type: "human" })]),
    };

    const result = await fetchChatContext(sdk, "chat-1", {
      type: "agent",
      delegateMention: "absent-owner",
    });

    expect(result.selfOwner).toBeUndefined();
  });

  it("propagates errors so the handler can degrade", async () => {
    const sdk = {
      getChatDetail: vi.fn().mockRejectedValue(new Error("server 500")),
      listChatParticipants: vi.fn().mockResolvedValue([]),
    };

    await expect(fetchChatContext(sdk, "chat-1", { type: "agent", delegateMention: null })).rejects.toThrow(
      /server 500/,
    );
  });
});

describe("renderChatContextSection", () => {
  it("returns null when chatContext is undefined (degradation path)", () => {
    expect(renderChatContextSection(undefined)).toBeNull();
  });

  it("renders Topic line with the raw value when topic is set (Title line de-duped against topic)", () => {
    const md = renderChatContextSection({
      chatId: "chat-1",
      title: "ship v1",
      topic: "ship v1",
      description: "cutting the v1 release; tagging today",
      participants: [
        { name: "alice", displayName: "Alice", type: "human" },
        { name: "bob-bot", displayName: "Bob Bot", type: "agent" },
      ],
    });
    expect(md).not.toBeNull();
    if (!md) return;
    expect(md).toContain("## Current Chat Context");
    expect(md).toContain("Chat ID: chat-1");
    expect(md).toContain("Topic: ship v1");
    // Description line renders the raw value when set.
    expect(md).toContain("Description: cutting the v1 release; tagging today");
    // Title is de-duped when it equals topic — the agent already knows the
    // label from the Topic line.
    expect(md).not.toMatch(/Title \(auto-derived\):/);
    expect(md).toContain("@alice (Alice, type=human)");
    expect(md).toContain("@bob-bot (Bob Bot, type=agent)");
    expect(md).not.toContain("Your owner:");
  });

  it("emits Topic: (unset) sentinel + auto-derived Title when topic is null", () => {
    // Most real chats are created without an explicit topic — server's
    // `title` falls back to first-message preview / participant join. The
    // section now always renders a Topic line so the agent can see whether
    // it should set one this turn.
    const md = renderChatContextSection({
      chatId: "chat-1",
      title: "alice, bob-bot",
      topic: null,
      description: null,
      participants: [
        { name: "alice", displayName: "Alice", type: "human" },
        { name: "bob-bot", displayName: "Bob Bot", type: "agent" },
      ],
    });
    expect(md).not.toBeNull();
    if (!md) return;
    expect(md).toContain("Topic: (unset");
    expect(md).toContain("Title (auto-derived): alice, bob-bot");
    // Description sentinel when unset.
    expect(md).toContain("Description: (unset");
  });

  it("renders Topic + auto-derived Title when topic is set but distinct from title", () => {
    // Currently impossible via server logic (title falls back to topic when
    // topic is non-null), but the render path must still be sound if the
    // two ever diverge — e.g. a stale cache or a future server change.
    const md = renderChatContextSection({
      chatId: "chat-1",
      title: "alice, bob-bot",
      topic: "Q2 launch coordination",
      description: null,
      participants: [{ name: "alice", displayName: "Alice", type: "human" }],
    });
    expect(md).not.toBeNull();
    if (!md) return;
    expect(md).toContain("Topic: Q2 launch coordination");
    expect(md).toContain("Title (auto-derived): alice, bob-bot");
  });

  it("includes 'Your owner' line only when selfOwner is set; Topic sentinel still emitted when unset", () => {
    const md = renderChatContextSection({
      chatId: "chat-1",
      title: "alice + Me PA",
      topic: null,
      description: null,
      selfOwner: { name: "owner", displayName: "Owner Human" },
      participants: [{ name: "owner", displayName: "Owner Human", type: "human" }],
    });
    expect(md).not.toBeNull();
    if (!md) return;
    expect(md).toContain("Your owner: Owner Human (@owner)");
    expect(md).toContain("Topic: (unset");
  });

  it("does NOT leak internal id / access_mode / role / mode fields", () => {
    const md = renderChatContextSection({
      chatId: "chat-1",
      title: "x",
      topic: "x",
      description: null,
      participants: [{ name: "a", displayName: "A", type: "agent" }],
    });
    expect(md).not.toBeNull();
    if (!md) return;
    expect(md.toLowerCase()).not.toContain("agentid");
    expect(md.toLowerCase()).not.toContain("access_mode");
    expect(md.toLowerCase()).not.toContain("role=");
    expect(md.toLowerCase()).not.toContain("mode=");
  });
});

describe("renderChatContextPrompt", () => {
  it("wraps Current Chat Context as runtime-authored provider/session context", () => {
    const prompt = renderChatContextPrompt({
      chatId: "chat-1",
      title: "ship v1",
      topic: "ship v1",
      description: "cutting the v1 release",
      participants: [{ name: "alice", displayName: "Alice", type: "human" }],
    });
    expect(prompt).not.toBeNull();
    if (!prompt) return;
    expect(prompt).toContain("<first-tree-current-chat-context>");
    expect(prompt).toContain("not user-authored content");
    expect(prompt).toContain("## Current Chat Context");
    expect(prompt).toContain("Chat ID: chat-1");
    expect(prompt).toContain("</first-tree-current-chat-context>");
  });
});
