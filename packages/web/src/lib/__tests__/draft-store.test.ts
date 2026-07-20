// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { scopedStorageKey } from "../browser-storage-scope.js";
import {
  chatDraftScope,
  clearDraft,
  loadDraft,
  newChatDraftScope,
  parkFailedDraftIfSwitched,
  saveDraft,
} from "../draft-store.js";

const STORAGE_KEY = scopedStorageKey("first-tree:chat-drafts:v1");

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

describe("scope helpers", () => {
  it("chatDraftScope encodes user + chat", () => {
    expect(chatDraftScope("user-1", "chat-9")).toBe("u:user-1:chat:chat-9");
  });

  it("chatDraftScope falls back to anon when no user", () => {
    expect(chatDraftScope(null, "chat-9")).toBe("u:anon:chat:chat-9");
  });

  it("newChatDraftScope encodes user + org + seed participants", () => {
    expect(newChatDraftScope("user-1", "org-7", ["a", "b"])).toBe("u:user-1:new:org-7:a,b");
  });

  it("newChatDraftScope falls back to anon / no-org / empty participants", () => {
    expect(newChatDraftScope(null, null)).toBe("u:anon:new:no-org:");
  });

  it("keeps drafts isolated per user (no cross-account leak on a shared browser)", () => {
    // User A's draft for a chat must be invisible to user B in the same chat.
    saveDraft(chatDraftScope("user-a", "chat-1"), { text: "A's secret" });
    expect(loadDraft(chatDraftScope("user-b", "chat-1"))).toBeNull();
    expect(loadDraft(chatDraftScope("user-a", "chat-1"))?.text).toBe("A's secret");

    // Same for the new-chat composer within one org.
    saveDraft(newChatDraftScope("user-a", "org-1"), { text: "A's new chat" });
    expect(loadDraft(newChatDraftScope("user-b", "org-1"))).toBeNull();
  });
});

describe("parkFailedDraftIfSwitched", () => {
  it("returns false and stores nothing when still in the originating chat", () => {
    expect(parkFailedDraftIfSwitched("user-1", "chat-a", "chat-a", "retry me")).toBe(false);
    expect(loadDraft(chatDraftScope("user-1", "chat-a"))).toBeNull();
  });

  it("does not clobber a newer draft already in the originating chat", () => {
    // User switched back to chat-a, typed a replacement, then left again before
    // the in-flight send failed — the stale rollback must not overwrite it.
    saveDraft(chatDraftScope("user-1", "chat-a"), { text: "newer draft" });
    expect(parkFailedDraftIfSwitched("user-1", "chat-a", "chat-b", "stale failed text")).toBe(true);
    expect(loadDraft(chatDraftScope("user-1", "chat-a"))?.text).toBe("newer draft");
  });

  it("parks the failed text in the originating chat when the user switched away", () => {
    // Send started in chat-a, but the user is now viewing chat-b.
    expect(parkFailedDraftIfSwitched("user-1", "chat-a", "chat-b", "retry me")).toBe(true);
    expect(loadDraft(chatDraftScope("user-1", "chat-a"))?.text).toBe("retry me");
    // The chat now in view must be left untouched (no cross-chat leak).
    expect(loadDraft(chatDraftScope("user-1", "chat-b"))).toBeNull();
  });

  it("parks nothing for an empty rollback even after a switch", () => {
    expect(parkFailedDraftIfSwitched("user-1", "chat-a", "chat-b", "   ")).toBe(true);
    expect(loadDraft(chatDraftScope("user-1", "chat-a"))).toBeNull();
  });

  it("parks under the originating user's scope only", () => {
    parkFailedDraftIfSwitched("user-1", "chat-a", "chat-b", "retry me");
    expect(loadDraft(chatDraftScope("user-2", "chat-a"))).toBeNull();
  });
});
