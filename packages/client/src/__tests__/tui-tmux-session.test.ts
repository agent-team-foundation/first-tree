import { describe, expect, it } from "vitest";
import { deriveSessionName } from "../handlers/claude-code-tui/tmux-session.js";

describe("deriveSessionName", () => {
  it("starts with the ftth- prefix so the orphan sweep can match", () => {
    const name = deriveSessionName("agent-abc", "chat-xyz");
    expect(name.startsWith("ftth-")).toBe(true);
  });

  it("is deterministic for the same (agentId, chatId)", () => {
    expect(deriveSessionName("agent-1", "chat-1")).toBe(deriveSessionName("agent-1", "chat-1"));
  });

  it("differs across different (agentId, chatId) pairs", () => {
    const a = deriveSessionName("agent-1", "chat-1");
    const b = deriveSessionName("agent-1", "chat-2");
    const c = deriveSessionName("agent-2", "chat-1");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it("strips disallowed tmux characters (. and :)", () => {
    const name = deriveSessionName("agent.with.dots", "chat:with:colons");
    expect(name).not.toMatch(/[.:]/);
  });

  it("caps each part at 8 chars so the full name stays short", () => {
    const name = deriveSessionName("a".repeat(40), "b".repeat(40));
    // prefix "ftth-" + 8 + "-" + 8 = 22 chars
    expect(name.length).toBe(22);
  });
});
