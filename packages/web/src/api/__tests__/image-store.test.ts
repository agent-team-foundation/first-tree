import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadStore() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  return import("../image-store.js");
}

describe("image-store", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("returns null on a cold cache", async () => {
    const { getImage } = await loadStore();
    expect(await getImage("img-1")).toBeNull();
  });

  it("persists and overwrites image bytes by image id", async () => {
    const { getImage, putImage } = await loadStore();

    await putImage({ imageId: "img-1", base64: "Zmlyc3Q=", mimeType: "image/png" });
    expect(await getImage("img-1")).toEqual({ base64: "Zmlyc3Q=", mimeType: "image/png" });

    await putImage({ imageId: "img-1", base64: "c2Vjb25k", mimeType: "image/jpeg" });
    expect(await getImage("img-1")).toEqual({ base64: "c2Vjb25k", mimeType: "image/jpeg" });
  });

  it("handles missing IndexedDB without leaking references", async () => {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, "indexedDB");
    const { getImage, putImage } = await import("../image-store.js");

    await expect(putImage({ imageId: "img-1", base64: "ZmFrZQ==", mimeType: "image/png" })).rejects.toThrow(
      "Image storage unavailable",
    );
    expect(await getImage("img-1")).toBeNull();
  });
});
