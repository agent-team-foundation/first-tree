import { describe, expect, it } from "vitest";
import {
  inboxAckAcceptedFrameSchema,
  inboxAckFrameSchema,
  inboxAckRejectedFrameSchema,
  inboxDeliverFrameSchema,
} from "../schemas/inbox-frames.js";

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
    // to drop the entire frame and loop on every reconnect — the next
    // `agent:bind` resets the unacked entry back to `pending` and re-pushes
    // the same frame, with the loop only breaking when the process restarts
    // (and is still the same broken build, so it would loop again), the
    // deploy ships the enum update, or operator `session:terminate` clears
    // the row. See inflight-message-recovery-design.md §4.
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

  it("accepts a confirmed ack ref", () => {
    const res = inboxAckFrameSchema.safeParse({ type: "inbox:ack", entryId: 7, ref: "ack_123" });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.ref).toBe("ack_123");
    }
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

describe("inboxAckAcceptedFrameSchema", () => {
  it("accepts an ACK confirmation", () => {
    const res = inboxAckAcceptedFrameSchema.safeParse({
      type: "inbox:ack:accepted",
      entryId: 7,
      ref: "ack_123",
      disposition: "accepted_from_pending",
      ackedCount: 2,
    });
    expect(res.success).toBe(true);
  });
});

describe("inboxAckRejectedFrameSchema", () => {
  it("accepts an ACK rejection", () => {
    const res = inboxAckRejectedFrameSchema.safeParse({
      type: "inbox:ack:rejected",
      entryId: 7,
      ref: "ack_123",
      reason: "not_found_or_not_bound",
    });
    expect(res.success).toBe(true);
  });
});
