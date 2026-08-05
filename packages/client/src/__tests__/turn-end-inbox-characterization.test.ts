/**
 * Characterization: turn-end sink + SessionManager wiring contracts that must
 * stay identical across the inert ResultSinkDeps cleanup.
 *
 * This file is intentionally dual-compatible with:
 * - PR base (ResultSinkDeps still requires sdk/agent/chatId/getTrigger)
 * - PR head (ResultSinkDeps only clearTrigger + log)
 * via a casted deps bag. Do not tighten the cast until both eras are gone.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig, SessionState } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentHandler, SessionContext } from "../runtime/handler.js";
import { createResultSink } from "../runtime/result-sink.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import { silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

type Trigger = { messageId: string; senderId: string };

type SessionManagerInternals = {
  currentTrigger: Map<string, Trigger>;
};

function internals(sm: SessionManager): SessionManagerInternals {
  return sm as unknown as SessionManagerInternals;
}

function dualCompatSinkDeps(opts: {
  clearTrigger: () => void;
  log: (msg: string) => void;
  getTrigger?: () => Trigger | null;
  sendMessage?: ReturnType<typeof vi.fn>;
}): Parameters<typeof createResultSink>[0] {
  const sendMessage = opts.sendMessage ?? vi.fn().mockResolvedValue(undefined);
  // Cast: base requires the retired enrichment fields; head ignores extras.
  return {
    clearTrigger: opts.clearTrigger,
    log: opts.log,
    getTrigger: opts.getTrigger ?? (() => null),
    sdk: { sendMessage } as unknown as FirstTreeHubSDK,
    agent: {
      agentId: "agent-me",
      inboxId: "inbox-me",
      displayName: "test-agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    chatId: "chat-1",
  } as Parameters<typeof createResultSink>[0];
}

describe("characterization — ResultSink turn-end contract", () => {
  it("clears currentTrigger exactly once for a non-empty turn, never sendMessage, logs retired", async () => {
    let trigger: Trigger | null = { messageId: "m1", senderId: "peer" };
    const clearTrigger = vi.fn(() => {
      trigger = null;
    });
    const logs: string[] = [];
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sink = createResultSink(
      dualCompatSinkDeps({
        clearTrigger,
        log: (msg) => logs.push(msg),
        getTrigger: () => trigger,
        sendMessage,
      }),
    );

    await sink("final answer");

    expect(clearTrigger).toHaveBeenCalledTimes(1);
    expect(trigger).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logs.some((m) => /retired/.test(m))).toBe(true);
    expect(logs.some((m) => /silent turn/.test(m))).toBe(false);
  });

  it("clears currentTrigger exactly once for whitespace-only turn, never sendMessage, logs silent", async () => {
    let trigger: Trigger | null = { messageId: "m2", senderId: "peer" };
    const clearTrigger = vi.fn(() => {
      trigger = null;
    });
    const logs: string[] = [];
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sink = createResultSink(
      dualCompatSinkDeps({
        clearTrigger,
        log: (msg) => logs.push(msg),
        getTrigger: () => trigger,
        sendMessage,
      }),
    );

    await sink("   \n\t  ");

    expect(clearTrigger).toHaveBeenCalledTimes(1);
    expect(trigger).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logs.some((m) => /silent turn/.test(m))).toBe(true);
    expect(logs.some((m) => /retired/.test(m))).toBe(false);
  });
});

describe("characterization — SessionManager turn-end wiring", () => {
  const sessionConfig = {
    idle_timeout: 300,
    max_sessions: 10,
    working_grace_seconds: 3600,
    reconcile_interval_seconds: 300,
  };

  function handler(overrides: Partial<AgentHandler> = {}): AgentHandler {
    return {
      start: vi.fn().mockResolvedValue("session-id"),
      resume: vi.fn().mockResolvedValue("session-id"),
      inject: vi.fn().mockReturnValue({ kind: "owned", mode: "queued" }),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  function runtimeConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
    return {
      agentId: "agent-1",
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: "tester",
      payload: {
        kind: "claude-code",
        prompt: { append: "" },
        model: "opus",
        mcpServers: [],
        env: [],
        gitRepos: [{ url: "https://github.com/acme/project.git", localPath: "project" }],
        resourceSkills: [],
        reasoningEffort: "",
      },
      ...overrides,
    };
  }

  function makeCache(config: AgentRuntimeConfig) {
    return {
      get: vi.fn((agentId: string) => (agentId === "agent-1" ? config : undefined)),
      refreshIfNewer: vi.fn(async () => config),
      refresh: vi.fn(),
      updateSdk: vi.fn(),
      updateUrls: vi.fn(),
      allReferencedUrls: vi.fn(() => new Set<string>()),
      forget: vi.fn(),
    };
  }

  function mockSdk(): FirstTreeHubSDK {
    return {
      serverUrl: "https://first-tree.example.test",
      register: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
      getChatDetail: vi.fn().mockResolvedValue({ organizationId: "org-should-not-be-fetched-on-turn-end" }),
      listChatParticipants: vi.fn().mockResolvedValue([
        { agentId: "sender-1", role: "member", mode: "full", name: "alice", displayName: "Alice", type: "human" },
        { agentId: "agent-1", role: "member", mode: "full", name: "helper", displayName: "Helper", type: "agent" },
      ]),
    } as unknown as FirstTreeHubSDK;
  }

  const managers: SessionManager[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    while (managers.length > 0) {
      const sm = managers.pop();
      if (sm) await sm.shutdown();
    }
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("sets trigger on dispatch, clears it via forwardResult without retired lookup paths, keeps FIRST_TREE_DOC_*", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ft-turn-end-char-"));
    roots.push(workspaceRoot);
    const sdk = mockSdk();
    const config = runtimeConfig();
    const cache = makeCache(config);
    let captured: SessionContext | undefined;
    const sm = new SessionManager({
      session: sessionConfig,
      concurrency: 5,
      handlerFactory: () =>
        handler({
          async start(_message, ctx) {
            captured = ctx;
            return "char-session";
          },
        }),
      handlerConfig: { workspaceRoot },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      agentConfigCache: cache,
      ackEntry: vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
      onStateChange: (_chatId: string, _state: SessionState) => undefined,
    });
    managers.push(sm);

    const entry = mockEntry({ id: 42, chatId: "chat-char", messageId: "msg-char-1", senderId: "sender-1" });
    await sm.dispatch(entry);

    expect(captured).toBeDefined();
    const ctx = captured;
    if (!ctx) throw new Error("missing session context");

    expect(internals(sm).currentTrigger.get("chat-char")).toEqual({
      messageId: "msg-char-1",
      senderId: "sender-1",
    });

    // Reset call counts after dispatch/start so turn-end assertions are clean.
    vi.mocked(sdk.getChatDetail).mockClear();
    vi.mocked(sdk.sendMessage).mockClear();
    vi.mocked(cache.refreshIfNewer).mockClear();

    await ctx.forwardResult("characterization final text");

    expect(internals(sm).currentTrigger.has("chat-char")).toBe(false);
    expect(sdk.sendMessage).not.toHaveBeenCalled();
    expect(sdk.getChatDetail).not.toHaveBeenCalled();
    expect(cache.refreshIfNewer).not.toHaveBeenCalled();

    const env = ctx.buildAgentEnv({ PATH: "/usr/bin" });
    expect(env.FIRST_TREE_DOC_BASE).toBe(join(workspaceRoot, "source-repos", "project"));
    expect(env.FIRST_TREE_DOC_AGENT_HOME).toBe(workspaceRoot);
    expect(env.FIRST_TREE_DOC_REPO_LOCAL_PATH).toBe("source-repos/project");
  });
});
