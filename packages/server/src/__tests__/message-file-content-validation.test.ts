import { MAX_BATCH_ATTACHMENTS, type SendMessage } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { BadRequestError } from "../errors.js";
import { sendMessage } from "../services/message.js";

// `validateFileContent` fires at the very top of `sendMessage`, before the
// transaction opens, so a doomed `format: "file"` write never reaches the DB.
// This empty stub is enough — any property access would throw and surface as a
// test failure rather than a silent pass.
const stubDb = {} as unknown as Database;

const VALID_REF = {
  imageId: "11111111-1111-4111-8111-111111111111",
  mimeType: "image/png" as const,
  filename: "p.png",
};

function fileMessage(content: unknown): SendMessage {
  return { format: "file", content, source: "web" } as SendMessage;
}

describe("sendMessage — file content validation is fail-closed", () => {
  it("rejects an over-limit batch (> MAX_BATCH_ATTACHMENTS) before touching the DB", async () => {
    const attachments = Array.from({ length: MAX_BATCH_ATTACHMENTS + 1 }, (_, i) => ({
      ...VALID_REF,
      filename: `p${i}.png`,
    }));
    await expect(sendMessage(stubDb, "chat-1", "sender-1", fileMessage({ caption: "x", attachments }))).rejects.toThrow(
      BadRequestError,
    );
  });

  it("rejects a malformed batch (bad attachment entry)", async () => {
    await expect(
      sendMessage(stubDb, "chat-1", "sender-1", fileMessage({ attachments: [{ imageId: "not-a-uuid" }] })),
    ).rejects.toThrow(BadRequestError);
  });

  it("rejects an unsupported MIME type", async () => {
    await expect(
      sendMessage(stubDb, "chat-1", "sender-1", fileMessage({ ...VALID_REF, mimeType: "image/svg+xml" })),
    ).rejects.toThrow(BadRequestError);
  });

  it("rejects content that is neither a single ref nor a batch", async () => {
    await expect(sendMessage(stubDb, "chat-1", "sender-1", fileMessage({ foo: "bar" }))).rejects.toThrow(
      BadRequestError,
    );
  });
});
