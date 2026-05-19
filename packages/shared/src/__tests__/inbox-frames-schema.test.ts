import { describe, expect, it } from "vitest";
import { inboxAckFrameSchema, inboxDeliverFrameSchema } from "../schemas/inbox-frames.js";

const baseClientMessage = {
  id: "msg_1",
  chatId: "chat_1",
  senderId: "agent_a",
  format: "text",
  content: "hello",
  metadata: {},
  replyToInbox: null,
  inReplyTo: null,
  source: null,
  createdAt: "2026-04-29T00:00:00.000Z",
  configVersion: 1,
  recipientMode: "full" as const,
  precedingMessages: [],
};

describe("inboxDeliverFrameSchema", () => {
  it("accepts a well-formed frame", () => {
    const res = inboxDeliverFrameSchema.safeParse({
      type: "inbox:deliver",
      entryId: 42,
      inboxId: "inbox_abc",
      chatId: "chat_1",
      message: baseClientMessage,
    });
    expect(res.success).toBe(true);
  });

  it("accepts a null chatId (legacy / future fan-out variants — defensive)", () => {
    const res = inboxDeliverFrameSchema.safeParse({
      type: "inbox:deliver",
      entryId: 1,
      inboxId: "inbox_abc",
      chatId: null,
      message: baseClientMessage,
    });
    expect(res.success).toBe(true);
  });

  it("rejects negative entryId", () => {
    const res = inboxDeliverFrameSchema.safeParse({
      type: "inbox:deliver",
      entryId: -1,
      inboxId: "inbox_abc",
      chatId: "chat_1",
      message: baseClientMessage,
    });
    expect(res.success).toBe(false);
  });

  it("rejects empty inboxId", () => {
    const res = inboxDeliverFrameSchema.safeParse({
      type: "inbox:deliver",
      entryId: 1,
      inboxId: "",
      chatId: "chat_1",
      message: baseClientMessage,
    });
    expect(res.success).toBe(false);
  });

  it("forwards unknown fields so a newer server can extend the frame", () => {
    const res = inboxDeliverFrameSchema.safeParse({
      type: "inbox:deliver",
      entryId: 1,
      inboxId: "inbox_abc",
      chatId: "chat_1",
      message: baseClientMessage,
      hint: "future-only-field",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect((res.data as { hint?: string }).hint).toBe("future-only-field");
    }
  });
});

describe("inboxAckFrameSchema", () => {
  it("accepts a valid ack", () => {
    const res = inboxAckFrameSchema.safeParse({ type: "inbox:ack", entryId: 7 });
    expect(res.success).toBe(true);
  });

  it("rejects wrong discriminator", () => {
    const res = inboxAckFrameSchema.safeParse({ type: "inbox:deliver", entryId: 7 });
    expect(res.success).toBe(false);
  });

  it("rejects negative entryId", () => {
    const res = inboxAckFrameSchema.safeParse({ type: "inbox:ack", entryId: -1 });
    expect(res.success).toBe(false);
  });

  it("rejects non-integer entryId", () => {
    const res = inboxAckFrameSchema.safeParse({ type: "inbox:ack", entryId: 1.5 });
    expect(res.success).toBe(false);
  });
});
