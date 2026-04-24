import { describe, expect, it } from "vitest";
import { resolveReplyToFromEnv } from "../core/agent-messaging.js";

/**
 * Pins the env-based `replyTo` inference used by `agent send`. The rule has
 * three axes (env complete? override present? explicit vs fallback?) — each
 * test pins one. See proposals/hub-agent-messaging-reply-and-mentions §3.2.
 */
describe("resolveReplyToFromEnv", () => {
  it("returns both fields undefined when the env is empty (bare script usage)", () => {
    expect(resolveReplyToFromEnv({}, {})).toEqual({ replyToInbox: undefined, replyToChat: undefined });
  });

  it("fills both fields from env when FIRST_TREE_HUB_CHAT_ID + _INBOX_ID are present", () => {
    const out = resolveReplyToFromEnv({ FIRST_TREE_HUB_CHAT_ID: "c1", FIRST_TREE_HUB_INBOX_ID: "inbox-b1" }, {});
    expect(out).toEqual({ replyToInbox: "inbox-b1", replyToChat: "c1" });
  });

  it("returns undefined when only CHAT_ID is set (incomplete env — envelope would be half-filled)", () => {
    const out = resolveReplyToFromEnv({ FIRST_TREE_HUB_CHAT_ID: "c1" }, {});
    expect(out).toEqual({ replyToInbox: undefined, replyToChat: undefined });
  });

  it("returns undefined when only INBOX_ID is set", () => {
    const out = resolveReplyToFromEnv({ FIRST_TREE_HUB_INBOX_ID: "inbox-b1" }, {});
    expect(out).toEqual({ replyToInbox: undefined, replyToChat: undefined });
  });

  it("explicit override wins over env defaults on both axes", () => {
    const out = resolveReplyToFromEnv(
      { FIRST_TREE_HUB_CHAT_ID: "c1", FIRST_TREE_HUB_INBOX_ID: "inbox-b1" },
      { replyToInbox: "forced-inbox", replyToChat: "forced-chat" },
    );
    expect(out).toEqual({ replyToInbox: "forced-inbox", replyToChat: "forced-chat" });
  });

  it("explicit override can win on just one axis while the other falls back to env", () => {
    const out = resolveReplyToFromEnv(
      { FIRST_TREE_HUB_CHAT_ID: "c1", FIRST_TREE_HUB_INBOX_ID: "inbox-b1" },
      { replyToChat: "forced-chat" },
    );
    // inbox still from env, chat from user.
    expect(out).toEqual({ replyToInbox: "inbox-b1", replyToChat: "forced-chat" });
  });

  it("explicit override does not conjure the other field when env is incomplete", () => {
    // User set only --reply-to-chat, env doesn't have inbox, no other source →
    // we must NOT guess an inbox.
    const out = resolveReplyToFromEnv({}, { replyToChat: "forced-chat" });
    expect(out).toEqual({ replyToInbox: undefined, replyToChat: "forced-chat" });
  });
});
