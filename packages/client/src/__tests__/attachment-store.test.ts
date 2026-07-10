import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentFilePath, findAttachmentFile, writeAttachmentFile } from "../runtime/attachment-store.js";

let home: string;

beforeEach(() => {
  home = join(tmpdir(), `ft-attachment-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  vi.stubEnv("FIRST_TREE_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("attachment store", () => {
  it("builds sanitized attachment paths that preserve useful extensions", () => {
    expect(attachmentFilePath("chat-1", "11111111-1111-4111-8111-111111111111", "report.pdf")).toBe(
      join(home, "data", "chats", "chat-1", "files", "11111111-1111-4111-8111-111111111111-report.pdf"),
    );
    expect(attachmentFilePath("../chat", "bad/id", "../secret.xlsx")).toBe(
      join(home, "data", "chats", "unknown", "files", "unknown-secret.xlsx"),
    );
  });

  it("preserves office extensions when truncating long filenames", () => {
    const filename = `${"quarterly_revenue_breakdown_".repeat(12)}final.xlsx`;
    const path = attachmentFilePath("chat-1", "11111111-1111-4111-8111-111111111111", filename);
    const basename = path.split("/").pop() ?? "";

    expect(basename).toMatch(/\.xlsx$/);
    expect(basename.length).toBeLessThanOrEqual("11111111-1111-4111-8111-111111111111-".length + 200);
  });

  it("writes and finds attachment bytes", async () => {
    const path = await writeAttachmentFile({
      chatId: "chat-1",
      attachmentId: "11111111-1111-4111-8111-111111111111",
      filename: "evidence.csv",
      base64: Buffer.from("a,b\n1,2").toString("base64"),
    });

    expect(path).toBe(
      join(home, "data", "chats", "chat-1", "files", "11111111-1111-4111-8111-111111111111-evidence.csv"),
    );
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("a,b\n1,2");
    expect(findAttachmentFile("chat-1", "11111111-1111-4111-8111-111111111111", "evidence.csv")).toBe(path);
  });

  it("returns null when the attachment has not been written locally", () => {
    expect(findAttachmentFile("chat-1", "22222222-2222-4222-8222-222222222222", "missing.pdf")).toBeNull();
  });
});
