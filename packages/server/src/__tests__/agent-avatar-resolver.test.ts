import { describe, expect, it } from "vitest";
import { agentAvatarImageUrl, resolveAvatarImageUrl } from "../services/agent.js";

describe("agentAvatarImageUrl", () => {
  it("returns null when no upload timestamp", () => {
    expect(agentAvatarImageUrl("agent-1", null)).toBeNull();
    expect(agentAvatarImageUrl("agent-1", undefined)).toBeNull();
  });

  it("returns versioned URL when upload timestamp is present", () => {
    const ts = new Date("2026-05-15T08:00:00.000Z");
    expect(agentAvatarImageUrl("agent-1", ts)).toBe(`/api/v1/agents/agent-1/avatar?v=${ts.getTime()}`);
  });
});

describe("resolveAvatarImageUrl", () => {
  const uuid = "agent-1";

  it("prefers uploaded image over GitHub URL for human agents", () => {
    const ts = new Date("2026-05-15T08:00:00.000Z");
    const result = resolveAvatarImageUrl({
      uuid,
      type: "human",
      avatarImageUpdatedAt: ts,
      userAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    });
    expect(result).toBe(`/api/v1/agents/${uuid}/avatar?v=${ts.getTime()}`);
  });

  it("falls back to GitHub URL for human agents without an uploaded image", () => {
    const githubUrl = "https://avatars.githubusercontent.com/u/1?v=4";
    const result = resolveAvatarImageUrl({
      uuid,
      type: "human",
      avatarImageUpdatedAt: null,
      userAvatarUrl: githubUrl,
    });
    expect(result).toBe(githubUrl);
  });

  it("returns null for human agents with neither upload nor GitHub URL", () => {
    expect(
      resolveAvatarImageUrl({
        uuid,
        type: "human",
        avatarImageUpdatedAt: null,
        userAvatarUrl: null,
      }),
    ).toBeNull();
  });

  it("uses uploaded image for non-human agents", () => {
    const ts = new Date("2026-05-15T08:00:00.000Z");
    const result = resolveAvatarImageUrl({
      uuid,
      type: "autonomous_agent",
      avatarImageUpdatedAt: ts,
      userAvatarUrl: null,
    });
    expect(result).toBe(`/api/v1/agents/${uuid}/avatar?v=${ts.getTime()}`);
  });

  it("ignores userAvatarUrl for non-human agents (no upload, no fallback)", () => {
    // Defensive: if a join accidentally produces a userAvatarUrl on a
    // non-human agent (shouldn't happen given members.agent_id is 1:1
    // with human agents, but the resolver is the last line of defense),
    // we must not surface it. Non-human agents only get the uploaded URL.
    const result = resolveAvatarImageUrl({
      uuid,
      type: "personal_assistant",
      avatarImageUpdatedAt: null,
      userAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    });
    expect(result).toBeNull();
  });
});
