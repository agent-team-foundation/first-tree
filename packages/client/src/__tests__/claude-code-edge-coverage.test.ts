import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload, SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueryArgs = {
  prompt: AsyncIterable<unknown>;
  options?: Record<string, unknown>;
};

type FakeQuery = AsyncIterable<unknown> & {
  close: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
};

const capturedCalls: QueryArgs[] = [];
const fakeQueries: FakeQuery[] = [];
let nextCloseThrows = false;
let nextSetModelRejectsWith: unknown = null;
let nextQueryFactoryThrows = false;
let queryCallCount = 0;
let throwOnQueryCall: number | null = null;
const queuedQueryStreams: Array<Array<{ kind: "value"; value: unknown } | { kind: "throw"; error: unknown }>> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  function makeFakeQuery(): FakeQuery {
    const stream = queuedQueryStreams.shift() ?? [];
    let step = 0;
    const query: FakeQuery = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            const item = stream[step];
            step += 1;
            if (!item) return { done: true, value: undefined };
            if (item.kind === "throw") throw item.error;
            return { done: false, value: item.value };
          },
        };
      },
      close: vi.fn(() => {
        if (nextCloseThrows) {
          nextCloseThrows = false;
          throw new Error("close failed");
        }
      }),
      setModel: vi.fn(async () => {
        if (nextSetModelRejectsWith !== null) {
          const err = nextSetModelRejectsWith;
          nextSetModelRejectsWith = null;
          throw err;
        }
      }),
    };
    fakeQueries.push(query);
    return query;
  }

  return {
    query: (args: QueryArgs) => {
      queryCallCount += 1;
      if (nextQueryFactoryThrows || throwOnQueryCall === queryCallCount) {
        nextQueryFactoryThrows = false;
        throwOnQueryCall = null;
        throw new Error("query build failed");
      }
      capturedCalls.push(args);
      return makeFakeQuery();
    },
  };
});

import * as claudeCodeModule from "../handlers/claude-code.js";
import { createClaudeCodeHandler, createToolCallProcessor, StreamApiTransientError } from "../handlers/claude-code.js";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import type { GitMirrorManager } from "../runtime/git-mirror-manager.js";
import type { AgentIdentity, SessionContext, SessionMessage } from "../runtime/handler.js";
import { writeImage } from "../runtime/image-store.js";
import { mockCtxPlumbing } from "./test-helpers.js";

type ClaudeCoverageHelpers = {
  isImageRefContent(content: unknown): boolean;
  isLegacyImageFileContent(content: unknown): boolean;
  sanitizeChatId(chatId: string): string;
  writeLegacyImageToTempFile(
    content: {
      data: string;
      mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
      filename: string;
    },
    chatId: string,
  ): Promise<string>;
  generateStableClaudeMd(workspacePath: string, identity: AgentIdentity, contextTreePath: string | null): void;
};

const helpers = (claudeCodeModule as unknown as { __coverage: ClaudeCoverageHelpers }).__coverage;

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430d7";

let workspaceRoot: string;
let home: string;

const basePayload: AgentRuntimeConfigPayload = {
  kind: "claude-code",
  prompt: { append: "" },
  model: "",
  mcpServers: [],
  env: [],
  gitRepos: [],
};

