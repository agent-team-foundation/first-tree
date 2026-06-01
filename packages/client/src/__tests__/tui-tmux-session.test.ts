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

  it("produces a tmux-safe name (hex digest, no . or :) even from dirty ids", () => {
    const name = deriveSessionName(CID, "agent.with.dots", "chat:with:colons");
    expect(name).not.toMatch(/[.:]/);
  });

  it("does NOT alias uuidv7 agents that share a timestamp prefix", () => {
    // uuidv7 leading chars are a ms timestamp — agents created in the same
    // window share the first 8+ chars. A prefix-truncating name would collide
    // (and startClaude would kill the peer's live session); the hash must not.
    const a = "019250a1-0000-7000-8000-000000000001";
    const b = "019250a1-0000-7000-8000-000000000002";
    expect(a.slice(0, 8)).toBe(b.slice(0, 8)); // guards the premise
    expect(deriveSessionName(CID, a, "chat-1")).not.toBe(deriveSessionName(CID, b, "chat-1"));
  });

  it("keeps the name short and within the owner prefix", () => {
    const name = deriveSessionName(CID, "a".repeat(40), "b".repeat(40));
    // "ftth-" (5) + clientTag (8) + "-" (1) + 12-hex digest = 26
    expect(name.length).toBe(26);
    expect(name.startsWith(ownedSessionPrefix(CID))).toBe(true);
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
