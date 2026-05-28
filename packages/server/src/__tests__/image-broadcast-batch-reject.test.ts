import { MAX_BATCH_ATTACHMENTS, type SendMessage } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { BadRequestError } from "../errors.js";
import { prepareImageOutbound } from "../services/image-broadcast.js";
import type { Notifier } from "../services/notifier.js";

// The reject path (over-limit / malformed batch) fires before any DB or
// notifier call, so these stubs are never exercised — they only satisfy the
// signature. Cast is unavoidable for a partial stub of a wide interface.
const stubDb = {} as unknown as Database;
const stubNotifier = { pushFrameToInbox: async () => 0 } as unknown as Notifier;

const VALID_INLINE = {
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
  mimeType: "image/png" as const,
  filename: "p.png",
};

function fileMessage(content: unknown): SendMessage {
  return { format: "file", content, source: "web" } as SendMessage;
}

describe("prepareImageOutbound — batch validation is fail-closed", () => {
  it("rejects an over-limit batch (> MAX_BATCH_ATTACHMENTS) instead of storing the raw payload", async () => {
    const attachments = Array.from({ length: MAX_BATCH_ATTACHMENTS + 1 }, (_, i) => ({
      ...VALID_INLINE,
      filename: `p${i}.png`,
    }));
    await expect(
      prepareImageOutbound(stubDb, stubNotifier, "chat-1", fileMessage({ caption: "x", attachments })),
    ).rejects.toThrow(BadRequestError);
  });

  it("rejects a malformed batch (bad attachment entry) the same way", async () => {
    await expect(
      prepareImageOutbound(
        stubDb,
        stubNotifier,
        "chat-1",
        fileMessage({ attachments: [{ data: "", mimeType: "image/png", filename: "x.png" }] }),
      ),
    ).rejects.toThrow(BadRequestError);
  });

  it("does NOT reject non-batch file content (no attachments array → not a batch send)", async () => {
    // A file message whose content isn't an image batch passes through
    // unchanged — the reject guard only fires when an `attachments` array
    // is present but invalid, so legitimate non-image file messages and the
    // single-image path are unaffected.
    const data = fileMessage({ somethingElse: true });
    const out = await prepareImageOutbound(stubDb, stubNotifier, "chat-1", data);
    expect(out).toBe(data);
  });
});
