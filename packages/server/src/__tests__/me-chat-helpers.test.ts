import { describe, expect, it, vi } from "vitest";
import { decodeCursor, encodeCursor, resolveChatTitle } from "../services/me-chat.js";

describe("me-chat encodeCursor / decodeCursor", () => {
  it("round-trips a timestamp + chat id", () => {
    const ts = new Date("2026-05-06T10:24:00.000Z");
    const cursor = encodeCursor(ts, "chat-123");
    const decoded = decodeCursor(cursor);
    expect(decoded?.activityAt?.toISOString()).toBe(ts.toISOString());
    expect(decoded?.chatId).toBe("chat-123");
  });

  it("emits a versioned payload (v2 prefix)", () => {
    const cursor = encodeCursor(new Date("2026-05-06T10:24:00.000Z"), "chat-123");
    expect(Buffer.from(cursor, "base64url").toString("utf8")).toBe("v2|2026-05-06T10:24:00.000Z|chat-123");
  });

  it("rejects an unversioned pre-PR cursor rather than reinterpreting it", () => {
    // The old shape was `<lastMessageAt>|<chatId>` (2 parts) — indistinguishable
    // from a raw activity cursor, so it MUST be rejected across the rollout, not
    // resumed from a wrong boundary.
    const legacy = Buffer.from("2026-05-06T10:24:00.000Z|chat-123", "utf8").toString("base64url");
    expect(decodeCursor(legacy)).toBeNull();
  });

  it("rejects a cursor with a different version", () => {
    const wrongVersion = Buffer.from("v1|2026-05-06T10:24:00.000Z|chat-123", "utf8").toString("base64url");
    expect(decodeCursor(wrongVersion)).toBeNull();
  });

  it("rejects a v2 cursor with an empty timestamp or chat id", () => {
    expect(decodeCursor(Buffer.from("v2||chat-no-ts", "utf8").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("v2|2026-05-06T10:24:00.000Z|", "utf8").toString("base64url"))).toBeNull();
  });

  it("returns null for malformed cursor strings", () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    // base64-decodable but no separators
    expect(decodeCursor(Buffer.from("nosep", "utf8").toString("base64url"))).toBeNull();
    // right version + shape but a bad timestamp
    expect(decodeCursor(Buffer.from("v2|not-a-date|chat", "utf8").toString("base64url"))).toBeNull();
  });

  it("returns null when base64 decoding throws", () => {
    const spy = vi.spyOn(Buffer, "from").mockImplementationOnce(() => {
      throw new Error("decode failed");
    });
    try {
      expect(decodeCursor("bad-base64")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("me-chat resolveChatTitle", () => {
  const me = "agent-self";

  it("prefers chat.topic when present", () => {
    const title = resolveChatTitle("Fix homepage", null, [], me);
    expect(title).toBe("Fix homepage");
  });

  it("uses first-message summary when topic is empty", () => {
    const title = resolveChatTitle(
      null,
      "请帮我重构这个文件",
      [
        { agentId: me, displayName: "Me", type: "human", avatarColorToken: null, avatarImageUrl: null },
        {
          agentId: "a",
          displayName: "Code Agent",
          type: "agent",
          avatarColorToken: null,
          avatarImageUrl: null,
        },
      ],
      me,
    );
    expect(title).toBe("请帮我重构这个文件");
  });

  it("topic outranks first-message summary", () => {
    const title = resolveChatTitle(
      "Manual Title",
      "请帮我重构这个文件",
      [
        {
          agentId: "a",
          displayName: "Code Agent",
          type: "agent",
          avatarColorToken: null,
          avatarImageUrl: null,
        },
      ],
      me,
    );
    expect(title).toBe("Manual Title");
  });

  it("falls back to comma-joined participant displayNames (≤3 others)", () => {
    const title = resolveChatTitle(
      null,
      null,
      [
        { agentId: me, displayName: "Me", type: "human", avatarColorToken: null, avatarImageUrl: null },
        {
          agentId: "a",
          displayName: "Code Agent",
          type: "agent",
          avatarColorToken: null,
          avatarImageUrl: null,
        },
        {
          agentId: "b",
          displayName: "Design Agent",
          type: "agent",
          avatarColorToken: null,
          avatarImageUrl: null,
        },
      ],
      me,
    );
    expect(title).toBe("Code Agent, Design Agent");
  });

  it("collapses to '+N' for 4+ other participants", () => {
    const title = resolveChatTitle(
      null,
      null,
      [
        { agentId: me, displayName: "Me", type: "human", avatarColorToken: null, avatarImageUrl: null },
        { agentId: "a", displayName: "Alice", type: "human", avatarColorToken: null, avatarImageUrl: null },
        { agentId: "b", displayName: "Bob", type: "human", avatarColorToken: null, avatarImageUrl: null },
        { agentId: "c", displayName: "Carol", type: "human", avatarColorToken: null, avatarImageUrl: null },
        { agentId: "d", displayName: "Dave", type: "human", avatarColorToken: null, avatarImageUrl: null },
      ],
      me,
    );
    expect(title).toBe("Alice, Bob +2");
  });

  it("returns a sentinel when no other participants exist", () => {
    const title = resolveChatTitle(
      null,
      null,
      [{ agentId: me, displayName: "Me", type: "human", avatarColorToken: null, avatarImageUrl: null }],
      me,
    );
    expect(title).toBe("Empty chat");
  });

  it("ignores empty topic strings (treated as falsy)", () => {
    const title = resolveChatTitle(
      "",
      null,
      [
        { agentId: me, displayName: "Me", type: "human", avatarColorToken: null, avatarImageUrl: null },
        {
          agentId: "a",
          displayName: "Code Agent",
          type: "agent",
          avatarColorToken: null,
          avatarImageUrl: null,
        },
      ],
      me,
    );
    expect(title).toBe("Code Agent");
  });
});
