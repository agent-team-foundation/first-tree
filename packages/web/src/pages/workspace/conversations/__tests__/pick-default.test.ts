import { describe, expect, it } from "vitest";
import { type PickDefaultAgent, type PickDefaultChat, pickDefault } from "../new-chat-draft.js";

/**
 * Pure-function tests for the New Chat default-chip seed (`pickDefault`).
 *
 * Locks the New Chat default-chip seed:
 *   - prefer the most recent manual 1:1 agent chat
 *   - fall back to the caller's own human agent's `delegateMention`
 *   - fall back to the caller's earliest owned active agent
 *   - null only when no safe, visible, active candidate exists
 */

const ME_HUMAN = "human-me";
const DELEGATE = "agent-delegate";
const OTHER = "agent-other";
const OWNED_FIRST = "agent-owned-first";
const OWNED_SECOND = "agent-owned-second";
const NOW = Date.parse("2026-06-26T00:00:00.000Z");

/** Build an agent slice with only the fields `pickDefault` reads. */
function agent(partial: Partial<PickDefaultAgent> & Pick<PickDefaultAgent, "uuid">): PickDefaultAgent {
  return {
    type: "agent",
    managerId: null,
    status: "active",
    delegateMention: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...partial,
  };
}

function chat(partial: Partial<PickDefaultChat> & Pick<PickDefaultChat, "chatId">): PickDefaultChat {
  return {
    source: "manual",
    membershipKind: "participant",
    canReply: true,
    lastMessageAt: "2026-06-25T00:00:00.000Z",
    participants: [
      { agentId: ME_HUMAN, type: "human" },
      { agentId: OTHER, type: "agent" },
    ],
    ...partial,
  };
}

describe("pickDefault", () => {
  it("returns null when myAgentId is null (logged-out or org not yet selected)", () => {
    const agents = [agent({ uuid: ME_HUMAN, type: "human", delegateMention: DELEGATE }), agent({ uuid: DELEGATE })];
    expect(
      pickDefault({ defaultAgents: agents, recentChats: [], myAgentId: null, myMemberId: "member-me", nowMs: NOW }),
    ).toBeNull();
  });

  it("prefers the most recent manual 1:1 agent chat over delegateMention", () => {
    const agents = [
      agent({ uuid: ME_HUMAN, type: "human", delegateMention: DELEGATE }),
      agent({ uuid: DELEGATE, type: "agent" }),
      agent({ uuid: OTHER, type: "agent" }),
    ];
    const chats = [
      chat({
        chatId: "older",
        lastMessageAt: "2026-06-20T00:00:00.000Z",
        participants: [
          { agentId: ME_HUMAN, type: "human" },
          { agentId: DELEGATE, type: "agent" },
        ],
      }),
      chat({
        chatId: "newer",
        lastMessageAt: "2026-06-25T00:00:00.000Z",
        participants: [
          { agentId: ME_HUMAN, type: "human" },
          { agentId: OTHER, type: "agent" },
        ],
      }),
    ];
    expect(
      pickDefault({
        defaultAgents: agents,
        recentChats: chats,
        myAgentId: ME_HUMAN,
        myMemberId: "member-me",
        nowMs: NOW,
      }),
    ).toBe(OTHER);
  });

  it("ignores automatic, group, stale, and unavailable recent chats before using delegateMention", () => {
    const agents = [
      agent({ uuid: ME_HUMAN, type: "human", delegateMention: DELEGATE }),
      agent({ uuid: DELEGATE, type: "agent" }),
      agent({ uuid: OTHER, type: "agent" }),
    ];
    const chats = [
      chat({ chatId: "github", source: "github" }),
      chat({
        chatId: "group",
        participants: [
          { agentId: ME_HUMAN, type: "human" },
          { agentId: OTHER, type: "agent" },
          { agentId: "agent-extra", type: "agent" },
        ],
      }),
      chat({ chatId: "stale", lastMessageAt: "2026-05-01T00:00:00.000Z" }),
      chat({
        chatId: "suspended",
        participants: [
          { agentId: ME_HUMAN, type: "human" },
          { agentId: "agent-suspended", type: "agent" },
        ],
      }),
    ];
    expect(
      pickDefault({
        defaultAgents: agents,
        recentChats: chats,
        myAgentId: ME_HUMAN,
        myMemberId: "member-me",
        nowMs: NOW,
      }),
    ).toBe(DELEGATE);
  });

  it("falls back to delegateMention when there is no valid recent manual 1:1 agent chat", () => {
    const agents = [
      agent({ uuid: ME_HUMAN, type: "human", delegateMention: DELEGATE }),
      agent({ uuid: DELEGATE, type: "agent" }),
      agent({ uuid: OTHER, type: "agent" }),
    ];
    expect(
      pickDefault({ defaultAgents: agents, recentChats: [], myAgentId: ME_HUMAN, myMemberId: "member-me", nowMs: NOW }),
    ).toBe(DELEGATE);
  });

  it("falls back to the caller's earliest owned active agent when delegate is missing or unusable", () => {
    const agents = [
      agent({ uuid: ME_HUMAN, type: "human", delegateMention: DELEGATE }),
      agent({ uuid: DELEGATE, type: "agent", status: "suspended", managerId: "other-member" }),
      agent({ uuid: OWNED_SECOND, type: "agent", managerId: "member-me", createdAt: "2026-06-02T00:00:00.000Z" }),
      agent({ uuid: OWNED_FIRST, type: "agent", managerId: "member-me", createdAt: "2026-06-01T00:00:00.000Z" }),
      agent({ uuid: OTHER, type: "agent", managerId: "other-member", createdAt: "2026-05-01T00:00:00.000Z" }),
    ];
    expect(
      pickDefault({ defaultAgents: agents, recentChats: [], myAgentId: ME_HUMAN, myMemberId: "member-me", nowMs: NOW }),
    ).toBe(OWNED_FIRST);
  });

  it("uses server-resolved default candidates instead of the org roster first page", () => {
    const agents = [
      agent({ uuid: ME_HUMAN, type: "human", delegateMention: DELEGATE }),
      agent({ uuid: OTHER, type: "agent" }),
      agent({ uuid: OWNED_FIRST, type: "agent", managerId: "member-me", createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(
      pickDefault({
        defaultAgents: agents,
        recentChats: [chat({ chatId: "recent-101-plus" })],
        myAgentId: ME_HUMAN,
        myMemberId: "member-me",
        nowMs: NOW,
      }),
    ).toBe(OTHER);
  });

  it("returns null when no safe candidate exists", () => {
    const agents = [
      agent({ uuid: ME_HUMAN, type: "human", delegateMention: null }),
      agent({ uuid: OTHER, type: "agent", managerId: "other-member" }),
    ];
    expect(
      pickDefault({ defaultAgents: agents, recentChats: [], myAgentId: ME_HUMAN, myMemberId: "member-me", nowMs: NOW }),
    ).toBeNull();
  });

  it("is stable across calls — does not depend on runtime presence", () => {
    const agents = [
      agent({ uuid: ME_HUMAN, type: "human", delegateMention: DELEGATE }),
      agent({ uuid: DELEGATE, type: "agent" }),
    ];
    const input = { defaultAgents: agents, recentChats: [], myAgentId: ME_HUMAN, myMemberId: "member-me", nowMs: NOW };
    const first = pickDefault(input);
    const second = pickDefault(input);
    expect(first).toBe(second);
    expect(first).toBe(DELEGATE);
  });
});
