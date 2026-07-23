// @vitest-environment happy-dom

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageWithDelivery } from "../../api/chats.js";

const DRAFTS_KEY = "first-tree:chat-drafts:v1";

function msg(id: string, chatId: string): MessageWithDelivery {
  return {
    id,
    chatId,
    senderId: "user-1",
    format: "text",
    content: { text: `secret body of ${id}` },
    metadata: {},
    inReplyTo: null,
    source: "web",
    createdAt: new Date(2026, 0, 1, 0, 0, 1).toISOString(),
  };
}

// The store modules cache their DB open across calls (module-scoped
// `dbPromise`), so give every test a fresh module graph + fresh fake IDB.
async function loadModules() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  const messageStore = await import("../../api/message-store.js");
  const readStateStore = await import("../../api/read-state-store.js");
  const imageStore = await import("../../api/image-store.js");
  const draftStore = await import("../draft-store.js");
  const { purgeLocalUserData } = await import("../purge-local-data.js");
  return { messageStore, readStateStore, imageStore, draftStore, purgeLocalUserData };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("purgeLocalUserData (SEC-042)", () => {
  it("removes cached messages, read state, images, and drafts in one sweep", async () => {
    const { messageStore, readStateStore, imageStore, draftStore, purgeLocalUserData } = await loadModules();

    // Seed every persistent store with user content, as a real session would.
    await messageStore.cacheMessages("chat-1", [msg("m1", "chat-1")]);
    await readStateStore.setReadState("chat-1", "m1", "m1");
    await imageStore.putImage({ imageId: "img-1", base64: "aGVsbG8=", mimeType: "image/png" });
    draftStore.saveDraft(draftStore.chatDraftScope("user-1", "chat-1"), { text: "unsent secret" });

    await purgeLocalUserData();

    expect(await messageStore.getCachedMessages("chat-1")).toEqual([]);
    expect(await readStateStore.getReadState("chat-1")).toBeNull();
    expect(await imageStore.getImage("img-1")).toBeNull();
    expect(draftStore.loadDraft(draftStore.chatDraftScope("user-1", "chat-1"))).toBeNull();
    expect(window.localStorage.getItem(DRAFTS_KEY)).toBeNull();
  });

  it("resolves without throwing when IndexedDB is unavailable", async () => {
    vi.resetModules();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    const { purgeLocalUserData } = await import("../purge-local-data.js");

    await expect(purgeLocalUserData()).resolves.toBeUndefined();
  });

  it("still purges IndexedDB stores when a draft was never saved", async () => {
    const { messageStore, purgeLocalUserData } = await loadModules();
    await messageStore.cacheMessages("chat-1", [msg("m1", "chat-1")]);

    await purgeLocalUserData();

    expect(await messageStore.getCachedMessages("chat-1")).toEqual([]);
  });
});
