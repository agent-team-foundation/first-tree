import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findImagePath, imagePath, writeImage } from "../runtime/image-store.js";

let home: string;

beforeEach(() => {
  home = join(tmpdir(), `ft-image-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  vi.stubEnv("FIRST_TREE_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("image store", () => {
  it("builds sanitized image paths", () => {
    expect(imagePath("chat-1", "image-1", "image/png")).toBe(
      join(home, "data", "chats", "chat-1", "images", "image-1.png"),
    );
    expect(imagePath("../chat", "image/1", "image/jpeg")).toBe(
      join(home, "data", "chats", "unknown", "images", "unknown.jpg"),
    );
  });

  it("writes and finds image bytes", async () => {
    const path = await writeImage({
      chatId: "chat-1",
      imageId: "image-1",
      mimeType: "image/webp",
      base64: Buffer.from("hello image").toString("base64"),
    });

    expect(path).toBe(join(home, "data", "chats", "chat-1", "images", "image-1.webp"));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("hello image");
    expect(findImagePath("chat-1", "image-1", "image/webp")).toBe(path);
  });

  it("returns null when the image has not been written locally", () => {
    expect(findImagePath("chat-1", "missing", "image/gif")).toBeNull();
  });
});
