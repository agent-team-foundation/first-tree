import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig, AgentRuntimeConfigPayload, RuntimeResourceSkill } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContext } from "../runtime/chat-context.js";
import type { SessionContext, SessionMessage } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

// A resource skill bound to an agent that already has a live session only lands
// on disk if the handler re-materializes it when the config version bumps —
// see maybeSwitchConfig's restart path in claude-code.ts. This exercises that
// path end-to-end against a real temp workspace (materializeResourceSkills is
// NOT mocked): the SKILL.md must appear before the injected turn runs.
const state = vi.hoisted(() => ({
  chatContextPromise: null as Promise<ChatContext> | null,
  resolveChatContext: null as ((value: ChatContext) => void) | null,
  observedInputs: [] as string[],
  pendingResults: [] as unknown[],
  waiters: [] as Array<() => void>,
}));

function wakeQuery(): void {
  const waiters = state.waiters.splice(0);
  for (const waiter of waiters) waiter();
}

function flattenContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
    let closed = false;
    void (async () => {
      for await (const sdkMsg of args.prompt) {
        state.observedInputs.push(flattenContent(sdkMsg.message.content));
        state.pendingResults.push({
          type: "result",
          subtype: "success",
          result: `reply ${state.observedInputs.length}`,
        });
        wakeQuery();
      }
      closed = true;
      wakeQuery();
    })();
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            while (state.pendingResults.length === 0 && !closed) {
              await new Promise<void>((resolve) => state.waiters.push(resolve));
            }
            const value = state.pendingResults.shift();
            if (value) return { value, done: false };
            return { value: undefined, done: true };
          },
        };
      },
      close: () => {
        closed = true;
        wakeQuery();
      },
      setModel: async () => {},
    };
  },
}));

vi.mock("../runtime/agent-bootstrap.js", () => ({ ensureAgentBootstrap: vi.fn() }));
vi.mock("../runtime/bootstrap.js", () => ({
  FIRST_TREE_RUNTIME_DIR: ".first-tree-workspace",
  FIRST_TREE_WORKSPACE_MARKER: ".first-tree-workspace",
  ensureWorkspaceRuntimeDir: vi.fn((workspacePath: string) => {
    const dir = join(workspacePath, ".first-tree-workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }),
  writeAgentBriefing: vi.fn(),
}));
vi.mock("../runtime/agent-briefing.js", () => ({ buildAgentBriefing: vi.fn(() => "") }));
vi.mock("../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async () => {
    if (!state.chatContextPromise) throw new Error("chat context gate was not initialised");
    return state.chatContextPromise;
  }),
}));
vi.mock("../runtime/source-repos.js", () => ({
  declaredSourceRepos: vi.fn(() => []),
  currentSourceRepoNamesFromPayload: vi.fn(() => null),
}));

import { createClaudeCodeHandler } from "../handlers/claude-code.js";
import { writeAgentBriefing } from "../runtime/bootstrap.js";

const AGENT_ID = "019e71d2-c9ec-7f11-86bf-5dfc9e873338";

let workspaceRoot: string;
let cachedConfig: AgentRuntimeConfig;

function makePayload(skills: RuntimeResourceSkill[]): AgentRuntimeConfigPayload {
  return {
    kind: "claude-code",
    prompt: { append: "" },
    model: "",
    mcpServers: [],
    env: [],
    gitRepos: [],
    resourceSkills: skills,
    reasoningEffort: "",
  };
}

function makeConfig(version: number, skills: RuntimeResourceSkill[]): AgentRuntimeConfig {
  return { agentId: AGENT_ID, version, payload: makePayload(skills), updatedAt: "", updatedBy: "" };
}

// Minimal cache stub: the handler only reads `.get()`. It always returns the
// current `cachedConfig`, which the test mutates to simulate a mid-session bump.
const agentConfigCache = {
  get: () => cachedConfig,
  refreshIfNewer: async () => cachedConfig,
  refresh: async () => cachedConfig,
  updateUrls: () => {},
  allReferencedUrls: () => new Set<string>(),
  forget: () => {},
};

