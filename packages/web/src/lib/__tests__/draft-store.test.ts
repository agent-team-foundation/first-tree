// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import {
  blockDraftWritesForUser,
  chatDraftScope,
  clearDraft,
  clearDraftsForUser,
  loadDraft,
  newChatDraftScope,
  parkFailedDraftIfSwitched,
  saveDraft,
  unblockDraftWritesForUser,
} from "../draft-store.js";

const STORAGE_KEY = "first-tree:chat-drafts:v1";
// Draft scopes embed the server identity — see draft-store `userPrefix`.
const ORIGIN = window.location.origin;

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
  it("chatDraftScope encodes user + origin + chat", () => {
    expect(chatDraftScope("user-1", "chat-9")).toBe(`u:user-1@${ORIGIN}:chat:chat-9`);
  });

  it("chatDraftScope falls back to anon when no user", () => {
    expect(chatDraftScope(null, "chat-9")).toBe(`u:anon@${ORIGIN}:chat:chat-9`);
  });

  it("newChatDraftScope encodes user + origin + org + seed participants", () => {
    expect(newChatDraftScope("user-1", "org-7", ["a", "b"])).toBe(`u:user-1@${ORIGIN}:new:org-7:a,b`);
  });

  it("newChatDraftScope falls back to anon / no-org / empty participants", () => {
    expect(newChatDraftScope(null, null)).toBe(`u:anon@${ORIGIN}:new:no-org:`);
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

describe("clearDraftsForUser (SEC-042)", () => {
  it("removes only the target user's drafts, in both current and legacy scope formats", () => {
    saveDraft(chatDraftScope("user-a", "chat-1"), { text: "A current" });
    saveDraft(chatDraftScope("user-b", "chat-1"), { text: "B current" });
    // A pre-SEC-042 legacy-format entry for user-a, seeded raw so the
    // read-path migration cannot rewrite it before the purge runs.
    const seeded = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    seeded["u:user-a:chat:chat-9"] = { text: "A legacy", updatedAt: 1 };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));

    clearDraftsForUser("user-a");

    const after = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(after).some((k) => k.startsWith("u:user-a:") || k.startsWith("u:user-a@"))).toBe(false);
    // The other account's draft survives untouched.
    expect(loadDraft(chatDraftScope("user-b", "chat-1"))?.text).toBe("B current");
  });

  it("is a no-op for a user with no drafts", () => {
    saveDraft(chatDraftScope("user-b", "chat-1"), { text: "B" });
    clearDraftsForUser("user-a");
    expect(loadDraft(chatDraftScope("user-b", "chat-1"))?.text).toBe("B");
  });
});

describe("legacy scope migration (SEC-042)", () => {
  it("rewrites u:<userId>: entries to the origin-aware format on read", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "u:user-a:chat:chat-1": { text: "legacy body", updatedAt: 7 } }),
    );

    // The migrated entry is readable through the current-format scope...
    expect(loadDraft(chatDraftScope("user-a", "chat-1"))?.text).toBe("legacy body");

    // ...and the stored map was rewritten in place: new key present, legacy gone.
    const after = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(after[`u:user-a@${ORIGIN}:chat:chat-1`]).toEqual({ text: "legacy body", updatedAt: 7 });
    expect(after["u:user-a:chat:chat-1"]).toBeUndefined();
  });

  it("migrates every user's legacy entries (they all belong to this origin)", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        "u:user-a:chat:chat-1": { text: "A", updatedAt: 1 },
        "u:user-b:chat:chat-2": { text: "B", updatedAt: 2 },
      }),
    );

    // Any read triggers the map-wide migration.
    loadDraft(chatDraftScope("user-a", "chat-1"));

    expect(loadDraft(chatDraftScope("user-a", "chat-1"))?.text).toBe("A");
    expect(loadDraft(chatDraftScope("user-b", "chat-2"))?.text).toBe("B");
    const after = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(after).every((k) => !k.startsWith("u:user-a:") && !k.startsWith("u:user-b:"))).toBe(true);
  });

  it("keeps the current-format entry when both formats exist for one scope", () => {
    saveDraft(chatDraftScope("user-a", "chat-1"), { text: "current body" }, 10);
    const seeded = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    seeded["u:user-a:chat:chat-1"] = { text: "stale legacy", updatedAt: 1 };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));

    // Idempotent: repeated reads keep returning the current entry, and the
    // legacy key never reappears.
    expect(loadDraft(chatDraftScope("user-a", "chat-1"))?.text).toBe("current body");
    expect(loadDraft(chatDraftScope("user-a", "chat-1"))?.text).toBe("current body");
    const after = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(after["u:user-a:chat:chat-1"]).toBeUndefined();
  });
});

// The write-block is module-level state and this file imports the store
// statically, so every test here uses its own user id (or unblocks before
// exiting) to keep the block from leaking into other tests.
describe("draft write-block after purge (SEC-042)", () => {
  it("drops saveDraft for a blocked user in both scope formats; other users unaffected", () => {
    blockDraftWritesForUser("blocked-user");

    saveDraft(chatDraftScope("blocked-user", "chat-1"), { text: "blocked current" });
    // Legacy-format scope of the same blocked user — also dropped.
    saveDraft("u:blocked-user:chat:chat-2", { text: "blocked legacy" });
    saveDraft(chatDraftScope("other-user", "chat-1"), { text: "other" });

    expect(loadDraft(chatDraftScope("blocked-user", "chat-1"))).toBeNull();
    expect(loadDraft(chatDraftScope("other-user", "chat-1"))?.text).toBe("other");
    const after = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(after).some((k) => k.startsWith("u:blocked-user:") || k.startsWith("u:blocked-user@"))).toBe(
      false,
    );
    unblockDraftWritesForUser("blocked-user");
  });

  it("drops parkFailedDraftIfSwitched for a blocked user", () => {
    blockDraftWritesForUser("blocked-parker");

    // Still reports "user switched" — only the parking write is dropped.
    expect(parkFailedDraftIfSwitched("blocked-parker", "chat-a", "chat-b", "retry me")).toBe(true);
    expect(loadDraft(chatDraftScope("blocked-parker", "chat-a"))).toBeNull();
    unblockDraftWritesForUser("blocked-parker");
  });

  it("re-enables writes after unblockDraftWritesForUser", () => {
    blockDraftWritesForUser("returning-user");
    saveDraft(chatDraftScope("returning-user", "chat-1"), { text: "dropped" });
    expect(loadDraft(chatDraftScope("returning-user", "chat-1"))).toBeNull();

    unblockDraftWritesForUser("returning-user");
    saveDraft(chatDraftScope("returning-user", "chat-1"), { text: "kept" });
    expect(loadDraft(chatDraftScope("returning-user", "chat-1"))?.text).toBe("kept");
  });

  it("blocks the anonymous owner via blockDraftWritesForUser(null)", () => {
    blockDraftWritesForUser(null);
    saveDraft(chatDraftScope(null, "chat-1"), { text: "anon dropped" });
    expect(loadDraft(chatDraftScope(null, "chat-1"))).toBeNull();
    // Cleanup: this file shares the module across tests.
    unblockDraftWritesForUser("anon");
  });
});
