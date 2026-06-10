import type { AgentRuntimeConfig, AgentRuntimeConfigPayload } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import {
  buildProviderEnv,
  type ProviderBootstrapDeps,
  prepareProviderBootstrap,
} from "../handlers/provider-bootstrap.js";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import type { PredeclaredSourceRepo } from "../runtime/bootstrap.js";
import type { ChatContext } from "../runtime/chat-context.js";
import type { AgentIdentity, SessionContext, SessionMessage } from "../runtime/handler.js";
import type { FirstTreeHubSDK } from "../sdk.js";

const agent: AgentIdentity = {
  agentId: "agent-1",
  inboxId: "inbox-1",
  displayName: "Agent One",
  type: "agent",
  visibility: "organization",
  delegateMention: null,
  metadata: {},
};

function payload(overrides: Partial<AgentRuntimeConfigPayload> = {}): AgentRuntimeConfigPayload {
  const base: AgentRuntimeConfigPayload = {
    kind: "codex",
    prompt: { append: "Use repo context." },
    model: "gpt-test",
    mcpServers: [],
    env: [{ key: "USER_VAR", value: "configured", sensitive: false }],
    gitRepos: [{ url: "https://github.com/acme/repo", localPath: "repo" }],
    resourceSkills: [],
    reasoningEffort: "high",
  };
  return { ...base, ...overrides } as AgentRuntimeConfigPayload;
}

function config(runtimePayload: AgentRuntimeConfigPayload): AgentRuntimeConfig {
  return {
    agentId: agent.agentId,
    version: 7,
    payload: runtimePayload,
    updatedAt: "2026-06-10T00:00:00.000Z",
    updatedBy: "user-1",
  };
}

function makeCache(runtimePayload: AgentRuntimeConfigPayload | null): AgentConfigCache {
  const cfg = runtimePayload ? config(runtimePayload) : undefined;
  return {
    get: vi.fn(() => cfg),
    refresh: vi.fn(async () => {
      if (!cfg) throw new Error("no config");
      return cfg;
    }),
    refreshIfNewer: vi.fn(async () => {
      if (!cfg) throw new Error("no config");
      return cfg;
    }),
    updateUrls: vi.fn(),
    allReferencedUrls: vi.fn(() => new Set<string>()),
    forget: vi.fn(),
  };
}

function makeContext(
  spies: {
    log?: ReturnType<typeof vi.fn>;
    buildAgentEnv?: SessionContext["buildAgentEnv"];
    emitEvent?: SessionContext["emitEvent"];
    forwardResult?: SessionContext["forwardResult"];
    recordProviderActivity?: SessionContext["recordProviderActivity"];
    markMessagesConsumed?: SessionContext["markMessagesConsumed"];
    finishTurn?: SessionContext["finishTurn"];
    retryTurn?: SessionContext["retryTurn"];
  } = {},
): SessionContext {
  return {
    agent,
    sdk: {
      serverUrl: "http://test",
      sendMessage: vi.fn(),
    } as unknown as FirstTreeHubSDK,
    chatId: "chat-1",
    log: spies.log ?? vi.fn(),
    emitEvent: spies.emitEvent ?? vi.fn(),
    forwardResult: spies.forwardResult ?? vi.fn(async () => {}),
    recordProviderActivity: spies.recordProviderActivity ?? vi.fn(),
    markMessagesConsumed: spies.markMessagesConsumed ?? vi.fn(),
    finishTurn: spies.finishTurn ?? vi.fn(async () => {}),
    retryTurn: spies.retryTurn ?? vi.fn(),
    buildAgentEnv:
      spies.buildAgentEnv ??
      ((env) => ({
        ...env,
        FIRST_TREE_AGENT_ID: agent.agentId,
        OMIT_ME: undefined,
      })),
    formatInboundContent: vi.fn(async (message: SessionMessage) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    ),
    resolveSenderLabel: vi.fn(async (senderId: string) => senderId),
  };
}

