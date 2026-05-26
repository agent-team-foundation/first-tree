import { describe, expect, it } from "vitest";
import type { MessageWithDelivery } from "../../api/chats.js";
import { findGapAfterMessageId } from "../chat-gap.js";

function msg(id: string, createdAt: string): MessageWithDelivery {
  return {
    id,
    chatId: "chat-1",
    senderId: "user-1",
    format: "text",
    content: { text: id },
    metadata: {},
    inReplyTo: null,
    source: "web",
    createdAt,
  };
}

const T = (s: number) => new Date(2026, 0, 1, 0, 0, s).toISOString();

describe("findGapAfterMessageId", () => {
  it("returns null when the cache side is empty", () => {
    expect(findGapAfterMessageId([], [msg("a", T(1))])).toBeNull();
  });

  it("returns null when the server side is empty", () => {
    expect(findGapAfterMessageId([msg("a", T(1))], [])).toBeNull();
  });

  it("returns null when both sides are empty", () => {
    expect(findGapAfterMessageId([], [])).toBeNull();
  });

  it("returns null when cache and server overlap by id", () => {
    const cache = [msg("a", T(1)), msg("b", T(2)), msg("c", T(3))];
    const server = [msg("b", T(2)), msg("c", T(3)), msg("d", T(4))];
    expect(findGapAfterMessageId(cache, server)).toBeNull();
  });

  it("returns the newest cached id when strictly disjoint and server is newer", () => {
    const cache = [msg("a", T(1)), msg("b", T(2))];
    const server = [msg("c", T(3)), msg("d", T(4))];
    expect(findGapAfterMessageId(cache, server)).toBe("b");
  });

  it("picks the newest cached id by createdAt, not insertion order", () => {
    const cache = [msg("a", T(2)), msg("b", T(1))];
    const server = [msg("c", T(5))];
    expect(findGapAfterMessageId(cache, server)).toBe("a");
  });

  it("uses the oldest server message (not the first one) when checking for overlap window", () => {
    const cache = [msg("a", T(1)), msg("b", T(5))];
    const server = [msg("c", T(10)), msg("d", T(7))];
    expect(findGapAfterMessageId(cache, server)).toBe("b");
  });

  it("returns null when the server's oldest message is the same time as the cache's newest (no real gap)", () => {
    const cache = [msg("a", T(2))];
    const server = [msg("c", T(2)), msg("d", T(3))];
    expect(findGapAfterMessageId(cache, server)).toBeNull();
  });

  it("returns null in the reverse case where server is older than cache", () => {
    const cache = [msg("a", T(10))];
    const server = [msg("b", T(1)), msg("c", T(2))];
    expect(findGapAfterMessageId(cache, server)).toBeNull();
  });
});
