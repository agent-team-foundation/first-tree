// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { clearDraft, loadDraft, newChatDraftScope, saveDraft } from "../draft-store.js";

const STORAGE_KEY = "first-tree:chat-drafts:v1";

beforeEach(() => {
  window.localStorage.clear();
});

describe("saveDraft / loadDraft", () => {
  it("round-trips body text for a chat scope", () => {
    saveDraft("chat-1", { text: "hello world" });
    expect(loadDraft("chat-1")).toEqual({ text: "hello world", participantIds: [] });
  });

  it("round-trips body text + participants for a new-chat scope", () => {
    saveDraft("new:org:", { text: "draft body", participantIds: ["a", "b"] });
    expect(loadDraft("new:org:")).toEqual({ text: "draft body", participantIds: ["a", "b"] });
  });

  it("returns null when nothing is stored for the scope", () => {
    expect(loadDraft("missing")).toBeNull();
  });

  it("keeps scopes isolated", () => {
    saveDraft("chat-1", { text: "one" });
    saveDraft("chat-2", { text: "two" });
    expect(loadDraft("chat-1")?.text).toBe("one");
    expect(loadDraft("chat-2")?.text).toBe("two");
  });

  it("treats an empty / whitespace body as no draft and removes any existing entry", () => {
    saveDraft("chat-1", { text: "something" });
    expect(loadDraft("chat-1")).not.toBeNull();
    saveDraft("chat-1", { text: "   " });
    expect(loadDraft("chat-1")).toBeNull();
  });

  it("does not store chips on their own (body-less drafts are dropped)", () => {
    saveDraft("new:org:", { text: "", participantIds: ["a", "b"] });
    expect(loadDraft("new:org:")).toBeNull();
  });

  it("normalizes an empty participant list to []", () => {
    saveDraft("new:org:", { text: "body", participantIds: [] });
    expect(loadDraft("new:org:")).toEqual({ text: "body", participantIds: [] });
  });

  it("overwrites in place on re-save", () => {
    saveDraft("chat-1", { text: "first" });
    saveDraft("chat-1", { text: "second" });
    expect(loadDraft("chat-1")?.text).toBe("second");
  });
});

describe("clearDraft", () => {
  it("removes a stored draft", () => {
    saveDraft("chat-1", { text: "bye" });
    clearDraft("chat-1");
    expect(loadDraft("chat-1")).toBeNull();
  });

  it("is a no-op for an unknown scope", () => {
    expect(() => clearDraft("nope")).not.toThrow();
  });
});

describe("pruning", () => {
  it("keeps only the newest 100 drafts by updatedAt", () => {
    // Insert 101 entries with strictly increasing timestamps; the oldest
    // (scope "draft-0") must be evicted once the cap is exceeded.
    for (let i = 0; i < 101; i++) {
      saveDraft(`draft-${i}`, { text: `body ${i}` }, 1000 + i);
    }
    expect(loadDraft("draft-0")).toBeNull();
    expect(loadDraft("draft-1")?.text).toBe("body 1");
    expect(loadDraft("draft-100")?.text).toBe("body 100");
  });
});

describe("robustness", () => {
  it("recovers from corrupt JSON in storage", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not valid json");
    expect(loadDraft("chat-1")).toBeNull();
    // A subsequent save still works (corrupt blob is replaced).
    saveDraft("chat-1", { text: "recovered" });
    expect(loadDraft("chat-1")?.text).toBe("recovered");
  });

  it("ignores malformed entries", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "chat-1": { text: 42 }, "chat-2": { text: "ok", updatedAt: 1 } }),
    );
    expect(loadDraft("chat-1")).toBeNull();
    expect(loadDraft("chat-2")?.text).toBe("ok");
  });
});

describe("newChatDraftScope", () => {
  it("encodes org + seed participants", () => {
    expect(newChatDraftScope("org-7", ["a", "b"])).toBe("new:org-7:a,b");
  });

  it("falls back to no-org and empty participants", () => {
    expect(newChatDraftScope(null)).toBe("new:no-org:");
  });
});
