import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  CodexAppServerRpcError,
  CodexAppServerTransportError,
  isCodexAppServerTransientError,
} from "../handlers/codex/app-server/client.js";
import { CodexAppServerStartupError, createCodexAppServerHandler } from "../handlers/codex/app-server/index.js";
import {
  buildWorkspaceOnlyAppServerEnvironment,
  buildWorkspaceOnlyBubblewrapArgs,
  createWorkspaceOnlySpawnProcess,
  landingCodexDenyPaths,
} from "../handlers/codex/app-server/workspace-sandbox.js";
import { setCliBinding } from "../runtime/cli-binding.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

vi.mock("../runtime/bootstrap.js", () => ({
  FIRST_TREE_RUNTIME_DIR: ".first-tree-workspace",
  FIRST_TREE_WORKSPACE_MARKER: ".first-tree-workspace",
  IDENTITY_JSON_REL: join(".first-tree-workspace", "identity.json"),
  bootstrapWorkspace: vi.fn(),
  deepEqualIdentity: vi.fn(() => true),
  ensureWorkspaceRuntimeDir: vi.fn((workspacePath: string) => {
    const dir = join(workspacePath, ".first-tree-workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }),
  installCoreSkills: vi.fn(),
  installFirstTreeIntegration: vi.fn(() => true),
  isHubWorktreeMarker: vi.fn(() => false),
  readCachedBundledCliVersion: vi.fn(() => null),
  readCachedContextTreeHead: vi.fn(() => null),
  readContextTreeHead: vi.fn(() => null),
  resolveBundledCliVersion: vi.fn(() => "0.0.0-test"),
  writeAgentBriefing: vi.fn(),
  writeBundledCliVersion: vi.fn(),
  writeContextTreeHead: vi.fn(),
}));

vi.mock("../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async () => ({
    chatId: "chat-app-server-extra",
    title: "extra app-server coverage",
    topic: null,
    description: null,
    participants: [],
  })),
}));

const AGENT_ID = "019e71c9-88d2-70be-be67-fdb033b2ef0b";
const RESPONSE_OK_TIMEOUT_MS = 2_000;

type JsonRecord = Record<string, unknown>;
type RequestRecord = {
  method: string;
  params: unknown;
  timeoutMs?: number;
};
type NotificationHandler = (notification: { method: string; params?: unknown }) => void;
type CloseHandler = (error: CodexAppServerTransportError) => void;
type RequestResponder = (params: unknown, timeoutMs?: number) => unknown | Promise<unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function makeChild(exitOnSignals: readonly NodeJS.Signals[] = ["SIGTERM"]) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & {
    killed: boolean;
    kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals | number) => boolean>>;
  };
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const writes: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();

  stdin.on("data", (chunk: Buffer | string) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });

  child.stdin = stdin as ChildProcessWithoutNullStreams["stdin"];
  child.stdout = stdout as ChildProcessWithoutNullStreams["stdout"];
  child.stderr = stderr as ChildProcessWithoutNullStreams["stderr"];
  child.killed = false;
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    signals.push(signal);
    child.killed = true;
    if (typeof signal === "string" && exitOnSignals.includes(signal)) {
      setImmediate(() => child.emit("exit", null, signal));
    }
    return true;
  });

  return { child, signals, stderr, stdout, writes };
}

function writtenMessages(writes: readonly string[]): JsonRecord[] {
  return writes
    .join("")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => asRecord(JSON.parse(line)))
    .filter((record): record is JsonRecord => record !== null);
}

async function waitFor(assertion: () => boolean, label = "assertion"): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function startInitializedClient(options: Partial<CodexAppServerClientOptions> = {}): Promise<
  {
    client: CodexAppServerClient;
  } & ReturnType<typeof makeChild>