describe("ProviderBootstrap", () => {
  it("prepares provider context and returns diagnostic bootstrap facts without session side effects", async () => {
    const runtimePayload = payload();
    const sourceRepos: PredeclaredSourceRepo[] = [
      {
        absolutePath: "/tmp/agent-home/repo",
        url: "https://github.com/acme/repo",
        branch: "main",
      },
    ];
    const chatContext = { chatId: "chat-1", participants: [] } as unknown as ChatContext;
    const sideEffects = {
      emitEvent: vi.fn(),
      forwardResult: vi.fn(async () => {}),
      recordProviderActivity: vi.fn(),
      markMessagesConsumed: vi.fn(),
      finishTurn: vi.fn(async () => {}),
      retryTurn: vi.fn(),
    };
    const sessionCtx = makeContext(sideEffects);
    const beforeBootstrap = vi.fn();
    const deps = {
      acquireAgentHome: vi.fn(() => "/tmp/agent-home"),
      fetchChatContext: vi.fn(async () => chatContext),
      prepareSourceRepos: vi.fn(async () => sourceRepos),
      materializeResourceSkills: vi.fn(async () => {}),
      buildAgentBriefing: vi.fn(() => "briefing"),
      ensureAgentBootstrap: vi.fn<ProviderBootstrapDeps["ensureAgentBootstrap"]>(() => ({
        treeDrifted: true,
        cliDrifted: false,
        bootstrapped: true,
      })),
      markWorkspaceInitComplete: vi.fn(),
    } satisfies Partial<ProviderBootstrapDeps>;

    const result = await prepareProviderBootstrap({
      workspaceRoot: "/tmp/workspaces/agent",
      sessionCtx,
      contextTreePath: "/tmp/context-tree",
      agentConfigCache: makeCache(runtimePayload),
      gitMirrorManager: null,
      agentName: "agent-one",
      payloadStrategy: "cached",
      envOptions: { trimUndefined: true },
      beforeBootstrap,
      deps,
    });

    expect(result.cwd).toBe("/tmp/agent-home");
    expect(result.payload).toBe(runtimePayload);
    expect(result.payloadResolved).toBe(true);
    expect(result.chatContext).toBe(chatContext);
    expect(result.sourceRepos).toBe(sourceRepos);
    expect(result.briefing).toBe("briefing");
    expect(result.bootstrap).toEqual({ treeDrifted: true, cliDrifted: false, bootstrapped: true });
    expect(result.env).toMatchObject({ USER_VAR: "configured", FIRST_TREE_AGENT_ID: "agent-1" });
    expect(result.env.OMIT_ME).toBeUndefined();

    expect(deps.prepareSourceRepos).toHaveBeenCalledWith(
      expect.objectContaining({ payload: runtimePayload, payloadResolved: true }),
    );
    expect(deps.materializeResourceSkills).toHaveBeenCalledWith("/tmp/agent-home", runtimePayload, sessionCtx);
    expect(deps.buildAgentBriefing).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: agent,
        payload: runtimePayload,
        chatContext,
        sourceRepos,
        contextTreePath: "/tmp/context-tree",
      }),
    );
    const bootstrapArgs = deps.ensureAgentBootstrap.mock.calls[0]?.[0];
    expect(bootstrapArgs?.currentSourceRepoNames ? [...bootstrapArgs.currentSourceRepoNames] : []).toEqual(["repo"]);
    expect(beforeBootstrap).toHaveBeenCalledWith({ cwd: "/tmp/agent-home", sessionCtx });
    expect(deps.markWorkspaceInitComplete).toHaveBeenCalledWith("/tmp/agent-home");

    expect(sideEffects.emitEvent).not.toHaveBeenCalled();
    expect(sideEffects.forwardResult).not.toHaveBeenCalled();
    expect(sideEffects.recordProviderActivity).not.toHaveBeenCalled();
    expect(sideEffects.markMessagesConsumed).not.toHaveBeenCalled();
    expect(sideEffects.finishTurn).not.toHaveBeenCalled();
    expect(sideEffects.retryTurn).not.toHaveBeenCalled();
  });

  it("uses default payloads without treating fallback source repos as authoritative", async () => {
    const fallbackPayload = payload({ gitRepos: [] });
    const log = vi.fn();
    const sessionCtx = makeContext({ log });
    const deps = {
      acquireAgentHome: vi.fn(() => "/tmp/agent-home"),
      fetchChatContext: vi.fn(async () => {
        throw new Error("chat unavailable");
      }),
      prepareSourceRepos: vi.fn(async () => []),
      materializeResourceSkills: vi.fn(async () => {}),
      buildAgentBriefing: vi.fn(() => "fallback briefing"),
      ensureAgentBootstrap: vi.fn<ProviderBootstrapDeps["ensureAgentBootstrap"]>(() => ({
        treeDrifted: false,
        cliDrifted: true,
        bootstrapped: true,
      })),
      markWorkspaceInitComplete: vi.fn(),
    } satisfies Partial<ProviderBootstrapDeps>;

    const result = await prepareProviderBootstrap({
      workspaceRoot: "/tmp/workspaces/agent",
      sessionCtx,
      contextTreePath: null,
      agentConfigCache: null,
      gitMirrorManager: null,
      agentName: null,
      payloadStrategy: "cached-or-refresh",
      defaultPayload: () => fallbackPayload,
      deps,
    });

    expect(result.payload).toBe(fallbackPayload);
    expect(result.payloadResolved).toBe(false);
    expect(result.chatContext).toBeUndefined();
    expect(log).toHaveBeenCalledWith("fetchChatContext failed: chat unavailable");
    expect(deps.prepareSourceRepos).toHaveBeenCalledWith(expect.objectContaining({ payloadResolved: false }));
    expect(deps.ensureAgentBootstrap.mock.calls[0]?.[0].currentSourceRepoNames).toBeNull();
  });

  it("builds provider env with Claude parent markers stripped when requested", () => {
    const previousClaudeCode = process.env.CLAUDECODE;
    const previousEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "nested";
    try {
      const env = buildProviderEnv(makeContext(), payload(), {
        stripClaudeCodeParentEnv: true,
        trimUndefined: true,
      });
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(env.USER_VAR).toBe("configured");
      expect(env.FIRST_TREE_AGENT_ID).toBe("agent-1");
      expect(env.OMIT_ME).toBeUndefined();
    } finally {
      if (previousClaudeCode === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = previousClaudeCode;
      if (previousEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = previousEntrypoint;
    }
  });
});
