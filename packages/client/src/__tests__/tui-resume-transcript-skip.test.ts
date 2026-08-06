import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContext } from "../runtime/chat-context.js";
import type { SessionContext, SessionMessage } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const state = vi.hoisted(() => ({
  workspaceRoot: "",
  events: [] as string[],
  lastPasteOrdinal: 0,
  emittedOrdinals: new Set<number>(),
  consumed: [] as unknown[],
  chatContext: {
    chatId: "chat-tui-resume-transcript-skip",
    title: "resume transcript skip",
    topic: null,
    description: null,
    participants: [],
  } satisfies ChatContext,
}));

vi.mock("../runtime/agent-bootstrap.js", () => ({
  ensureAgentBootstrap: vi.fn(),
}));

vi.mock("../runtime/agent-briefing.js", () => ({
  buildAgentBriefing: vi.fn(() => ""),
}));

vi.mock("../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async () => state.chatContext),
}));

vi.mock("../runtime/context-tree-git-status.js", () => ({
  createContextTreeGitWriteTracker: vi.fn(() => ({})),
}));

vi.mock("../runtime/source-repos.js", () => ({
  currentSourceRepoNamesFromPayload: vi.fn(() => null),
  declaredSourceRepos: vi.fn(() => []),
}));

vi.mock("../runtime/workspace.js", () => ({
  acquireAgentHome: vi.fn(() => state.workspaceRoot),
  markWorkspaceInitComplete: vi.fn(),
}));

vi.mock("../handlers/claude-code.js", () => ({
  createToolCallProcessor: vi.fn(() => ({
    flush: vi.fn(),
    onMessage: (entry: unknown) => {
      state.consumed.push(entry);
    },
  })),
  mapMcpServers: vi.fn(() => []),
}));

vi.mock("../handlers/claude-executable.js", () => ({
  resolveClaudeCodeExecutable: vi.fn(() => ({ path: "/bin/claude-fake" })),
}));

vi.mock("../handlers/claude-code-tui/tmux-session.js", () => ({
  capturePane: vi.fn(async () => ""),
  deriveSessionName: vi.fn(() => "ftth-resume-skip-session"),
  killSession: vi.fn(async () => undefined),
  listOwnedSessions: vi.fn(async () => []),
  newSession: vi.fn(async () => undefined),
  ownedSessionPrefix: vi.fn(() => "ftth-resume-skip-"),
  pasteText: vi.fn(async (_sessionName: string, _text: string) => {
    state.events.push("paste");
    state.lastPasteOrdinal += 1;
  }),
  sendKey: vi.fn(async () => undefined),
  sessionExists: vi.fn(async () => false),
  waitForReady: vi.fn(async () => undefined),
}));

vi.mock("../handlers/claude-code-tui/transcript-tail.js", () => ({
  transcriptPathFor: vi.fn(() => "/tmp/fake-resume-transcript.jsonl"),
  TranscriptTailer: class {
    skipToEnd() {
      state.events.push("skipToEnd");
    }
    drainEntries() {
      state.events.push("drain");
      if (state.lastPasteOrdinal === 0) {
        // Simulates a resumed transcript that still holds prior-session
        // history: any pre-paste read (the old drain-based preflush) would
        // surface it — and surfacing it means replaying it into this turn.
        return [
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "HISTORY MUST NOT REPLAY" }] },
          },
        ];
      }
      const ordinal = state.lastPasteOrdinal;
      if (state.emittedOrdinals.has(ordinal)) return [];
      state.emittedOrdinals.add(ordinal);
      return [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: `reply ${ordinal}` }] },
        },
      ];
    }
  },
}));

import { createClaudeCodeTuiHandler } from "../handlers/claude-code-tui/index.js";

const AGENT_ID = "019eca71-0000-7000-8000-000000000002";
const CHAT_ID = "chat-tui-resume-transcript-skip";

function makeMessage(id: string, content: string): SessionMessage {
  return {
    id,
    chatId: CHAT_ID,
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
    inboxEntryId: Number(id.replace(/\D/g, "")),
  };
}

function makeContext(): { ctx: SessionContext; forwarded: string[] } {
  const forwarded: string[] = [];
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const plumbing = mockCtxPlumbing({ sendMessage }, CHAT_ID);
  const ctx: SessionContext = {
    agent: {
      agentId: AGENT_ID,
      inboxId: `inbox_${AGENT_ID}`,
      displayName: "tui-agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId: CHAT_ID,
    log: () => {},
    recordProviderActivity: () => {},
    emitEvent: () => {},
    ...plumbing,
    forwardResult: async (text: string) => {
      forwarded.push(text);
    },
  };
  return { ctx, forwarded };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.workspaceRoot = mkdtempSync(join(tmpdir(), "ft-tui-resume-skip-"));
  state.events.length = 0;
  state.lastPasteOrdinal = 0;
  state.emittedOrdinals.clear();
  state.consumed.length = 0;
});

afterEach(() => {
  rmSync(state.workspaceRoot, { recursive: true, force: true });
});

describe("claude-code-tui resume transcript skip", () => {
  it("skips (never reads) transcript history before the first paste on resume", async () => {
    const handler = createClaudeCodeTuiHandler({ workspaceRoot: state.workspaceRoot, clientId: "client-test" });
    const { ctx, forwarded } = makeContext();
    const resumed = makeMessage("m1", "resumed turn");

    await handler.resume(resumed, "existing-session-id", ctx);

    // The pre-turn flush must be the metadata-only skip: skipToEnd runs
    // before the first paste, and nothing drains (reads) before it.
    const firstPaste = state.events.indexOf("paste");
    expect(firstPaste).toBeGreaterThan(-1);
    const beforePaste = state.events.slice(0, firstPaste);
    expect(beforePaste).toContain("skipToEnd");
    expect(beforePaste).not.toContain("drain");

    // Prior-session history never reaches the turn consumers: neither the
    // per-turn processor nor the forwarded final text may see it.
    expect(JSON.stringify(state.consumed)).not.toContain("HISTORY MUST NOT REPLAY");
    expect(forwarded.join("\n")).not.toContain("HISTORY MUST NOT REPLAY");
    expect(forwarded.join("\n")).toContain("reply 1");

    await handler.shutdown();
  }, 15_000);
});
