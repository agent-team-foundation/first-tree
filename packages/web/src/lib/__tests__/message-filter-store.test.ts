// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { loadMessageFilter, messageFilterScope, saveMessageFilter } from "../message-filter-store.js";

const STORAGE_KEY = "first-tree:chat-message-filter:v1";

beforeEach(() => {
  window.localStorage.clear();
});

describe("saveMessageFilter / loadMessageFilter", () => {
  it("round-trips the chosen agent for a scope", () => {
    saveMessageFilter("scope-1", "agent-a");
    expect(loadMessageFilter("scope-1")).toBe("agent-a");
  });

  it("returns null when nothing is stored for the scope", () => {
    expect(loadMessageFilter("missing")).toBeNull();
  });

  it("keeps scopes isolated", () => {
    saveMessageFilter("scope-1", "agent-a");
    saveMessageFilter("scope-2", "agent-b");
    expect(loadMessageFilter("scope-1")).toBe("agent-a");
    expect(loadMessageFilter("scope-2")).toBe("agent-b");
  });

  it("clears the entry when saving null", () => {
    saveMessageFilter("scope-1", "agent-a");
    saveMessageFilter("scope-1", null);
    expect(loadMessageFilter("scope-1")).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify({}));
  });

  it("survives corrupt stored JSON by starting from empty", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadMessageFilter("scope-1")).toBeNull();
    saveMessageFilter("scope-1", "agent-a");
    expect(loadMessageFilter("scope-1")).toBe("agent-a");
  });

  it("drops malformed entries while keeping valid ones", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        good: { agentId: "agent-a", updatedAt: 1 },
        "bad-shape": { agentId: 42, updatedAt: 1 },
        "bad-empty": { agentId: "", updatedAt: 1 },
      }),
    );
    expect(loadMessageFilter("good")).toBe("agent-a");
    expect(loadMessageFilter("bad-shape")).toBeNull();
    expect(loadMessageFilter("bad-empty")).toBeNull();
  });

  it("prunes the oldest entries past the retention cap", () => {
    for (let i = 0; i < 205; i++) {
      saveMessageFilter(`scope-${i}`, `agent-${i}`, i);
    }
    expect(loadMessageFilter("scope-0")).toBeNull();
    expect(loadMessageFilter("scope-4")).toBeNull();
    expect(loadMessageFilter("scope-5")).toBe("agent-5");
    expect(loadMessageFilter("scope-204")).toBe("agent-204");
  });
});

describe("messageFilterScope", () => {
  it("scopes by user and chat, with an anon fallback", () => {
    expect(messageFilterScope("user-1", "chat-1")).toBe("u:user-1:chat:chat-1");
    expect(messageFilterScope(null, "chat-1")).toBe("u:anon:chat:chat-1");
    expect(messageFilterScope("user-1", "chat-1")).not.toBe(messageFilterScope("user-2", "chat-1"));
  });
});