> {
  const childState = makeChild();
  const startPromise = CodexAppServerClient.start({
    binary: "/tmp/fake-codex",
    requestTimeoutMs: RESPONSE_OK_TIMEOUT_MS,
    spawnProcess: () => childState.child,
    ...options,
  });
  await waitFor(
    () => writtenMessages(childState.writes).some((message) => message.method === "initialize"),
    "initialize request",
  );
  childState.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`);
  const client = await startPromise;
  return { client, ...childState };
}

class FakeAppServerClient {
  readonly requests: RequestRecord[] = [];
  readonly responders = new Map<string, RequestResponder>();
  readonly errors = new Map<string, Error>();
  stderr = "";
  isClosed = false;
  shutdownCalls = 0;
  onNotification: NotificationHandler | null = null;
  onClose: CloseHandler | null = null;
  threadStartResult: unknown = { thread: { id: "thread-app-server" } };
  turnCounter = 0;

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    this.requests.push({ method, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    const responder = this.responders.get(method);
    if (responder) return responder(params, timeoutMs);
    const error = this.errors.get(method);
    if (error) throw error;
    if (method === "thread/start") return this.threadStartResult;
    if (method === "thread/resume") return { thread: { id: "thread-app-server" } };
    if (method === "turn/start") {
      this.turnCounter += 1;
      return {
        turn: {
          id: `turn-${this.turnCounter}`,
          status: "inProgress",
          items: [],
          error: null,
        },
      };
    }
    if (method === "turn/steer") return { turnId: `turn-${this.turnCounter}` };
    if (method === "turn/interrupt") return {};
    return {};
  }

  notify(): void {}

  shutdown(): void {
    this.shutdownCalls += 1;
    this.isClosed = true;
  }

  emit(method: string, params?: unknown): void {
    this.onNotification?.({ method, params });
  }

  close(message = "app-server died"): void {
    this.onClose?.(new CodexAppServerTransportError(message));
  }
}

let workspaceRoot: string;
const extraTempRoots: string[] = [];

function makeOutsideTempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  extraTempRoots.push(root);
  return root;
}

function makeMessage(id: string, content: string, inboxEntryId?: number): SessionMessage {
  return {
    ...(inboxEntryId === undefined ? {} : { inboxEntryId }),
    id,
    chatId: "chat-app-server-extra",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
  };
}

function makeDeliveryToken(): DeliveryToken {
  return {
    processingStarted: vi.fn<DeliveryToken["processingStarted"]>(),
    complete: vi.fn<DeliveryToken["complete"]>().mockResolvedValue(undefined),
    retry: vi.fn<DeliveryToken["retry"]>(),
    terminalRejected: vi.fn<DeliveryToken["terminalRejected"]>().mockResolvedValue(undefined),
  };
}

function makeContext(
  opts: {
    emitEvent?: ReturnType<typeof vi.fn<(event: SessionEvent) => void>>;
    failSessionForRecovery?: NonNullable<SessionContext["failSessionForRecovery"]>;
    formatInboundContent?: SessionContext["formatInboundContent"];
    log?: ReturnType<typeof vi.fn<(message: string) => void>>;
  } = {},
): SessionContext {
  const sendMessage = vi
    .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
    .mockResolvedValue(undefined);
  const createAgentOutboxToken = vi
    .fn<(chatId: string) => Promise<{ accessToken: string; expiresIn: number }>>()
    .mockResolvedValue({ accessToken: "scoped-outbox-token", expiresIn: 900 });

  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: `inbox_${AGENT_ID}`,
      displayName: "codex-assistant",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage, createAgentOutboxToken } as unknown as SessionContext["sdk"],
    chatId: "chat-app-server-extra",
    log: opts.log ?? (() => {}),
    recordProviderActivity: () => {},
    emitEvent: opts.emitEvent ?? (() => {}),
    ...mockCtxPlumbing({ sendMessage }, "chat-app-server-extra"),
    ...(opts.failSessionForRecovery ? { failSessionForRecovery: opts.failSessionForRecovery } : {}),
    ...(opts.formatInboundContent ? { formatInboundContent: opts.formatInboundContent } : {}),
  };
}

function makeHandler(fake: FakeAppServerClient, extraConfig: Record<string, unknown> = {}) {
  return createCodexAppServerHandler({
    workspaceRoot,
    codexRuntimeBinaryResolver: async () => ({
      ok: true,
      binary: "/tmp/fake-codex",
      runtimeSource: "path",
      runtimePath: "/tmp/fake-codex",
      version: "0.0.0-test",
    }),
    codexAppServerClientFactory: async (options: { onNotification?: NotificationHandler; onClose?: CloseHandler }) => {
      fake.onNotification = options.onNotification ?? null;
      fake.onClose = options.onClose ?? null;
      return fake;
    },
    ...extraConfig,
  });
}

function makeCliBin(root: string): string {
  const cliBinDir = join(root, "first-tree-cli-bin");
  mkdirSync(cliBinDir, { recursive: true });
  writeFileSync(join(cliBinDir, "first-tree-test"), "#!/bin/sh\n", { mode: 0o755 });
  return cliBinDir;
}

beforeEach(() => {
  workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "ft-codex-app-server-extra-")));
  setCliBinding({ binName: "first-tree-test", packageName: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(workspaceRoot, { recursive: true, force: true });
  for (const root of extraTempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("CodexAppServerClient extra JSON-RPC coverage", () => {
  it("logs malformed stdout, rejects unsupported server requests, and dispatches notifications", async () => {
    const onLog = vi.fn<(message: string) => void>();
    const onNotification = vi.fn<(notification: { method: string; params?: unknown }) => void>();
    const { client, signals, stdout, writes } = await startInitializedClient({ onLog, onNotification });

    stdout.write("\nnot-json\n[]\n");
    stdout.write(`${JSON.stringify({ id: 999, result: "late unknown response" })}\n`);
    stdout.write(`${JSON.stringify({ id: "srv-1", method: "workspace/read", params: { path: "README.md" } })}\n`);
    stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-1" } })}\n`);

    await waitFor(
      () => onNotification.mock.calls.length === 1 && writtenMessages(writes).some((message) => message.id === "srv-1"),
      "server request rejection and notification",
    );

    expect(onLog.mock.calls.some(([message]) => message.includes("emitted malformed JSON"))).toBe(true);
    expect(onNotification).toHaveBeenCalledWith({ method: "turn/completed", params: { turnId: "turn-1" } });
    expect(writtenMessages(writes).find((message) => message.id === "srv-1")).toMatchObject({
      id: "srv-1",
      error: {
        code: -32601,
        message: "First Tree does not handle app-server request workspace/read",
      },
    });

    await client.shutdown();
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("surfaces rpc error payloads, timeout rejections, and closed transports", async () => {
    const { client, stdout, writes } = await startInitializedClient();

    const rpcPromise = client.request("turn/start", { input: [] });
    await waitFor(() => writtenMessages(writes).some((message) => message.id === 2), "turn/start write");
    stdout.write(
      `${JSON.stringify({
        id: 2,
        error: { code: -32001, message: "server overloaded", data: { retryAfter: 2 } },
      })}\n`,
    );
    const rpcError = await rpcPromise.catch((err: unknown) => err);
    expect(rpcError).toBeInstanceOf(CodexAppServerRpcError);
    expect(rpcError).toMatchObject({ code: -32001, data: { retryAfter: 2 } });
    expect(isCodexAppServerTransientError(rpcError)).toBe(true);

    const plainErrorPromise = client.request("bad/rpc");
    await waitFor(() => writtenMessages(writes).some((message) => message.id === 3), "bad/rpc write");
    stdout.write(`${JSON.stringify({ id: 3, error: "plain failure" })}\n`);
    await expect(plainErrorPromise).rejects.toThrow("plain failure");

    await expect(client.request("never/responds", undefined, 5)).rejects.toThrow(
      "codex app-server request timed out: never/responds",
    );

    await client.shutdown();
    await expect(client.request("after/shutdown")).rejects.toThrow("codex app-server transport is closed");
  });
});

