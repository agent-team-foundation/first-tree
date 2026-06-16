import { describe, expect, it } from "vitest";
import {
  ClaudeTuiLoginRequiredError,
  deriveSessionName,
  isBypassPermissionsWarning,
  isClaudeLoginWall,
  isResumeSummaryPrompt,
  isWorkspaceTrustPrompt,
  ownedSessionPrefix,
  waitForReady,
} from "../handlers/claude-code-tui/tmux-session.js";

const CID = "client_abcd1234";

describe("deriveSessionName", () => {
  it("starts with the client-scoped ftth- prefix so the orphan sweep can match", () => {
    const name = deriveSessionName(CID, "agent-abc", "chat-xyz");
    expect(name.startsWith("ftth-")).toBe(true);
    expect(name.startsWith(ownedSessionPrefix(CID))).toBe(true);
  });

  it("is deterministic for the same (clientId, agentId, chatId)", () => {
    expect(deriveSessionName(CID, "agent-1", "chat-1")).toBe(deriveSessionName(CID, "agent-1", "chat-1"));
  });

  it("differs across different (agentId, chatId) pairs", () => {
    const a = deriveSessionName(CID, "agent-1", "chat-1");
    const b = deriveSessionName(CID, "agent-1", "chat-2");
    const c = deriveSessionName(CID, "agent-2", "chat-1");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it("differs across clients so one client's sweep can't match another's sessions", () => {
    const a = deriveSessionName("client_aaaa1111", "agent-1", "chat-1");
    const b = deriveSessionName("client_bbbb2222", "agent-1", "chat-1");
    expect(a).not.toBe(b);
  });

  it("produces a tmux-safe name (hex digest, no . or :) even from dirty ids", () => {
    const name = deriveSessionName(CID, "agent.with.dots", "chat:with:colons");
    expect(name).not.toMatch(/[.:]/);
  });

  it("does NOT alias uuidv7 agents that share a timestamp prefix", () => {
    // uuidv7 leading chars are a ms timestamp — agents created in the same
    // window share the first 8+ chars. A prefix-truncating name would collide
    // (and startClaude would kill the peer's live session); the hash must not.
    const a = "019250a1-0000-7000-8000-000000000001";
    const b = "019250a1-0000-7000-8000-000000000002";
    expect(a.slice(0, 8)).toBe(b.slice(0, 8)); // guards the premise
    expect(deriveSessionName(CID, a, "chat-1")).not.toBe(deriveSessionName(CID, b, "chat-1"));
  });

  it("keeps the name short and within the owner prefix", () => {
    const name = deriveSessionName(CID, "a".repeat(40), "b".repeat(40));
    // "ftth-" (5) + clientTag (8) + "-" (1) + 12-hex digest = 26
    expect(name.length).toBe(26);
    expect(name.startsWith(ownedSessionPrefix(CID))).toBe(true);
  });
});

describe("ownedSessionPrefix", () => {
  it("is the per-client scope the orphan sweep filters on (trailing client-id hex)", () => {
    expect(ownedSessionPrefix(CID)).toBe("ftth-abcd1234-");
  });

  it("differs per client so a sweep only ever matches its own sessions", () => {
    expect(ownedSessionPrefix("client_aaaa1111")).not.toBe(ownedSessionPrefix("client_bbbb2222"));
  });

  it("falls back to a placeholder tag when clientId is empty", () => {
    expect(ownedSessionPrefix("")).toBe("ftth-nocid-");
  });
});

describe("isWorkspaceTrustPrompt", () => {
  it("detects Claude Code's first-run workspace trust dialog", () => {
    const pane = `
 Quick safety check: Is this a project you created or one you trust?

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

    expect(isWorkspaceTrustPrompt(pane)).toBe(true);
  });

  it("does not treat the normal ready surface as a trust prompt", () => {
    const pane = `
❯ Try "edit <filepath> to..."
⏵⏵ bypass permissions on (shift+tab to cycle)
`;

    expect(isWorkspaceTrustPrompt(pane)).toBe(false);
  });
});

describe("isResumeSummaryPrompt", () => {
  it("detects Claude Code's large-session resume strategy menu", () => {
    const pane = `
This session is 2h 41m old and 119.5k tokens.
Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a summary.

 ❯ 1. Resume from summary (recommended)
   2. Resume full session as-is
   3. Don't ask me again

 Enter to confirm · Esc to cancel
`;

    expect(isResumeSummaryPrompt(pane)).toBe(true);
  });

  it("does not treat the normal ready surface as a resume menu", () => {
    const pane = `
❯ Try "edit <filepath> to..."
⏵⏵ bypass permissions on (shift+tab to cycle)
`;

    expect(isResumeSummaryPrompt(pane)).toBe(false);
  });

  it("does not trip on the trust prompt (disjoint option labels)", () => {
    const pane = `
 Quick safety check: Is this a project you created or one you trust?

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

    expect(isResumeSummaryPrompt(pane)).toBe(false);
  });
});

describe("isBypassPermissionsWarning", () => {
  it("detects the one-time bypass-permissions acceptance modal", () => {
    const pane = `
 WARNING: Claude Code running in Bypass Permissions mode

 In Bypass Permissions mode, Claude Code will not ask for your approval
 before running potentially dangerous commands.

 ❯ 1. Yes, I accept
   2. No, exit

 Enter to confirm · Esc to cancel
`;

    expect(isBypassPermissionsWarning(pane)).toBe(true);
  });

  it("does not treat the normal ready surface ('bypass permissions on') as the modal", () => {
    const pane = `
❯ Try "edit <filepath> to..."
⏵⏵ bypass permissions on (shift+tab to cycle)
`;

    expect(isBypassPermissionsWarning(pane)).toBe(false);
  });

  it("does not fire on transcript text that merely mentions bypass mode", () => {
    // Lacks the full warning title + both option labels of the live modal.
    expect(isBypassPermissionsWarning('we discussed Bypass Permissions mode and the "Yes, I accept" option')).toBe(
      false,
    );
  });
});

describe("isClaudeLoginWall", () => {
  it("detects the interactive login-method selector", () => {
    const pane = `
 Select login method:

 ❯ 1. Login with Claude account
   2. Login with Claude Console (API)
`;

    expect(isClaudeLoginWall(pane)).toBe(true);
  });

  it("does NOT fire on loose 'run /login' / OAuth transcript text (no live selector)", () => {
    // These strings routinely appear in ordinary conversation; a false positive
    // here marks a healthy session permanent. Only the live selector counts.
    expect(isClaudeLoginWall("OAuth refresh token is no longer valid; run /login to re-authenticate")).toBe(false);
    expect(isClaudeLoginWall("Not authenticated. Please run /login and try again.")).toBe(false);
  });

  it("does not fire on the normal ready surface", () => {
    const pane = `
❯ Try "edit <filepath> to..."
⏵⏵ bypass permissions on (shift+tab to cycle)
`;

    expect(isClaudeLoginWall(pane)).toBe(false);
  });
});

describe("waitForReady ordering (transcript safety)", () => {
  // A ready pane whose visible transcript quotes EVERY modal/login string.
  const readyPaneQuotingPrompts = [
    "⏺ Recap of this chat: it mentions run /login and Select login method,",
    "  the option Login with Claude account, plus the modal title",
    "  WARNING: Claude Code running in Bypass Permissions mode with options",
    '  "Yes, I accept" / "No, exit".',
    '❯ Try "edit <filepath> to..."',
    "⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");

  it("the detectors WOULD fire on that transcript, so ready-first ordering is load-bearing", () => {
    expect(isClaudeLoginWall(readyPaneQuotingPrompts)).toBe(true);
    expect(isBypassPermissionsWarning(readyPaneQuotingPrompts)).toBe(true);
  });

  it("returns ready with no keystroke and no throw despite the quoted prompts", async () => {
    const sent: string[] = [];
    await expect(
      waitForReady({
        name: "ftth-test",
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        capture: async () => readyPaneQuotingPrompts,
        send: async (_name, key) => {
          sent.push(key);
        },
      }),
    ).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("throws ClaudeTuiLoginRequiredError on a live (non-ready) login selector", async () => {
    const loginPane =
      "\n Select login method:\n\n ❯ 1. Login with Claude account\n   2. Login with Claude Console (API)\n";
    const sent: string[] = [];
    await expect(
      waitForReady({
        name: "ftth-test",
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        capture: async () => loginPane,
        send: async (_name, key) => {
          sent.push(key);
        },
      }),
    ).rejects.toBeInstanceOf(ClaudeTuiLoginRequiredError);
    expect(sent).toEqual([]);
  });

  it("accepts a live bypass modal by sending '1' then Enter, then reaches ready", async () => {
    const modalPane = [
      " WARNING: Claude Code running in Bypass Permissions mode",
      " ❯ 1. Yes, I accept",
      "   2. No, exit",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    const readyPane = "❯ ready\n⏵⏵ bypass permissions on (shift+tab to cycle)";
    let polls = 0;
    const sent: string[] = [];
    await expect(
      waitForReady({
        name: "ftth-test",
        timeoutMs: 2_000,
        pollIntervalMs: 1,
        capture: async () => (polls++ === 0 ? modalPane : readyPane),
        send: async (_name, key) => {
          sent.push(key);
        },
      }),
    ).resolves.toBeUndefined();
    expect(sent).toEqual(["1", "Enter"]);
  });
});