beforeEach(() => {
  capturedCalls.length = 0;
  fakeQueries.length = 0;
  nextCloseThrows = false;
  nextSetModelRejectsWith = null;
  nextQueryFactoryThrows = false;
  queryCallCount = 0;
  throwOnQueryCall = null;
  queuedQueryStreams.length = 0;
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-claude-edge-workspace-"));
  home = mkdtempSync(join(tmpdir(), "ftt-claude-edge-home-"));
  vi.stubEnv("FIRST_TREE_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function makeCache(payloadRef: { current: AgentRuntimeConfigPayload; version: number }): AgentConfigCache {
  return {
    get: () => ({
      agentId: AGENT_ID,
      version: payloadRef.version,
      payload: payloadRef.current,
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    }),
  } as unknown as AgentConfigCache;
}

function makeGitMirrorManager(): GitMirrorManager {
  return {
    ensureMirror: vi.fn(async () => ({ cloned: true, elapsedMs: 7 })),
    fetchMirror: vi.fn(async () => {}),
    createWorktree: vi.fn(async () => ({ branchName: "hub-session-agent-repo", headCommit: "abc123" })),
    removeWorktree: vi.fn(async () => {}),
  } as unknown as GitMirrorManager;
}

function makeSessionCtx(chatId: string, overrides: Partial<SessionContext> = {}): SessionContext {
  const sendMessage = vi.fn(async () => undefined);
  const logs: string[] = [];
  const emitted: SessionEvent[] = [];
  const sdk = {
    serverUrl: "http://test",
    sendMessage,
    getChatDetail: async () => ({ id: chatId, title: "Design chat", topic: "Runtime planning" }),
    listChatParticipants: async () => [
      { name: "alice", displayName: "Alice", type: "human" },
      { name: "agent-peer", displayName: "Agent Peer", type: "agent" },
    ],
  } as unknown as SessionContext["sdk"];

  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: "inbox-test",
      displayName: "Edge Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: "alice",
      metadata: { team: "runtime" },
    },
    sdk,
    chatId,
    log: (msg) => logs.push(msg),
    touch: () => {},
    setRuntimeState: () => {},
    emitEvent: (event) => emitted.push(event),
    ...mockCtxPlumbing({ sendMessage }, chatId),
    ...overrides,
  };
}

async function readPromptMessage(callIndex: number): Promise<Record<string, unknown>> {
  const prompt = capturedCalls[callIndex]?.prompt;
  if (!prompt) throw new Error(`missing prompt ${callIndex}`);
  const result = await prompt[Symbol.asyncIterator]().next();
  if (result.done || !result.value || typeof result.value !== "object") {
    throw new Error(`missing prompt value ${callIndex}`);
  }
  return result.value as Record<string, unknown>;
}

