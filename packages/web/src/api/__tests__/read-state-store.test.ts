import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadStore() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  return import("../read-state-store.js");
}

describe("read-state-store", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("returns null before a chat snapshot has been stored", async () => {
    const { getReadState } = await loadStore();
    expect(await getReadState("chat-1")).toBeNull();
  });

  it("stores, replaces, and clears chat read state", async () => {
    const { clearReadState, getReadState, setReadState } = await loadStore();

    await setReadState("chat-1", "msg-bottom", "msg-tip");
    expect(await getReadState("chat-1")).toMatchObject({
      chatId: "chat-1",
      bottomVisibleMessageId: "msg-bottom",
      latestKnownMessageId: "msg-tip",
    });

    await setReadState("chat-1", "msg-new-bottom", "msg-new-tip");
    expect(await getReadState("chat-1")).toMatchObject({
      chatId: "chat-1",
      bottomVisibleMessageId: "msg-new-bottom",
      latestKnownMessageId: "msg-new-tip",
    });

    await clearReadState("chat-1");
    expect(await getReadState("chat-1")).toBeNull();
  });

  it("scopes read state by chat id", async () => {
    const { getReadState, setReadState } = await loadStore();

    await setReadState("chat-1", "chat-1-bottom", "chat-1-tip");
    await setReadState("chat-2", "chat-2-bottom", "chat-2-tip");

    expect(await getReadState("chat-1")).toMatchObject({
      bottomVisibleMessageId: "chat-1-bottom",
      latestKnownMessageId: "chat-1-tip",
    });
    expect(await getReadState("chat-2")).toMatchObject({
      bottomVisibleMessageId: "chat-2-bottom",
      latestKnownMessageId: "chat-2-tip",
    });
  });

  it("silently no-ops when IndexedDB is unavailable", async () => {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, "indexedDB");
    const { clearReadState, getReadState, setReadState } = await import("../read-state-store.js");

    await setReadState("chat-1", "bottom", "tip");
    await clearReadState("chat-1");
    expect(await getReadState("chat-1")).toBeNull();
  });
});