const SCAN_SKILL: RuntimeResourceSkill = {
  resourceId: "res-scan-1",
  name: "production-scan",
  description: "Scan this repo",
  body: "SCAN RUBRIC BODY",
  metadata: {},
};

function makeMessage(id: string, content: string): SessionMessage {
  return { id, chatId: "chat-materialize", senderId: "sender-1", format: "text", content, metadata: {} };
}

function makeContext(): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: `inbox_${AGENT_ID}`,
      displayName: "reused-agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-materialize",
    log: () => {},
    recordProviderActivity: () => {},
    emitEvent: () => {},
    ...mockCtxPlumbing({ sendMessage }, "chat-materialize"),
    finishTurn: async () => {},
  };
}

function resolveChatContext(): void {
  state.resolveChatContext?.({
    chatId: "chat-materialize",
    title: "materialize",
    topic: null,
    description: null,
    participants: [],
  });
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function skillPath(resourceId: string): string {
  return join(workspaceRoot, ".first-tree", "resources", "skills", resourceId, "SKILL.md");
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-claude-materialize-"));
  state.observedInputs.length = 0;
  state.pendingResults.length = 0;
  state.waiters.length = 0;
  state.chatContextPromise = new Promise((resolve) => {
    state.resolveChatContext = resolve;
  });
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  state.chatContextPromise = null;
  state.resolveChatContext = null;
  state.pendingResults.length = 0;
  wakeQuery();
});

describe("claude-code inject-time resource-skill materialization", () => {
  it("materializes a skill bound mid-session so the injected turn finds it on disk", async () => {
    cachedConfig = makeConfig(1, []);
    const config = { workspaceRoot, agentConfigCache };
    const handler = createClaudeCodeHandler(config);
    const ctx = makeContext();

    const startPromise = handler.start(makeMessage("m1", "first"), ctx);
    resolveChatContext();
    await startPromise;
    await waitFor(() => state.observedInputs.length === 1);

    // Start ran with no skills, so nothing is on disk yet.
    expect(existsSync(skillPath(SCAN_SKILL.resourceId))).toBe(false);

    // Server binds the scan skill + bumps the config version; the cache now
    // reflects the newer version. An injected message drives the drain →
    // maybeSwitchConfig → materialize.
    cachedConfig = makeConfig(2, [SCAN_SKILL]);
    handler.inject(makeMessage("m2", "run the scan"));

    // Wait for the body to actually land — existsSync alone can race the
    // create-then-write window and observe a still-empty file.
    const target = skillPath(SCAN_SKILL.resourceId);
    await waitFor(() => existsSync(target) && readFileSync(target, "utf-8").includes("SCAN RUBRIC BODY"));
    expect(readFileSync(target, "utf-8")).toContain("SCAN RUBRIC BODY");

    await handler.shutdown();
  });

  it("does not prune a live skill when a refresh falls back to a lower-version empty config", async () => {
    cachedConfig = makeConfig(2, [SCAN_SKILL]);
    const config = { workspaceRoot, agentConfigCache };
    const handler = createClaudeCodeHandler(config);
    const ctx = makeContext();

    const startPromise = handler.start(makeMessage("m1", "first"), ctx);
    resolveChatContext();
    await startPromise;
    await waitFor(() => state.observedInputs.length === 1);
    // Start materialized the skill at version 2.
    expect(existsSync(skillPath(SCAN_SKILL.resourceId))).toBe(true);

    // A swallowed refresh failure leaves a version-0 empty fallback config.
    // maybeSwitchConfig still runs its restart path (writeAgentBriefing fires),
    // but the version guard must skip re-materialization so the empty payload
    // cannot prune the live skill.
    vi.mocked(writeAgentBriefing).mockClear();
    cachedConfig = makeConfig(0, []);
    handler.inject(makeMessage("m2", "another message"));

    await waitFor(() => vi.mocked(writeAgentBriefing).mock.calls.length >= 1);
    expect(existsSync(skillPath(SCAN_SKILL.resourceId))).toBe(true);

    await handler.shutdown();
  });
});