function promptContent(prompt: Record<string, unknown>): string {
  const message = prompt.message;
  if (!message || typeof message !== "object") throw new Error("prompt missing message");
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

function textMessage(content = "hello", chatId = "chat-edge"): SessionMessage {
  return { id: `${chatId}-msg`, chatId, senderId: "user-a", format: "text", content, metadata: null };
}

describe("claude-code handler — edge coverage", () => {
  it("covers private image helpers and StreamApiTransientError", async () => {
    const err = new StreamApiTransientError("socket closed");
    expect(err.name).toBe("StreamApiTransientError");
    expect(err.message).toBe("socket closed");

    expect(helpers.isImageRefContent(null)).toBe(false);
    expect(helpers.isImageRefContent({ imageId: "img", mimeType: "text/plain", filename: "x.txt" })).toBe(false);
    expect(helpers.isImageRefContent({ imageId: "img", mimeType: "image/png", filename: "x.png" })).toBe(true);

    expect(helpers.isLegacyImageFileContent(undefined)).toBe(false);
    expect(helpers.isLegacyImageFileContent({ data: "aGk=", mimeType: "image/webp", filename: "x.webp" })).toBe(true);

    expect(helpers.sanitizeChatId("chat-ABC-123")).toBe("chat-ABC-123");
    expect(helpers.sanitizeChatId("../chat")).toBe("unknown");

    const path = await helpers.writeLegacyImageToTempFile(
      { data: Buffer.from("legacy").toString("base64"), mimeType: "image/png", filename: "legacy.png" },
      "../bad-chat",
    );
    expect(path).toContain(join("first-tree", "images", "unknown"));
    expect(readFileSync(path, "utf-8")).toBe("legacy");
  });

  it("covers actual stable CLAUDE.md generation branches", async () => {
    const workspace = join(workspaceRoot, "stable-md");
    await mkdir(join(workspace, ".agent", "context"), { recursive: true });
    await mkdir(join(workspace, ".agent"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "context", "agent-instructions.md"), "Follow the tree.");
    writeFileSync(join(workspace, ".agent", "context", "domain-map.md"), "# Domains");
    writeFileSync(join(workspace, ".agent", "tools.md"), "## Tools");

    const privateIdentity: AgentIdentity = {
      agentId: "agent-private",
      inboxId: "inbox-private",
      displayName: "agent-private",
      type: "agent",
      visibility: "private",
      delegateMention: null,
      metadata: {},
    };
    Reflect.set(privateIdentity, "displayName", undefined);
    helpers.generateStableClaudeMd(workspace, privateIdentity, "/tmp/context-tree");

    const privateMd = readFileSync(join(workspace, "CLAUDE.md"), "utf-8");
    expect(privateMd).toContain("agent-private, a personal assistant agent");
    expect(privateMd).toContain("Follow the tree.");
    expect(privateMd).toContain("# Domains");
    expect(privateMd).toContain("/tmp/context-tree");
    expect(privateMd).toContain("## Tools");

    const bareWorkspace = join(workspaceRoot, "stable-md-bare");
    await mkdir(join(bareWorkspace, ".agent", "context"), { recursive: true });
    helpers.generateStableClaudeMd(
      bareWorkspace,
      {
        agentId: "agent-org",
        inboxId: "inbox-org",
        displayName: "Org Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      null,
    );

    const orgMd = readFileSync(join(bareWorkspace, "CLAUDE.md"), "utf-8");
    expect(orgMd).toContain("Org Agent, an autonomous agent");
    expect(orgMd).not.toContain("Operating Instructions");
    expect(orgMd).not.toContain("Context Tree Location");
  });

  it("covers tool processor guard branches and empty result previews", () => {
    const emit = vi.fn<(event: SessionEvent) => void>();
    const processor = createToolCallProcessor(emit);

    processor.onMessage({});
    processor.onMessage(null);
    processor.onMessage("bad");
    processor.onMessage({ type: "assistant", message: null });
    processor.onMessage({ type: "assistant", message: { content: "not-array" } });
    processor.onMessage({
      type: "assistant",
      message: {
        content: [
          null,
          {},
          { type: "text", text: 7 },
          { type: "tool_use", id: 7, name: "Bash", input: {} },
          { type: "thinking" },
        ],
      },
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0].kind).toBe("thinking");

    processor.onMessage({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu-empty", name: "Bash", input: {} }] },
    });
    processor.onMessage({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu-empty", content: [] }] },
    });

    const final = emit.mock.calls.at(-1)?.[0];
    if (!final || final.kind !== "tool_call") throw new Error("expected tool_call");
    expect(final.payload.status).toBe("ok");
    expect(final.payload.resultPreview).toBeUndefined();

    const treeProcessor = createToolCallProcessor(emit, { path: "/tree", repoUrl: null });
    treeProcessor.onMessage({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu-read", name: "Read", input: null }] },
    });
    treeProcessor.onMessage({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu-read", content: "ok" }] },
    });
  });

  it("converts referenced and legacy image file messages into prompt text", async () => {
    const handler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    const missingCtx = makeSessionCtx("chat-image-missing");
    await handler.start(
      {
        id: "msg-missing",
        chatId: "chat-image-missing",
        senderId: "alice",
        format: "file",
        content: { imageId: "img-missing", mimeType: "image/png", filename: "missing.png" },
        metadata: null,
      },
      missingCtx,
    );
    const missingPrompt = await readPromptMessage(0);
    expect(promptContent(missingPrompt)).toContain('[Image "missing.png" not available on this device]');
    await handler.shutdown();

    const imagePath = await writeImage({
      chatId: "chat-image-present",
      imageId: "img-present",
      mimeType: "image/jpeg",
      base64: Buffer.from("image").toString("base64"),
    });
    const presentHandler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    await presentHandler.start(
      {
        id: "msg-present",
        chatId: "chat-image-present",
        senderId: "alice",
        format: "file",
        content: { imageId: "img-present", mimeType: "image/jpeg", filename: "present.jpg" },
        metadata: null,
      },
      makeSessionCtx("chat-image-present"),
    );
    const presentPrompt = await readPromptMessage(1);
    expect(promptContent(presentPrompt)).toContain(imagePath);
    await presentHandler.shutdown();

    const legacyHandler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    await legacyHandler.start(
      {
        id: "msg-legacy",
        chatId: "chat/image-legacy",
        senderId: "alice",
        format: "file",
        content: {
          data: Buffer.from("legacy-image").toString("base64"),
          mimeType: "image/gif",
          filename: "legacy.gif",
        },
        metadata: null,
      },
      makeSessionCtx("chat/image-legacy"),
    );
    const legacyPrompt = await readPromptMessage(2);
    expect(promptContent(legacyPrompt)).toContain("legacy.gif");
    expect(promptContent(legacyPrompt)).toContain(join("first-tree", "images", "unknown"));
    await legacyHandler.shutdown();

    const blockedImageDir = join(tmpdir(), "first-tree", "images", "chat-image-blocked");
    rmSync(blockedImageDir, { recursive: true, force: true });
    mkdirSync(join(tmpdir(), "first-tree", "images"), { recursive: true });
    writeFileSync(blockedImageDir, "not a directory");
    const blockedHandler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    const blockedLogs: string[] = [];
    await blockedHandler.start(
      {
        id: "msg-blocked",
        chatId: "chat-image-blocked",
        senderId: "alice",
        format: "file",
        content: {
          data: Buffer.from("legacy-image").toString("base64"),
          mimeType: "image/png",
          filename: "blocked.png",
        },
        metadata: null,
      },
      makeSessionCtx("chat-image-blocked", { log: (msg) => blockedLogs.push(msg) }),
    );
    const blockedPrompt = await readPromptMessage(3);
    expect(promptContent(blockedPrompt)).toContain('[Image attachment "blocked.png" failed to materialise]');
    expect(blockedLogs.some((line) => line.includes("Failed to write image to temp file"))).toBe(true);
    await blockedHandler.shutdown();
    rmSync(blockedImageDir, { force: true });

    const noSenderHandler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    const noSenderMessage: SessionMessage = {
      id: "msg-no-sender",
      chatId: "chat-image-no-sender",
      senderId: "alice",
      format: "file",
      content: { imageId: "img-no-sender", mimeType: "image/png", filename: "no-sender.png" },
      metadata: null,
    };
    Reflect.set(noSenderMessage, "senderId", null);
    await noSenderHandler.start(noSenderMessage, makeSessionCtx("chat-image-no-sender"));
    const noSenderPrompt = await readPromptMessage(4);
    expect(promptContent(noSenderPrompt).startsWith("[From:")).toBe(false);
    await noSenderHandler.shutdown();
  });

  it("builds SDK options from runtime config, chat context, env, and source repos", async () => {
    const payloadRef = {
      version: 1,
      current: {
        ...basePayload,
        prompt: { append: "  Agent managed prompt  " },
        model: "claude-opus-4-5",
        env: [{ key: "EDGE_ENV", value: "configured", sensitive: false }],
        mcpServers: [{ name: "stdio-tool", transport: "stdio", command: "node", args: ["tool.js"] }],
        gitRepos: [{ url: "https://github.com/acme/repo.git", ref: "main", localPath: "source/repo" }],
      } satisfies AgentRuntimeConfigPayload,
    };
    const logs: string[] = [];
    const ctx = makeSessionCtx("chat-config", { log: (msg) => logs.push(msg) });
    const handler = createClaudeCodeHandler({
      workspaceRoot,
      agentConfigCache: makeCache(payloadRef),
      gitMirrorManager: makeGitMirrorManager(),
      claudeCodeExecutable: "",
      agentName: "edge-agent",
    });

    await handler.start(textMessage("hello", "chat-config"), ctx);

    const options = capturedCalls[0]?.options;
    expect(options?.pathToClaudeCodeExecutable).toBeUndefined();
    expect(options?.model).toBe("claude-opus-4-5");
    expect(options?.mcpServers).toEqual({ "stdio-tool": { type: "stdio", command: "node", args: ["tool.js"] } });
    expect((options?.env as Record<string, string> | undefined)?.EDGE_ENV).toBe("configured");
    expect(JSON.stringify(options?.systemPrompt)).toContain("Agent managed prompt");
    expect(JSON.stringify(options?.systemPrompt)).toContain("Current Chat Context");
    expect(JSON.stringify(options?.systemPrompt)).toContain("source/repo");
    expect(logs.some((line) => line.includes("Git: cloned https://github.com/acme/repo.git"))).toBe(true);

    const prompt = await readPromptMessage(0);
    expect(JSON.stringify(prompt)).toContain("[From: user-a]");

    await handler.shutdown();

    const occupiedPayloadRef = {
      version: 1,
      current: {
        ...basePayload,
        gitRepos: [{ url: "https://github.com/acme/occupied.git", localPath: "occupied/repo" }],
      } satisfies AgentRuntimeConfigPayload,
    };
    await mkdir(join(workspaceRoot, "occupied", "repo"), { recursive: true });
    const occupiedLogs: string[] = [];
    const occupiedHandler = createClaudeCodeHandler({
      workspaceRoot,
      agentConfigCache: makeCache(occupiedPayloadRef),
      gitMirrorManager: makeGitMirrorManager(),
      claudeCodeExecutable: "",
    });
    await occupiedHandler.start(
      textMessage("occupied", "chat-occupied"),
      makeSessionCtx("chat-occupied", {
        log: (msg) => occupiedLogs.push(msg),
      }),
    );
    expect(occupiedLogs.some((line) => line.includes("occupied by a non-Hub directory"))).toBe(true);
    await occupiedHandler.shutdown();
  });

  it("covers config hot-switch in-flight, restart, and inactive inject paths", async () => {
    const payloadRef = {
      version: 1,
      current: { ...basePayload, model: "claude-opus-4-5" } satisfies AgentRuntimeConfigPayload,
    };
    const logs: string[] = [];
    const handler = createClaudeCodeHandler({
      workspaceRoot,
      agentConfigCache: makeCache(payloadRef),
      claudeCodeExecutable: "",
    });
    const ctx = makeSessionCtx("chat-switch", { log: (msg) => logs.push(msg) });

    handler.inject(textMessage("too early", "chat-switch"));

    await handler.start(textMessage("start", "chat-switch"), ctx);
    await readPromptMessage(0);

    payloadRef.version = 2;
    payloadRef.current = { ...basePayload, model: "claude-opus-4-6" };
    handler.inject(textMessage("same family", "chat-switch"));
    await vi.waitFor(() => expect(fakeQueries[0]?.setModel).toHaveBeenCalledWith("claude-opus-4-6"));
    expect(logs.some((line) => line.includes("path=in-flight"))).toBe(true);
    await readPromptMessage(0);

    payloadRef.version = 3;
    payloadRef.current = { ...basePayload, model: "claude-haiku-4-5" };
    nextCloseThrows = true;
    handler.inject(textMessage("restart", "chat-switch"));
    await vi.waitFor(() => expect(capturedCalls.length).toBeGreaterThanOrEqual(2));
    expect(fakeQueries[0]?.close).toHaveBeenCalled();
    expect(logs.some((line) => line.includes("path=restart"))).toBe(true);
    await readPromptMessage(1);

    payloadRef.version = 4;
    payloadRef.current = { ...basePayload, model: "claude-haiku-4-6" };
    nextSetModelRejectsWith = new Error("set model failed");
    handler.inject(textMessage("set model fails", "chat-switch"));
    await vi.waitFor(() => expect(capturedCalls.length).toBeGreaterThanOrEqual(3));
    expect(logs.some((line) => line.includes("setModel failed, falling back to restart"))).toBe(true);
    await readPromptMessage(2);

    payloadRef.version = 5;
    payloadRef.current = { ...basePayload, model: "claude-haiku-4-7" };
    nextSetModelRejectsWith = "set model string failure";
    handler.inject(textMessage("set model string fails", "chat-switch"));
    await vi.waitFor(() => expect(logs.some((line) => line.includes("set model string failure"))).toBe(true));
    await readPromptMessage(3);

    payloadRef.version = 6;
    payloadRef.current = { ...basePayload, prompt: { append: "restart please" } };
    nextQueryFactoryThrows = true;
    handler.inject(textMessage("switch throws", "chat-switch"));
    await vi.waitFor(() => expect(logs.some((line) => line.includes("maybeSwitchConfig errored"))).toBe(true));

    ctx.formatInboundContent = async () => {
      throw new Error("format failed");
    };
    handler.inject(textMessage("format throws", "chat-switch"));
    await vi.waitFor(() => expect(logs.some((line) => line.includes("toSDKUserMessage errored"))).toBe(true));

    await handler.shutdown();

    logs.length = 0;
    handler.inject(textMessage("after shutdown", "chat-switch"));
    expect(logs).toContain("inject() called but no active session — dropping message");
  });

  it("covers resume fallback and null-message resume branches", async () => {
    const handler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    const ctx = makeSessionCtx("chat-resume");

    const freshId = await handler.resume(textMessage("resume with stale id", "chat-resume"), "stale-session", ctx);
    expect(freshId).not.toBe("stale-session");
    expect(capturedCalls[0]?.options?.sessionId).toBe(freshId);
    expect(capturedCalls[0]?.options?.resume).toBeUndefined();
    await readPromptMessage(0);
    await handler.shutdown();

    const legacyCwd = join(workspaceRoot, "chat-legacy");
    await mkdir(legacyCwd, { recursive: true });
    const encoded = legacyCwd.replace(/[^a-zA-Z0-9-]/g, "-");
    const transcriptDir = join(homedir(), ".claude", "projects", encoded);
    await mkdir(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, "legacy-session.jsonl");
    writeFileSync(transcriptPath, "{}\n");

    const legacyHandler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    const resumed = await legacyHandler.resume(undefined, "legacy-session", makeSessionCtx("chat-legacy"));
    expect(resumed).toBe("legacy-session");
    expect(capturedCalls.at(-1)?.options?.resume).toBe("legacy-session");
    await legacyHandler.shutdown();
    rmSync(transcriptPath, { force: true });

    const normalSessionId = "normal-session";
    const normalEncoded = workspaceRoot.replace(/[^a-zA-Z0-9-]/g, "-");
    const normalTranscriptDir = join(homedir(), ".claude", "projects", normalEncoded);
    await mkdir(normalTranscriptDir, { recursive: true });
    const normalTranscriptPath = join(normalTranscriptDir, `${normalSessionId}.jsonl`);
    writeFileSync(normalTranscriptPath, "{}\n");
    const normalHandler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    const normalResumed = await normalHandler.resume(
      textMessage("normal resume", "chat-resume-normal"),
      normalSessionId,
      makeSessionCtx("chat-resume-normal"),
    );
    expect(normalResumed).toBe(normalSessionId);
    expect(capturedCalls.at(-1)?.options?.resume).toBe(normalSessionId);
    await readPromptMessage(capturedCalls.length - 1);
    await normalHandler.shutdown();
    rmSync(normalTranscriptPath, { force: true });

    expect(existsSync(legacyCwd)).toBe(true);
  });

  it("covers stream API sniff branches, empty success results, and subtype fallbacks", async () => {
    queuedQueryStreams.push(
      [
        {
          kind: "value",
          value: { type: "result", subtype: "success", result: "API Error: fetch failed" },
        },
      ],
      [],
    );
    const transientEvents: SessionEvent[] = [];
    const transientHandler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    await transientHandler.start(
      textMessage("transient", "chat-stream-transient"),
      makeSessionCtx("chat-stream-transient", {
        emitEvent: (event) => transientEvents.push(event),
      }),
    );
    await transientHandler.suspend();
    expect(
      transientEvents.some(
        (event) => event.kind === "error" && event.payload.message.includes("resilience.stream.api_error_detected"),
      ),
    ).toBe(true);

    queuedQueryStreams.push([
      { kind: "value", value: { type: "result", subtype: "success", result: "API Error: 401 Unauthorized" } },
    ]);
    const permanentEvents: SessionEvent[] = [];
    const permanentHandler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    await permanentHandler.start(
      textMessage("permanent", "chat-stream-permanent"),
      makeSessionCtx("chat-stream-permanent", {
        emitEvent: (event) => permanentEvents.push(event),
      }),
    );
    await permanentHandler.suspend();
    expect(
      permanentEvents.some((event) => event.kind === "error" && event.payload.message.includes("Claude API error")),
    ).toBe(true);
    expect(permanentEvents.some((event) => event.kind === "turn_end" && event.payload.status === "error")).toBe(true);

    queuedQueryStreams.push([{ kind: "value", value: { type: "result", subtype: "success" } }]);
    const emptySuccessEvents: SessionEvent[] = [];
    const emptySuccessHandler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    await emptySuccessHandler.start(
      textMessage("empty", "chat-stream-empty"),
      makeSessionCtx("chat-stream-empty", {
        emitEvent: (event) => emptySuccessEvents.push(event),
      }),
    );
    await emptySuccessHandler.suspend();
    expect(emptySuccessEvents.some((event) => event.kind === "turn_end" && event.payload.status === "success")).toBe(
      true,
    );

    queuedQueryStreams.push([{ kind: "value", value: { type: "result", subtype: "error_unknown" } }]);
    const subtypeLogs: string[] = [];
    const subtypeHandler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    await subtypeHandler.start(
      textMessage("subtype", "chat-stream-subtype"),
      makeSessionCtx("chat-stream-subtype", {
        log: (msg) => subtypeLogs.push(msg),
      }),
    );
    await subtypeHandler.suspend();
    expect(subtypeLogs.some((line) => line.includes("turns=?"))).toBe(true);
    expect(subtypeLogs.some((line) => line.includes("duration=?ms"))).toBe(true);
  });

  it("covers auto-resume emit failure logging", async () => {
    queuedQueryStreams.push([{ kind: "throw", error: new Error("initial stream failed") }]);
    throwOnQueryCall = 2;
    const logs: string[] = [];
    const handler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    await handler.start(
      textMessage("resume emit failure", "chat-resume-emit-fail"),
      makeSessionCtx("chat-resume-emit-fail", {
        emitEvent: () => {
          throw new Error("event sink down");
        },
        log: (msg) => logs.push(msg),
      }),
    );
    await handler.suspend();
    expect(logs.some((line) => line.includes("Failed to emit auto-resume error event"))).toBe(true);
  });

  it("covers bootstrap drift logging and context tree integration callback", async () => {
    await mkdir(join(workspaceRoot, ".agent"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".agent", "init-complete"), "{}");
    writeFileSync(join(workspaceRoot, ".agent", "context-tree-head"), "abcdef1234567890");
    writeFileSync(join(workspaceRoot, ".agent", "identity.json"), "{bad json");
    const headLogs: string[] = [];
    const headHandler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    await headHandler.start(
      textMessage("head", "chat-head"),
      makeSessionCtx("chat-head", {
        log: (msg) => headLogs.push(msg),
      }),
    );
    expect(headLogs.some((line) => line.includes("HEAD probe returned null"))).toBe(true);
    await headHandler.shutdown();

    writeFileSync(join(workspaceRoot, ".agent", "cli-version"), "0.0.0-old");
    const cliLogs: string[] = [];
    const cliHandler = createClaudeCodeHandler({ workspaceRoot, claudeCodeExecutable: "" });
    await cliHandler.start(
      textMessage("cli", "chat-cli"),
      makeSessionCtx("chat-cli", {
        log: (msg) => cliLogs.push(msg),
      }),
    );
    expect(cliLogs.some((line) => line.includes("Bundled CLI version changed"))).toBe(true);
    await cliHandler.shutdown();

    const binDir = join(home, "bin");
    await mkdir(binDir, { recursive: true });
    const fakeFirstTree = join(binDir, "first-tree");
    writeFileSync(fakeFirstTree, "#!/usr/bin/env sh\nprintf 'integrated\\n'\n");
    chmodSync(fakeFirstTree, 0o755);
    const fakeGit = join(binDir, "git");
    writeFileSync(fakeGit, "#!/usr/bin/env sh\nprintf 'fedcba9876543210\\n'\n");
    chmodSync(fakeGit, 0o755);
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
    const contextTreePath = join(home, "context-tree");
    await mkdir(contextTreePath, { recursive: true });
    writeFileSync(join(contextTreePath, "AGENT.md"), "Read context.");
    writeFileSync(join(contextTreePath, "NODE.md"), "# Root");
    const integrationLogs: string[] = [];
    const integrationHandler = createClaudeCodeHandler({
      workspaceRoot: join(home, "integration-workspace"),
      claudeCodeExecutable: "",
      contextTreePath,
      contextTreeRepoUrl: "https://example.com/tree.git",
      agentName: "edge-agent",
    });
    await integrationHandler.start(
      textMessage("integrate", "chat-integrate"),
      makeSessionCtx("chat-integrate", {
        log: (msg) => integrationLogs.push(msg),
      }),
    );
    expect(integrationLogs.some((line) => line.includes("First-tree integration installed"))).toBe(true);
    await integrationHandler.shutdown();

    const driftWorkspace = join(home, "drift-workspace");
    await mkdir(join(driftWorkspace, ".agent"), { recursive: true });
    writeFileSync(join(driftWorkspace, ".agent", "init-complete"), "{}");
    writeFileSync(join(driftWorkspace, ".agent", "context-tree-head"), "abcdef1234567890");
    const driftTreePath = join(home, "drift-tree");
    await mkdir(join(driftTreePath, ".git"), { recursive: true });
    const driftLogs: string[] = [];
    const driftHandler = createClaudeCodeHandler({
      workspaceRoot: driftWorkspace,
      claudeCodeExecutable: "",
      contextTreePath: driftTreePath,
    });
    await driftHandler.start(
      textMessage("drift", "chat-drift"),
      makeSessionCtx("chat-drift", {
        log: (msg) => driftLogs.push(msg),
      }),
    );
    expect(driftLogs.some((line) => line.includes("Context Tree HEAD changed"))).toBe(true);
    await driftHandler.shutdown();
  });
});
