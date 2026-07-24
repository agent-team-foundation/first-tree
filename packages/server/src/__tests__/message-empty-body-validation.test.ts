import type { SendMessage } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { BadRequestError } from "../errors.js";
import { preflightMessageSendIntent, type SendIntentParticipant, sendMessage } from "../services/message.js";

// `validateMessageContent` fires at the very top of `sendMessage`, before the
// transaction opens, so a doomed write never reaches the DB. The empty stub is
// enough — any property access would throw and surface as a test failure rather
// than a silent pass. Mirrors message-file-content-validation.test.ts.
const stubDb = {} as unknown as Database;

function message(format: SendMessage["format"], content: unknown): SendMessage {
  return { format, content, source: "web" } as SendMessage;
}

function messageWithAttachment(format: SendMessage["format"], content: unknown): SendMessage {
  return {
    format,
    content,
    source: "web",
    metadata: {
      attachments: [
        {
          attachmentId: "11111111-1111-4111-8111-111111111111",
          kind: "file",
          mimeType: "text/csv",
          filename: "evidence.csv",
          size: 7,
        },
      ],
    },
  } as SendMessage;
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

  it("allows an empty text body when a document attachment ref carries the content", async () => {
    // The content guard should pass and then the stub DB should fail later;
    // this proves the empty-body rejection did not fire.
    await expect(sendMessage(stubDb, "chat-1", "sender-1", messageWithAttachment("text", ""))).rejects.not.toThrow(
      BadRequestError,
    );
  });

  it("still rejects an empty ask body even when an attachment ref is present", async () => {
    await expect(sendMessage(stubDb, "chat-1", "sender-1", messageWithAttachment("request", ""))).rejects.toThrow(
      BadRequestError,
    );
  });

  it("rejects a placeholder ask ('request') body", async () => {
    await expect(sendMessage(stubDb, "chat-1", "sender-1", message("request", "TODO"))).rejects.toThrow(
      BadRequestError,
    );
  });

  it("rejects a request image batch because the question body stays textual", async () => {
    await expect(
      sendMessage(
        stubDb,
        "chat-1",
        "sender-1",
        message("request", {
          caption: "Which layout should ship?",
          attachments: [
            {
              imageId: "11111111-1111-4111-8111-111111111111",
              mimeType: "image/png",
              filename: "decision.png",
              size: 42,
            },
          ],
        }),
      ),
    ).rejects.toThrow(BadRequestError);
  });

  it("rejects request image batches regardless of caption shape", async () => {
    const attachment = {
      imageId: "11111111-1111-4111-8111-111111111111",
      mimeType: "image/png",
      filename: "decision.png",
      size: 42,
    };
    await expect(
      sendMessage(stubDb, "chat-1", "sender-1", message("request", { attachments: [attachment] })),
    ).rejects.toThrow(BadRequestError);
    await expect(
      sendMessage(stubDb, "chat-1", "sender-1", message("request", { caption: "TODO", attachments: [attachment] })),
    ).rejects.toThrow(BadRequestError);
  });

  it("accepts a textual request body with generic attachment metadata", async () => {
    await expect(
      sendMessage(stubDb, "chat-1", "sender-1", messageWithAttachment("request", "Which layout should ship?")),
    ).rejects.not.toThrow(BadRequestError);
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

// R4: an agent can double-encode its content (`JSON.stringify(body)`); the
// server unwraps it AFTER the raw-content guard, so the empty / placeholder
// body is only visible post-unwrap. `preflightMessageSendIntent` must re-check
// the unwrapped `effectiveContent` before mention normalization / persistence.
const AGENT_SENDER: SendIntentParticipant = {
  agentId: "s1",
  name: "asst",
  displayName: "Asst",
  status: "active",
  type: "agent",
};
const HUMAN_TARGET: SendIntentParticipant = {
  agentId: "p1",
  name: "peer",
  displayName: "Peer",
  status: "active",
  type: "human",
};

function preflightAgentBody(format: SendMessage["format"], content: unknown) {
  return preflightMessageSendIntent({
    chatId: "c1",
    senderId: "s1",
    senderType: "agent",
    data: { source: "api", format, content, metadata: { mentions: ["p1"] } },
    participants: [AGENT_SENDER, HUMAN_TARGET],
  });
}

describe("preflightMessageSendIntent — double-encoded body re-validated after unwrap (R4)", () => {
  it("rejects a JSON-encoded whitespace body that passes the raw guard", () => {
    // Raw content is the 6-char literal `"\n\n"` (non-empty, so the raw guard
    // lets it by); it unwraps to two newlines, which must then be rejected.
    expect(() => preflightAgentBody("text", JSON.stringify("\n\n"))).toThrow(BadRequestError);
  });

  it("rejects a JSON-encoded placeholder ask body that passes the raw guard", () => {
    expect(() => preflightAgentBody("request", JSON.stringify("TODO\n"))).toThrow(BadRequestError);
  });

  it("does NOT reject a JSON-encoded real body", () => {
    expect(() => preflightAgentBody("text", JSON.stringify("Here is the real plan.\n"))).not.toThrow(BadRequestError);
  });
});
