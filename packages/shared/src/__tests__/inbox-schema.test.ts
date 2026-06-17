import { describe, expect, it } from "vitest";
import { INBOX_ENTRY_STATUSES, inboxEntrySchema, inboxEntryStatusSchema } from "../schemas/inbox.js";

describe("inboxEntryStatusSchema", () => {
  it("accepts only active delivery states", () => {
    expect(inboxEntryStatusSchema.options).toEqual(["pending", "delivered", "acked"]);
    expect(Object.values(INBOX_ENTRY_STATUSES)).toEqual(["pending", "delivered", "acked"]);
    expect(inboxEntryStatusSchema.safeParse("failed").success).toBe(false);
  });

  it("validates the status field on inbox entries", () => {
    const base = {
      id: 1,
      inboxId: "inbox_a",
      messageId: "msg_1",
      chatId: "chat_1",
      retryCount: 0,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      ackedAt: null,
    };

    expect(inboxEntrySchema.safeParse({ ...base, status: "pending" }).success).toBe(true);
    expect(inboxEntrySchema.safeParse({ ...base, status: "failed" }).success).toBe(false);
  });
});
