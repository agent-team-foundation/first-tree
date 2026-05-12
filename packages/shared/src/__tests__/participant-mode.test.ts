import { describe, expect, it } from "vitest";
import { defaultParticipantMode } from "../participant-mode.js";

/**
 * Pinning the rule from docs/chat-participant-mode-fix-design.md §2.1 and
 * §3.5. The helper is the single authoritative encoding of the invariant
 *
 *   `(chat.type === 'group' && agent.type !== 'human') ⇒ 'mention_only'`
 *
 * plus the legacy "agent-only direct chat" anti-echo rule from migration
 * 0029. Test coverage is by chat-type × agent-type with the
 * `peerAgentTypes` dimension on the `direct` branch only.
 */

describe("defaultParticipantMode — group / thread chats", () => {
  it("humans in a group are always 'full'", () => {
    expect(defaultParticipantMode("group", "human")).toBe("full");
    // `peerAgentTypes` is ignored for groups; pass a few to prove it.
    expect(defaultParticipantMode("group", "human", ["autonomous_agent"])).toBe("full");
  });

  it("non-human agents in a group are always 'mention_only'", () => {
    expect(defaultParticipantMode("group", "autonomous_agent")).toBe("mention_only");
    expect(defaultParticipantMode("group", "personal_assistant")).toBe("mention_only");
  });

  it("threads inherit the group rule", () => {
    expect(defaultParticipantMode("thread", "autonomous_agent")).toBe("mention_only");
    expect(defaultParticipantMode("thread", "human")).toBe("full");
  });
});

describe("defaultParticipantMode — direct chats", () => {
  it("humans in a direct chat are 'full' regardless of peer", () => {
    expect(defaultParticipantMode("direct", "human", [])).toBe("full");
    expect(defaultParticipantMode("direct", "human", ["autonomous_agent"])).toBe("full");
    expect(defaultParticipantMode("direct", "human", ["human"])).toBe("full");
  });

  it("agent paired with a human is 'full' (the human still wants every reply)", () => {
    expect(defaultParticipantMode("direct", "autonomous_agent", ["human"])).toBe("full");
    expect(defaultParticipantMode("direct", "personal_assistant", ["human"])).toBe("full");
  });

  it("agent paired with another non-human is 'mention_only' (anti-echo from migration 0029)", () => {
    expect(defaultParticipantMode("direct", "autonomous_agent", ["autonomous_agent"])).toBe("mention_only");
    expect(defaultParticipantMode("direct", "autonomous_agent", ["personal_assistant"])).toBe("mention_only");
    expect(defaultParticipantMode("direct", "personal_assistant", ["autonomous_agent"])).toBe("mention_only");
  });

  it("default peer list (`[]`) treats the agent as if all peers are non-human", () => {
    // Empty array is the "no peers yet — caller doesn't care" form; the
    // safe choice is `mention_only` so a future-added non-human peer
    // doesn't have to retro-flip this row.
    expect(defaultParticipantMode("direct", "autonomous_agent")).toBe("mention_only");
  });
});

describe("defaultParticipantMode — design §3.5 matrix replay", () => {
  it("group / human + agent + agent → human='full', agents='mention_only'", () => {
    expect(defaultParticipantMode("group", "human")).toBe("full");
    expect(defaultParticipantMode("group", "autonomous_agent")).toBe("mention_only");
    expect(defaultParticipantMode("group", "autonomous_agent")).toBe("mention_only");
  });

  it("group / agent + agent + agent → all 'mention_only'", () => {
    expect(defaultParticipantMode("group", "autonomous_agent")).toBe("mention_only");
    expect(defaultParticipantMode("group", "personal_assistant")).toBe("mention_only");
    expect(defaultParticipantMode("group", "autonomous_agent")).toBe("mention_only");
  });

  it("direct / human + agent → both 'full'", () => {
    expect(defaultParticipantMode("direct", "human", ["autonomous_agent"])).toBe("full");
    expect(defaultParticipantMode("direct", "autonomous_agent", ["human"])).toBe("full");
  });

  it("direct / agent + agent → both 'mention_only'", () => {
    expect(defaultParticipantMode("direct", "autonomous_agent", ["autonomous_agent"])).toBe("mention_only");
    expect(defaultParticipantMode("direct", "autonomous_agent", ["autonomous_agent"])).toBe("mention_only");
  });
});