describe("workspace-only app-server sandbox extra edges", () => {
  it("requires app-server state inside the workspace and omits missing optional host integrations", () => {
    const cliBinDir = makeCliBin(workspaceRoot);
    const hostHome = join(workspaceRoot, "host-home");
    const firstTreeHome = join(workspaceRoot, ".first-tree-workspace", "outbox-home");
    const outsideFirstTreeHome = makeOutsideTempRoot("ft-outside-first-tree-home-");
    mkdirSync(hostHome, { recursive: true });
    mkdirSync(firstTreeHome, { recursive: true });
    mkdirSync(outsideFirstTreeHome, { recursive: true });

    expect(() => buildWorkspaceOnlyAppServerEnvironment({ FIRST_TREE_CLI_BIN_DIR: cliBinDir }, workspaceRoot)).toThrow(
      "workspace-only app-server requires FIRST_TREE_HOME",
    );
    expect(() =>
      buildWorkspaceOnlyAppServerEnvironment(
        {
          HOME: hostHome,
          FIRST_TREE_HOME: outsideFirstTreeHome,
          FIRST_TREE_CLI_BIN_DIR: cliBinDir,
        },
        workspaceRoot,
      ),
    ).toThrow("FIRST_TREE_HOME escapes workspace-only sandbox");

    const {
      env,
      codexHome,
      hostHome: resolvedHostHome,
    } = buildWorkspaceOnlyAppServerEnvironment(
      {
        HOME: hostHome,
        CODEX_HOME: "relative-codex",
        FIRST_TREE_HOME: firstTreeHome,
        FIRST_TREE_CLI_BIN_DIR: cliBinDir,
        FIRST_TREE_SERVER_URL: "https://first-tree.test",
        OPENAI_API_KEY: "secret",
        PATH: "/sensitive/bin:/usr/bin",
      },
      workspaceRoot,
    );

    expect(resolvedHostHome).toBe(hostHome);
    expect(codexHome).toBe(resolve(hostHome, "relative-codex"));
    expect(env).toMatchObject({
      HOME: workspaceRoot,
      CODEX_HOME: resolve(hostHome, "relative-codex"),
      FIRST_TREE_HOME: firstTreeHome,
      FIRST_TREE_SERVER_URL: "https://first-tree.test",
      TMPDIR: "/tmp",
    });
    expect(env.GH_CONFIG_DIR).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).not.toContain("/sensitive/bin");
  });

  it("denies both lexical and real Codex home paths when the auth dir is a symlink", () => {
    const hostHome = join(workspaceRoot, "host-home");
    const realCodexHome = join(workspaceRoot, "real-codex-home");
    const linkedCodexHome = join(hostHome, ".codex-link");
    mkdirSync(hostHome, { recursive: true });
    mkdirSync(realCodexHome, { recursive: true });
    symlinkSync(realCodexHome, linkedCodexHome, "dir");

    expect(landingCodexDenyPaths(linkedCodexHome, hostHome)).toEqual(
      expect.arrayContaining([linkedCodexHome, realCodexHome, join(hostHome, ".first-tree")]),
    );
  });

  it("fails closed for bad bubblewrap paths and missing sandbox binaries", () => {
    const commandDir = join(workspaceRoot, "command-dir");
    const outside = makeOutsideTempRoot("ft-bwrap-outside-");
    mkdirSync(commandDir);

    expect(() =>
      buildWorkspaceOnlyBubblewrapArgs({
        command: "missing-codex",
        args: [],
        workspaceRoot,
        env: { PATH: "" },
      }),
    ).toThrow("workspace-only sandbox could not resolve executable: missing-codex");
    expect(() =>
      buildWorkspaceOnlyBubblewrapArgs({
        command: commandDir,
        args: [],
        workspaceRoot,
      }),
    ).toThrow("workspace-only sandbox executable is not a file");
    expect(() =>
      buildWorkspaceOnlyBubblewrapArgs({
        command: "/bin/sh",
        args: [],
        workspaceRoot,
        cwd: outside,
      }),
    ).toThrow("cwd escapes workspace-only sandbox");

    const spawnProcess = createWorkspaceOnlySpawnProcess({
      workspaceRoot,
      sandboxBinary: "definitely-missing-bwrap",
    });
    expect(() =>
      spawnProcess("/bin/sh", ["-c", "true"], {
        cwd: workspaceRoot,
        env: {
          FIRST_TREE_HOME: join(workspaceRoot, ".first-tree-workspace"),
          FIRST_TREE_CLI_BIN_DIR: makeCliBin(workspaceRoot),
          PATH: "/usr/bin:/bin",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    ).toThrow(process.platform === "linux" ? "workspace-only sandbox requires bubblewrap" : "requires Linux");
  });
});

describe("codex app-server handler extra branches", () => {
  it("wraps startup failures from binary resolution, initialization, and thread/start responses", async () => {
    const resolveFailure = makeHandler(new FakeAppServerClient(), {
      codexRuntimeBinaryResolver: async () => ({ ok: false, error: "missing codex binary" }),
    });
    await expect(resolveFailure.start(makeMessage("m1", "first"), makeContext())).rejects.toMatchObject({
      stage: "resolve-binary",
      message: expect.stringContaining("missing codex binary"),
    });

    const initializeFailure = makeHandler(new FakeAppServerClient(), {
      codexAppServerClientFactory: async () => {
        throw new Error("initialize rpc failed");
      },
    });
    await expect(initializeFailure.start(makeMessage("m2", "first"), makeContext())).rejects.toMatchObject({
      stage: "initialize",
      message: expect.stringContaining("initialize rpc failed"),
    });

    const malformedThread = new FakeAppServerClient();
    malformedThread.threadStartResult = { thread: {} };
    const malformedHandler = makeHandler(malformedThread);
    await expect(malformedHandler.start(makeMessage("m3", "first"), makeContext())).rejects.toMatchObject({
      stage: "thread-start",
      message: expect.stringContaining("missing thread id"),
    });
    await malformedHandler.shutdown();

    const failedThread = new FakeAppServerClient();
    failedThread.errors.set("thread/start", new Error("thread start rpc failed"));
    const failedThreadHandler = makeHandler(failedThread);
    const failedThreadError = await failedThreadHandler
      .start(makeMessage("m4", "first"), makeContext())
      .catch((err) => err);
    expect(failedThreadError).toBeInstanceOf(CodexAppServerStartupError);
    expect(failedThreadError).toMatchObject({
      stage: "thread-start",
      message: expect.stringContaining("thread start rpc failed"),
    });
    await failedThreadHandler.shutdown();
  });

  it("returns a queued route and retries when initial inbound formatting fails", async () => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const log = vi.fn<(message: string) => void>();
    const handler = makeHandler(fake);
    const message = makeMessage("m1", "first");
    const ctx = makeContext({
      log,
      formatInboundContent: async () => {
        throw new Error("formatter down");
      },
    });

    await expect(handler.start(message, ctx, token)).resolves.toEqual({
      sessionId: "thread-app-server",
      route: { kind: "owned", mode: "queued" },
    });

    expect(token.retry).toHaveBeenCalledWith(message, "codex_app_server_initial_format_failed");
    expect(log.mock.calls.some(([entry]) => entry.includes("initial formatInboundContent failed"))).toBe(true);

    await handler.shutdown();
  });

  it("formats grouped injected bodies and emits app-server terminal item events with path metadata", async () => {
    const contextTreePath = join(workspaceRoot, "context-tree");
    const treeDoc = join(contextTreePath, "docs", "NODE.md");
    mkdirSync(dirname(treeDoc), { recursive: true });
    writeFileSync(treeDoc, "tree node\n");

    const fake = new FakeAppServerClient();
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake, {
      contextTreePath,
      contextTreeRepoUrl: "https://github.com/acme/context-tree.git",
      contextTreeBranch: "main",
    });
    const ctx = makeContext({
      emitEvent,
      formatInboundContent: async (message) => `body:${message.id}:${message.content}`,
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"), "initial turn/start");

    const injectTokenA = makeDeliveryToken();
    const injectTokenB = makeDeliveryToken();
    handler.inject(makeMessage("m2", "second"), injectTokenA);
    handler.inject(makeMessage("m3", "third"), injectTokenB);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"), "turn/steer");

    const steer = fake.requests.find((request) => request.method === "turn/steer");
    const steerParams = asRecord(steer?.params);
    const rawSteerInput = Array.isArray(steerParams?.input) ? steerParams.input[0] : null;
    const steerInput = asRecord(rawSteerInput);
    expect(steerInput?.text).toBe("body:m2:second\n\nbody:m3:third");

    fake.emit("turn/completed", {
      threadId: "thread-app-server",
      turn: {
        id: "turn-1",
        status: "completed",
        error: null,
        items: [
          { type: "reasoning", id: "think-1" },
          {
            type: "commandExecution",
            id: "cmd-1",
            status: "completed",
            command: `cat ${treeDoc}`,
            cwd: workspaceRoot,
            aggregatedOutput: "x".repeat(450),
          },
          {
            type: "fileChange",
            id: "file-1",
            status: "completed",
            changes: [{ path: treeDoc }, { path: treeDoc }, { filePath: "src/local.ts" }],
          },
          {
            type: "mcpToolCall",
            id: "mcp-1",
            status: "failed",
            server: "docs",
            tool: "lookup",
            arguments: { query: "first-tree" },
            error: { message: "missing document" },
          },
          { type: "webSearch", id: "web-1", query: "first tree" },
          { type: "plan", id: "plan-1", text: "ship tests" },
          { type: "agentMessage", id: "agent-1", text: "done", phase: null, memoryCitation: null },
        ],
      },
    });

    await startPromise;

    const events = emitEvent.mock.calls.map(([event]) => event);
    const toolCalls = events.filter(
      (event): event is Extract<SessionEvent, { kind: "tool_call" }> => event.kind === "tool_call",
    );
    const commandEvent = toolCalls.find((event) => event.payload.name === "command");
    const fileEvent = toolCalls.find((event) => event.payload.name === "file_change");
    const mcpEvent = toolCalls.find((event) => event.payload.name === "mcp:docs/lookup");

    expect(events.some((event) => event.kind === "thinking")).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "assistant_text", payload: { text: "done" } }),
        expect.objectContaining({
          kind: "tool_call",
          payload: expect.objectContaining({ name: "web_search", args: { query: "first tree" }, status: "ok" }),
        }),
        expect.objectContaining({
          kind: "tool_call",
          payload: expect.objectContaining({ name: "todo_list", args: { text: "ship tests" }, status: "ok" }),
        }),
      ]),
    );
    expect(commandEvent?.payload.resultPreview).toHaveLength(400);
    expect(commandEvent?.payload.toolFileRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "tool_arg",
          localPath: treeDoc,
          repoUrl: "https://github.com/acme/context-tree.git",
          repoBranch: "main",
          repoRelativePath: "docs/NODE.md",
          pathKind: "file",
        }),
      ]),
    );
    expect(fileEvent?.payload.toolFileRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "file_change",
          localPath: treeDoc,
          repoUrl: "https://github.com/acme/context-tree.git",
          repoBranch: "main",
          repoRelativePath: "docs/NODE.md",
          pathKind: "file",
        }),
        expect.objectContaining({ origin: "file_change", localPath: "src/local.ts", pathKind: "file" }),
      ]),
    );
    expect(mcpEvent?.payload).toMatchObject({
      args: { query: "first-tree" },
      resultPreview: "error: missing document",
      status: "error",
    });
    expect(token.complete).toHaveBeenCalledWith(
      [makeMessage("m1", "first"), makeMessage("m2", "second"), makeMessage("m3", "third")],
      { status: "success", terminal: true },
    );

    await handler.shutdown();
  });

  it("retries queued work, aborts the active turn, and still shuts down when interrupt fails", async () => {
    const fake = new FakeAppServerClient();
    fake.responders.set("turn/interrupt", () => {
      throw new Error("interrupt rpc failed");
    });
    const log = vi.fn<(message: string) => void>();
    const token = makeDeliveryToken();
    const queuedToken = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext({ log });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"), "active turn/start");

    handler.inject(makeMessage("m2", "queued"), queuedToken);
    await handler.shutdown("manual_shutdown");
    await startPromise;
    await flushAsync();

    expect(queuedToken.retry).toHaveBeenCalledWith(makeMessage("m2", "queued"), "manual_shutdown");
    expect(fake.requests.find((request) => request.method === "turn/interrupt")).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread-app-server", turnId: "turn-1" },
      timeoutMs: 2_000,
    });
    expect(log.mock.calls.some(([entry]) => entry.includes("turn interrupt failed: interrupt rpc failed"))).toBe(true);
    expect(fake.shutdownCalls).toBe(1);
    expect(handler.inject(makeMessage("m3", "late"))).toEqual({
      kind: "rejected",
      reason: "no_active_context",
      retryable: true,
    });
  });
});
