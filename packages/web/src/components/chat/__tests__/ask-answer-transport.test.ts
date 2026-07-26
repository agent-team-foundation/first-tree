// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const attachmentMocks = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  uploadMimeFor: vi.fn(),
}));
const chatMocks = vi.hoisted(() => ({
  readFileAsBase64: vi.fn(),
  sendChatMessage: vi.fn(),
  sendFileMessageBatch: vi.fn(),
}));
const imageStoreMocks = vi.hoisted(() => ({ putImage: vi.fn() }));

vi.mock("../../../api/attachments.js", () => attachmentMocks);
vi.mock("../../../api/chats.js", () => chatMocks);
vi.mock("../../../api/image-store.js", () => imageStoreMocks);

import { sendAskAnswer } from "../ask-answer-transport.js";

const request = { id: "request-1", senderId: "asker-1" };

describe("sendAskAnswer", () => {
  beforeEach(() => {
    for (const mock of Object.values(attachmentMocks)) mock.mockReset();
    for (const mock of Object.values(chatMocks)) mock.mockReset();
    imageStoreMocks.putImage.mockReset();
    attachmentMocks.uploadAttachment.mockImplementation(async (file: File) => ({ id: `uploaded-${file.name}` }));
    attachmentMocks.uploadMimeFor.mockImplementation((file: File) => file.type || "application/octet-stream");
    chatMocks.readFileAsBase64.mockResolvedValue("base64-image");
    chatMocks.sendChatMessage.mockResolvedValue(undefined);
    chatMocks.sendFileMessageBatch.mockResolvedValue(undefined);
    imageStoreMocks.putImage.mockResolvedValue(undefined);
  });

  it("routes a text answer to the asker and mentions with resolving metadata", async () => {
    const document = new File(["plan"], "plan.md", { type: "text/markdown" });

    await sendAskAnswer({
      chatId: "chat-1",
      request,
      answer: {
        content: "Ship now",
        mentions: ["asker-1", "reviewer-1", "reviewer-1"],
        images: [],
        attachments: [{ file: document, kind: "document" }],
      },
    });

    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "Ship now", ["asker-1", "reviewer-1"], {
      inReplyTo: "request-1",
      resolves: { request: "request-1", kind: "answered" },
      attachments: [
        {
          attachmentId: "uploaded-plan.md",
          kind: "document",
          mimeType: "text/markdown",
          filename: "plan.md",
          size: document.size,
        },
      ],
    });
    expect(chatMocks.sendFileMessageBatch).not.toHaveBeenCalled();
  });

  it("uses file transport for image answers and keeps cache warming best-effort", async () => {
    const image = new File(["image"], "proof.png", { type: "image/png" });
    imageStoreMocks.putImage.mockRejectedValueOnce(new Error("IndexedDB unavailable"));

    await sendAskAnswer({
      chatId: "chat-1",
      request,
      answer: { content: "Evidence attached", mentions: ["reviewer-1"], images: [image] },
    });

    expect(imageStoreMocks.putImage).toHaveBeenCalledWith({
      imageId: "uploaded-proof.png",
      base64: "base64-image",
      mimeType: "image/png",
    });
    expect(chatMocks.sendFileMessageBatch).toHaveBeenCalledWith(
      "chat-1",
      {
        caption: "Evidence attached",
        attachments: [
          {
            imageId: "uploaded-proof.png",
            mimeType: "image/png",
            filename: "proof.png",
            size: image.size,
          },
        ],
      },
      { mentions: ["asker-1", "reviewer-1"] },
      { inReplyTo: "request-1", resolves: { request: "request-1", kind: "answered" } },
    );
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();
  });
});
