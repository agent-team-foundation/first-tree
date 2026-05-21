import { describe, expect, it } from "vitest";
import { inboxAckFrameSchema, inboxDeliverFrameSchema } from "../schemas/inbox-frames.js";

const baseClientMessage = {
  id: "msg_1",
  chatId: "chat_1",
  senderId: "agent_a",
  format: "text",
  content: "hello",
  metadata: {},
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

  it("degrades an unknown message.source to null instead of rejecting the frame", () => {
    // Forward-roll defence: a server that adds a new source value (e.g.
    // PR #481 renaming `hub_ui` → `web`) would otherwise force older clients
    // to drop the entire frame, lose the message after retryCount exhausts,
    // and spam the reaper every 300s in the meantime.
    const res = inboxDeliverFrameSchema.safeParse({
      type: "inbox:deliver",
      entryId: 1,
      inboxId: "inbox_abc",
      chatId: "chat_1",
      message: { ...baseClientMessage, source: "some-future-source" },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.message.source).toBeNull();
    }
  });

  it("preserves a known message.source value through parse", () => {
    const res = inboxDeliverFrameSchema.safeParse({
      type: "inbox:deliver",
      entryId: 1,
      inboxId: "inbox_abc",
      chatId: "chat_1",
      message: { ...baseClientMessage, source: "cli" },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.message.source).toBe("cli");
    }
  });

  it("degrades a wrong-type message.source (e.g. number) to null", () => {
    // `.catch` is field-scoped, not enum-specific — anything that doesn't
    // match the nullable enum (wrong primitive type, missing field, etc.)
    // also degrades to null. Confirmed here so future maintainers don't
    // mistake the override for "tolerate unknown strings only".
    const res = inboxDeliverFrameSchema.safeParse({
      type: "inbox:deliver",
      entryId: 1,
      inboxId: "inbox_abc",
      chatId: "chat_1",
      message: { ...baseClientMessage, source: 12345 },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.message.source).toBeNull();
    }
  });

  it("still rejects the frame when a required field outside `source` is invalid", () => {
    // Defence-in-depth check: the `source` catch must not mask other parse
    // errors. If `message.id` were missing, the frame should still fail —
    // otherwise we'd silently accept truly broken frames.
    const res = inboxDeliverFrameSchema.safeParse({
      type: "inbox:deliver",
      entryId: 1,
      inboxId: "inbox_abc",
      chatId: "chat_1",
      message: { ...baseClientMessage, id: undefined },
    });
    expect(res.success).toBe(false);
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
