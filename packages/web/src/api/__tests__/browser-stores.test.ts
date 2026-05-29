import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadImageStore() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  return import("../image-store.js");
}

async function loadReadStateStore() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  return import("../read-state-store.js");
}

describe("image-store", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("stores and retrieves image bytes by id", async () => {
    const { getImage, putImage } = await loadImageStore();

    await expect(putImage({ imageId: "img-1", base64: "abc123", mimeType: "image/png" })).resolves.toBeUndefined();
    await expect(getImage("img-1")).resolves.toEqual({ base64: "abc123", mimeType: "image/png" });
    await expect(getImage("missing")).resolves.toBeNull();
  });

  it("rejects writes and returns null when IndexedDB is unavailable", async () => {
    vi.resetModules();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    const { getImage, putImage } = await import("../image-store.js");

    await expect(putImage({ imageId: "img-1", base64: "abc123", mimeType: "image/png" })).rejects.toThrow(
      "Image storage unavailable",
    );
    await expect(getImage("img-1")).resolves.toBeNull();
  });
});

describe("read-state-store", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("sets, gets, overwrites, and clears a chat read state", async () => {
    const { clearReadState, getReadState, setReadState } = await loadReadStateStore();

    await expect(getReadState("chat-1")).resolves.toBeNull();
    await setReadState("chat-1", "msg-1", "msg-3");
    await expect(getReadState("chat-1")).resolves.toMatchObject({
      chatId: "chat-1",
      bottomVisibleMessageId: "msg-1",
      latestKnownMessageId: "msg-3",
    });

    await setReadState("chat-1", "msg-4", "msg-5");
    await expect(getReadState("chat-1")).resolves.toMatchObject({
      chatId: "chat-1",
      bottomVisibleMessageId: "msg-4",
      latestKnownMessageId: "msg-5",
    });

    await clearReadState("chat-1");
    await expect(getReadState("chat-1")).resolves.toBeNull();
  });

  it("silently no-ops when IndexedDB is unavailable", async () => {
    vi.resetModules();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    const { clearReadState, getReadState, setReadState } = await import("../read-state-store.js");

    await expect(setReadState("chat-1", "msg-1", "msg-2")).resolves.toBeUndefined();
    await expect(clearReadState("chat-1")).resolves.toBeUndefined();
    await expect(getReadState("chat-1")).resolves.toBeNull();
  });
});
