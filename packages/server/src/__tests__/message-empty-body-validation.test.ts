import type { SendMessage } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { BadRequestError } from "../errors.js";
import { sendMessage } from "../services/message.js";

// `validateMessageContent` fires at the very top of `sendMessage`, before the
// transaction opens, so a doomed write never reaches the DB. The empty stub is
// enough — any property access would throw and surface as a test failure rather
// than a silent pass. Mirrors message-file-content-validation.test.ts.
const stubDb = {} as unknown as Database;

function message(format: SendMessage["format"], content: unknown): SendMessage {
  return { format, content, source: "web" } as SendMessage;
}

describe("sendMessage — empty / placeholder body is rejected fail-closed", () => {
  it("rejects an empty string body", async () => {
    await expect(sendMessage(stubDb, "chat-1", "sender-1", message("text", ""))).rejects.toThrow(BadRequestError);
  });

  it("rejects a whitespace-only body", async () => {
    await expect(sendMessage(stubDb, "chat-1", "sender-1", message("text", "   "))).rejects.toThrow(BadRequestError);
  });

  it("rejects a newline-only body", async () => {
    await expect(sendMessage(stubDb, "chat-1", "sender-1", message("markdown", "\n\n\t"))).rejects.toThrow(
      BadRequestError,
    );
  });

  it("rejects a body that is just a placeholder sentinel (the PLACEHOLDER incident)", async () => {
    await expect(sendMessage(stubDb, "chat-1", "sender-1", message("text", "PLACEHOLDER"))).rejects.toThrow(
      BadRequestError,
    );
  });

  it("rejects a placeholder sentinel case-insensitively, with surrounding whitespace", async () => {
    await expect(sendMessage(stubDb, "chat-1", "sender-1", message("text", "  placeholder \n"))).rejects.toThrow(
      BadRequestError,
    );
  });

  it("rejects an empty ask ('request') body — the body IS the question", async () => {
    await expect(sendMessage(stubDb, "chat-1", "sender-1", message("request", "   "))).rejects.toThrow(BadRequestError);
  });

  it("rejects a placeholder ask ('request') body", async () => {
    await expect(sendMessage(stubDb, "chat-1", "sender-1", message("request", "TODO"))).rejects.toThrow(
      BadRequestError,
    );
  });

  it("does NOT reject a body that merely contains the word placeholder", async () => {
    // A real body that mentions the sentinel must pass the content guard (it
    // then proceeds past validation and fails on the stub DB, which is NOT a
    // BadRequestError — so the content guard let it through).
    await expect(
      sendMessage(stubDb, "chat-1", "sender-1", message("text", "Replace the PLACEHOLDER token in config.")),
    ).rejects.not.toThrow(BadRequestError);
  });
});
