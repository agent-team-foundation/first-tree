import { describe, expect, it } from "vitest";
import { deriveSessionName, ownedSessionPrefix } from "../handlers/claude-code-tui/tmux-session.js";

const CID = "client_abcd1234";

describe("deriveSessionName", () => {
  it("starts with the client-scoped ftth- prefix so the orphan sweep can match", () => {
    const name = deriveSessionName(CID, "agent-abc", "chat-xyz");
    expect(name.startsWith("ftth-")).toBe(true);
    expect(name.startsWith(ownedSessionPrefix(CID))).toBe(true);
  });

  it("is deterministic for the same (clientId, agentId, chatId)", () => {
    expect(deriveSessionName(CID, "agent-1", "chat-1")).toBe(deriveSessionName(CID, "agent-1", "chat-1"));
  });

  it("differs across different (agentId, chatId) pairs", () => {
    const a = deriveSessionName(CID, "agent-1", "chat-1");
    const b = deriveSessionName(CID, "agent-1", "chat-2");
    const c = deriveSessionName(CID, "agent-2", "chat-1");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it("differs across clients so one client's sweep can't match another's sessions", () => {
    const a = deriveSessionName("client_aaaa1111", "agent-1", "chat-1");
    const b = deriveSessionName("client_bbbb2222", "agent-1", "chat-1");
    expect(a).not.toBe(b);
  });

  it("strips disallowed tmux characters (. and :)", () => {
    const name = deriveSessionName(CID, "agent.with.dots", "chat:with:colons");
    expect(name).not.toMatch(/[.:]/);
  });

  it("caps the agent and chat parts at 8 chars", () => {
    const name = deriveSessionName(CID, "a".repeat(40), "b".repeat(40));
    // "ftth-" (5) + clientTag (8) + "-" + agent8 + "-" + chat8 = 31
    expect(name.length).toBe(31);
  });
});

describe("ownedSessionPrefix", () => {
  it("is the per-client scope the orphan sweep filters on (trailing client-id hex)", () => {
    expect(ownedSessionPrefix(CID)).toBe("ftth-abcd1234-");
  });

  it("differs per client so a sweep only ever matches its own sessions", () => {
    expect(ownedSessionPrefix("client_aaaa1111")).not.toBe(ownedSessionPrefix("client_bbbb2222"));
  });

  it("falls back to a placeholder tag when clientId is empty", () => {
    expect(ownedSessionPrefix("")).toBe("ftth-nocid-");
  });
});
