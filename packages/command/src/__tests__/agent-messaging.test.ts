import { describe, expect, it } from "vitest";
import { resolveReplyToFromEnv, resolveSenderName } from "../core/agent-messaging.js";

/**
 * Pins the env-based `replyTo` inference used by `chat send`. The rule has
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

/**
 * Pins sender resolution for `chat send` (and every other agent-scoped CLI
 * command) on a multi-agent client. Issue #192: when a single machine runs
 * more than one agent, the agent sub-process used to have to thread
 * `--agent <name>` into every CLI call, which trips up LLMs that don't
 * realise their own identity is already in env. The env-reverse-lookup
 * branch (axis 2) is the fix.
 */
describe("resolveSenderName", () => {
  const a1 = { agentId: "uuid-a1" };
  const a2 = { agentId: "uuid-a2" };

  it("'none' when no agents are configured locally", () => {
    expect(resolveSenderName({ agents: new Map() })).toEqual({ kind: "none" });
  });

  it("'ok' from --agent override even when env disagrees (explicit always wins)", () => {
    const agents = new Map([
      ["a1", a1],
      ["a2", a2],
    ]);
    expect(resolveSenderName({ override: "a2", envAgentId: "uuid-a1", agents })).toEqual({ kind: "ok", name: "a2" });
  });

  it("'ok' by reverse-looking FIRST_TREE_HUB_AGENT_ID against the local agents map", () => {
    // The fix for #192 — multi-agent client + agent-process env should NOT
    // require the caller to repeat --agent.
    const agents = new Map([
      ["architect", { agentId: "uuid-architect" }],
      ["developer", { agentId: "uuid-developer" }],
    ]);
    expect(resolveSenderName({ envAgentId: "uuid-developer", agents })).toEqual({ kind: "ok", name: "developer" });
  });

  it("'envMismatch' when env points at a uuid not present locally (stale or unconfigured)", () => {
    const agents = new Map([
      ["a1", a1],
      ["a2", a2],
    ]);
    const result = resolveSenderName({ envAgentId: "uuid-stranger", agents });
    expect(result).toEqual({ kind: "envMismatch", envAgentId: "uuid-stranger", available: ["a1", "a2"] });
  });

  it("'ok' single-agent shortcut when there's exactly one configured agent and no env hint", () => {
    expect(resolveSenderName({ agents: new Map([["solo", a1]]) })).toEqual({ kind: "ok", name: "solo" });
  });

  it("'ambiguous' on multi-agent client with no override and no env hint (legacy behaviour)", () => {
    const agents = new Map([
      ["a1", a1],
      ["a2", a2],
    ]);
    expect(resolveSenderName({ agents })).toEqual({ kind: "ambiguous", available: ["a1", "a2"] });
  });
});
