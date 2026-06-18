import { isAbsolute, resolve } from "node:path";
import type { AgentRuntimeConfigPayload, SessionEvent, ToolFileRef } from "@first-tree/shared";
import { ensureAgentBootstrap as ensureAgentBootstrapShared } from "../../runtime/agent-bootstrap.js";
import { buildAgentBriefing } from "../../runtime/agent-briefing.js";
import type { AgentConfigCache } from "../../runtime/agent-config-cache.js";
import { FIRST_TREE_WORKSPACE_MARKER, type PredeclaredSourceRepo } from "../../runtime/bootstrap.js";
import { type CodexBinaryResolution, resolveCodexRuntimeBinary } from "../../runtime/capabilities/codex.js";
import { type ChatContext, fetchChatContext } from "../../runtime/chat-context.js";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexAppServerNotification,
  CodexAppServerRpcError,
  type CodexAppServerTransportError,
  isCodexAppServerTransientError,
} from "../../runtime/codex-app-server-client.js";
import {
  type ContextTreeAttribution,
  resolveContextTreeRelativePath,
  toolFileRefsFromShellCommand,
} from "../../runtime/context-tree-file-refs.js";
import {
  type ContextTreeGitWriteTracker,
  createContextTreeGitWriteTracker,
} from "../../runtime/context-tree-git-status.js";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerConfig,
  HandlerFactory,
  SessionContext,
  SessionMessage,
  TurnConsumedErrorReason,
} from "../../runtime/handler.js";
import { deliveryTokenFromSessionContext } from "../../runtime/handler.js";
import { materializeResourceSkills } from "../../runtime/resource-skills.js";
import { currentSourceRepoNamesFromPayload, declaredSourceRepos } from "../../runtime/source-repos.js";
import { acquireAgentHome, markWorkspaceInitComplete } from "../../runtime/workspace.js";
import { formatAuthHint, isCodexAuthError } from "../auth-error-hint.js";
import {
  buildCodexThreadOptions,
  collectCodexFileChangePaths,
  detectAgentsMdConcurrentWrite,
  isTransientCodexErrorMessage,
} from "../codex.js";
import { resolveTurnSettlement } from "../turn-settlement.js";

type CodexConfigValue = string | number | boolean | null | CodexConfigValue[] | CodexConfigObject;
type CodexConfigObject = { [key: string]: CodexConfigValue };

type JsonRecord = Record<string, unknown>;

type AppServerClientLike = {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  shutdown(): void | Promise<void>;
  readonly stderr: string;
  readonly isClosed: boolean;
};

type AppServerClientFactory = (options: CodexAppServerClientOptions) => Promise<AppServerClientLike>;

type RuntimeBinaryResolver = (env?: NodeJS.ProcessEnv) => Promise<CodexBinaryResolution>;

type QueueEntry = {
  message: SessionMessage;
  token: DeliveryToken;
};

type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type TurnErrorInfo = {
  message: string;
  codexErrorInfo: unknown;
  additionalDetails: string | null;
};

type CurrentTurn = {
  turnId: string;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  primaryToken: DeliveryToken;
  acceptedMessages: SessionMessage[];
  finalAgentText: string;
  completedItemIds: Set<string>;
  usageLast: TokenUsageBreakdown | null;
  failure: TurnErrorInfo | null;
  providerCompleted: boolean;
  stopRequested: boolean;
  resolveTerminal: () => void;
};

export class CodexAppServerStartupError extends Error {
  readonly stage: string;

  constructor(stage: string, cause: unknown) {
    super(`codex app-server startup failed at ${stage}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "CodexAppServerStartupError";
    this.stage = stage;
  }
}

const ASSISTANT_TEXT_EVENT_LIMIT = 8000;
const RESULT_PREVIEW_LIMIT = 400;
const USAGE_LIMIT_NOTICE =
  "⚠️ My runtime has reached its usage limit, so I couldn't process the message you just sent. " +
  "Please resend it once the limit resets.";

export const createCodexAppServerHandler: HandlerFactory = (config: HandlerConfig): AgentHandler => {
  const workspaceRoot = config.workspaceRoot as string;
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const contextTreePath = (config.contextTreePath as string | undefined) ?? null;
  const contextTreeRepoUrl = (config.contextTreeRepoUrl as string | undefined) ?? null;
  const contextTreeBranch = (config.contextTreeBranch as string | undefined) ?? null;
  const clientFactory = readClientFactory(config.codexAppServerClientFactory) ?? defaultClientFactory;
  const resolveRuntimeBinary =
    readRuntimeBinaryResolver(config.codexRuntimeBinaryResolver) ?? resolveCodexRuntimeBinary;

  let cwd: string | null = null;
  let ctx: SessionContext | null = null;
  let appServer: AppServerClientLike | null = null;
  let threadId: string | null = null;
  let currentModel = "";
  let currentReasoningEffort = "high";
  let currentTurn: CurrentTurn | null = null;
  let currentTurnPromise: Promise<void> | null = null;
  let turnSettlementInProgress = false;
  let startupTurnPending = false;
  let drainSteerInProgress = false;
  let drainSteerScheduled = false;
  let drainPostTurnInProgress = false;
  let drainPostTurnScheduled = false;
  let shutdownRequested = false;
  let sourceReposForPrompt: PredeclaredSourceRepo[] = [];

  const steerQueue: QueueEntry[] = [];
  const postTurnQueue: QueueEntry[] = [];
  const pendingNotificationsByTurn = new Map<string, CodexAppServerNotification[]>();

  const gitWriteTracker = createContextTreeGitWriteTracker({
    contextTreePath,
    contextTreeRepoUrl,
    contextTreeBranch,
    log: (message) => ctx?.log(message),
  });

  function buildEnv(sessionCtx: SessionContext): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
    if (payload) {
      for (const e of payload.env) env[e.key] = e.value;
    }
    const merged = sessionCtx.buildAgentEnv(env);
    const out: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }

  function buildCodexConfig(payload: AgentRuntimeConfigPayload): CodexConfigObject {
    const cfg: CodexConfigObject = {
      project_root_markers: [FIRST_TREE_WORKSPACE_MARKER],
    };
    if (payload.mcpServers.length === 0) return cfg;

    const mcpServers: CodexConfigObject = {};
    for (const m of payload.mcpServers) {
      if (m.transport === "stdio") {
        mcpServers[m.name] = { command: m.command, args: m.args ?? [] };
      } else {
        const entry: CodexConfigObject = { url: m.url };
        if (m.headers) entry.headers = m.headers;
        mcpServers[m.name] = entry;
      }
    }
    cfg.mcp_servers = mcpServers;
    return cfg;
  }

  function buildBriefing(
    sessionCtx: SessionContext,
    payload: AgentRuntimeConfigPayload,
    chatContext: ChatContext | undefined,
    workspaceCwd: string,
  ): string {
    return buildAgentBriefing({
      identity: sessionCtx.agent,
      payload,
      chatContext,
      workspacePath: workspaceCwd,
      sourceRepos: sourceReposForPrompt,
      contextTreePath,
      contextTreeRepoUrl,
      contextTreeBranch,
    });
  }

  async function fetchChatContextOrLog(sessionCtx: SessionContext): Promise<ChatContext | undefined> {
    try {
      return await fetchChatContext(sessionCtx.sdk, sessionCtx.chatId, sessionCtx.agent);
    } catch (err) {
      sessionCtx.log(`fetchChatContext failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  function declareSourceRepos(payload: AgentRuntimeConfigPayload, workspaceCwd: string): void {
    sourceReposForPrompt = declaredSourceRepos(workspaceCwd, payload);
  }

  function ensureCodexBootstrap(
    workspace: string,
    sessionCtx: SessionContext,
    briefing: string,
    payload: AgentRuntimeConfigPayload,
    payloadResolved: boolean,
  ): void {
    detectAgentsMdConcurrentWrite(workspace, Date.now(), (m) => sessionCtx.log(m));
    ensureAgentBootstrapShared({
      workspace,
      sessionCtx,
      contextTreePath,
      briefing,
      currentSourceRepoNames: currentSourceRepoNamesFromPayload(payload, payloadResolved),
    });
  }

  async function resolvePayload(sessionCtx: SessionContext): Promise<{
    payload: AgentRuntimeConfigPayload;
    resolved: boolean;
  }> {
    let payload: AgentRuntimeConfigPayload | null = null;
    if (agentConfigCache) {
      payload = (await agentConfigCache.refresh(sessionCtx.agent.agentId)).payload;
    }
    if (payload) return { payload, resolved: true };
    return {
      resolved: false,
      payload: {
        kind: "codex",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
        reasoningEffort: "high",
      },
    };
  }

  async function prepareSession(sessionCtx: SessionContext): Promise<{
    payload: AgentRuntimeConfigPayload;
    env: NodeJS.ProcessEnv;
  }> {
    cwd = acquireAgentHome(workspaceRoot);
    const { payload, resolved } = await resolvePayload(sessionCtx);
    const chatContext = await fetchChatContextOrLog(sessionCtx);
    declareSourceRepos(payload, cwd);
    await materializeResourceSkills(cwd, payload, sessionCtx);
    const briefing = buildBriefing(sessionCtx, payload, chatContext, cwd);
    ensureCodexBootstrap(cwd, sessionCtx, briefing, payload, resolved);
    markWorkspaceInitComplete(cwd);
    currentModel = payload.model || "";
    currentReasoningEffort = payload.kind === "codex" ? payload.reasoningEffort : "high";
    return { payload, env: buildEnv(sessionCtx) };
  }

  async function startAppServer(sessionCtx: SessionContext, env: NodeJS.ProcessEnv): Promise<void> {
    let resolution: CodexBinaryResolution;
    try {
      resolution = await resolveRuntimeBinary(env);
    } catch (err) {
      throw new CodexAppServerStartupError("resolve-binary", err);
    }
    if (!resolution.ok) throw new CodexAppServerStartupError("resolve-binary", resolution.error);
    try {
      appServer = await clientFactory({
        binary: resolution.binary,
        cwd: cwd ?? workspaceRoot,
        env,
        onNotification: handleNotification,
        onClose: handleTransportClose,
        onLog: (message) => sessionCtx.log(message),
      });
    } catch (err) {
      throw new CodexAppServerStartupError("initialize", err);
    }
  }

  function threadParams(payload: AgentRuntimeConfigPayload): JsonRecord {
    const opts = buildCodexThreadOptions(payload, cwd ?? workspaceRoot);
    return {
      cwd: opts.workingDirectory,
      approvalPolicy: opts.approvalPolicy,
      sandbox: opts.sandboxMode,
      config: buildCodexConfig(payload),
      ...(opts.model ? { model: opts.model } : {}),
    };
  }

  async function startThread(payload: AgentRuntimeConfigPayload): Promise<string> {
    const client = requireAppServer();
    let result: unknown;
    try {
      result = await client.request("thread/start", {
        ...threadParams(payload),
        sessionStartSource: "startup",
      });
    } catch (err) {
      throw new CodexAppServerStartupError("thread-start", err);
    }
    const id = extractThreadId(result);
    if (!id) throw new CodexAppServerStartupError("thread-start", "missing thread id");
    threadId = id;
    return id;
  }

  async function resumeThread(sessionId: string, payload: AgentRuntimeConfigPayload): Promise<void> {
    const client = requireAppServer();
    try {
      await client.request("thread/resume", {
        threadId: sessionId,
        ...threadParams(payload),
      });
    } catch (err) {
      throw new CodexAppServerStartupError("thread-resume", err);
    }
    threadId = sessionId;
  }

  function emitToolCall(
    sessionCtx: SessionContext,
    payload: {
      toolUseId: string;
      name: string;
      args: unknown;
      status: "ok" | "error" | "pending";
      resultPreview?: string;
      toolFileRefs?: ToolFileRef[];
    },
  ): void {
    const event: SessionEvent = {
      kind: "tool_call",
      payload: {
        toolUseId: payload.toolUseId,
        name: payload.name,
        args: payload.args,
        status: payload.status,
        ...(payload.resultPreview ? { resultPreview: payload.resultPreview.slice(0, RESULT_PREVIEW_LIMIT) } : {}),
        ...(payload.toolFileRefs && payload.toolFileRefs.length > 0 ? { toolFileRefs: payload.toolFileRefs } : {}),
      },
    };
    sessionCtx.emitEvent(event);
  }

  function processItem(item: JsonRecord, sessionCtx: SessionContext, turn: CurrentTurn): void {
    const itemType = item.type;
    const id = typeof item.id === "string" ? item.id : `${turn.turnId}:${turn.completedItemIds.size}`;
    if (turn.completedItemIds.has(id)) return;
    turn.completedItemIds.add(id);

    switch (itemType) {
      case "agentMessage": {
        const text = typeof item.text === "string" ? item.text : "";
        if (!text.trim()) return;
        sessionCtx.emitEvent({
          kind: "assistant_text",
          payload: { text: text.slice(0, ASSISTANT_TEXT_EVENT_LIMIT) },
        });
        turn.finalAgentText = text;
        return;
      }
      case "commandExecution": {
        const status = toolStatus(item.status);
        const command = typeof item.command === "string" ? item.command : "";
        const commandCwd = typeof item.cwd === "string" ? item.cwd : (cwd ?? undefined);
        const shellRefs =
          status === "ok" && commandCwd
            ? toolFileRefsFromShellCommand({
                command,
                cwd: commandCwd,
                contextTreePath,
                contextTreeRepoUrl,
                contextTreeBranch,
              })
            : undefined;
        const toolFileRefs = toolFileRefsForTerminalTool({
          status,
          existingRefs: shellRefs,
          gitWriteTracker,
          toolName: "command",
          toolUseId: id,
        });
        emitToolCall(sessionCtx, {
          toolUseId: id,
          name: "command",
          args: { command, ...(commandCwd ? { cwd: commandCwd } : {}) },
          status,
          resultPreview: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined,
          toolFileRefs,
        });
        return;
      }
      case "fileChange": {
        const status = toolStatus(item.status);
        const changes = item.changes;
        const fileChangeRefs =
          status === "ok" && cwd
            ? toolFileRefsFromAppServerFileChange({
                changes,
                workspaceCwd: cwd,
                contextTreePath,
                contextTreeRepoUrl,
                contextTreeBranch,
              })
            : undefined;
        const toolFileRefs = toolFileRefsForTerminalTool({
          status,
          existingRefs: fileChangeRefs,
          gitWriteTracker,
          toolName: "file_change",
          toolUseId: id,
        });
        emitToolCall(sessionCtx, {
          toolUseId: id,
          name: "file_change",
          args: { changes },
          status,
          toolFileRefs,
        });
        return;
      }
      case "mcpToolCall": {
        const status = toolStatus(item.status);
        const error = asRecord(item.error);
        const result = asRecord(item.result);
        const resultPreview = error
          ? `error: ${typeof error.message === "string" ? error.message : JSON.stringify(error)}`
          : result
            ? JSON.stringify(result.structuredContent ?? result.structured_content ?? result.content)
            : undefined;
        emitToolCall(sessionCtx, {
          toolUseId: id,
          name: `mcp:${typeof item.server === "string" ? item.server : "unknown"}/${
            typeof item.tool === "string" ? item.tool : "unknown"
          }`,
          args: item.arguments,
          status,
          resultPreview,
        });
        return;
      }
      case "webSearch": {
        emitToolCall(sessionCtx, {
          toolUseId: id,
          name: "web_search",
          args: { query: typeof item.query === "string" ? item.query : "" },
          status: "ok",
        });
        return;
      }
      case "plan": {
        emitToolCall(sessionCtx, {
          toolUseId: id,
          name: "todo_list",
          args: { text: typeof item.text === "string" ? item.text : "" },
          status: "ok",
        });
        return;
      }
      case "reasoning": {
        sessionCtx.emitEvent({ kind: "thinking", payload: {} });
        return;
      }
      default:
        return;
    }
  }

  function handleNotification(notification: CodexAppServerNotification): void {
    const sessionCtx = ctx;
    if (!sessionCtx) return;
    sessionCtx.recordProviderActivity();
    const params = asRecord(notification.params);
    const notificationThreadId = params ? (readString(params, "threadId") ?? readString(params, "thread_id")) : null;
    const notificationTurnId =
      params && asRecord(params.turn)
        ? readString(asRecord(params.turn), "id")
        : params
          ? (readString(params, "turnId") ?? readString(params, "turn_id"))
          : null;

    if (threadId && notificationThreadId && notificationThreadId !== threadId) return;

    const turn = currentTurn;
    if (notificationTurnId && (!turn || turn.turnId !== notificationTurnId)) {
      bufferNotification(notificationTurnId, notification);
      return;
    }
    applyNotification(notification, sessionCtx, turn);
  }

  function applyNotification(
    notification: CodexAppServerNotification,
    sessionCtx: SessionContext,
    turn: CurrentTurn | null,
  ): void {
    const params = asRecord(notification.params);
    if (!params) return;

    switch (notification.method) {
      case "item/completed": {
        const item = asRecord(params.item);
        if (item && turn) processItem(item, sessionCtx, turn);
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = parseTokenUsage(asRecord(params.tokenUsage));
        if (usage && turn) turn.usageLast = usage;
        return;
      }
      case "error": {
        const error = parseTurnError(params.error);
        if (error) {
          sessionCtx.emitEvent({
            kind: "error",
            payload: { source: "sdk", message: formatAppServerError(error.message) },
          });
        }
        return;
      }
      case "turn/completed": {
        if (!turn) return;
        const terminal = asRecord(params.turn);
        settleTerminalNotification(terminal, sessionCtx, turn);
        return;
      }
      default:
        return;
    }
  }

  function settleTerminalNotification(
    terminal: JsonRecord | null,
    sessionCtx: SessionContext,
    turn: CurrentTurn,
  ): void {
    if (terminal) {
      const items = Array.isArray(terminal.items) ? terminal.items : [];
      for (const item of items) {
        const record = asRecord(item);
        if (record) processItem(record, sessionCtx, turn);
      }
      const status = readString(terminal, "status");
      if (status === "completed") {
        turn.status = "completed";
        turn.providerCompleted = true;
      } else if (status === "failed") {
        turn.status = "failed";
        turn.failure = parseTurnError(terminal.error) ?? {
          message: "codex app-server turn failed",
          codexErrorInfo: null,
          additionalDetails: null,
        };
      } else if (status === "interrupted") {
        turn.status = "interrupted";
        turn.failure = parseTurnError(terminal.error) ?? {
          message: "codex app-server turn interrupted",
          codexErrorInfo: null,
          additionalDetails: null,
        };
      }
    }
    turn.resolveTerminal();
  }

  function replayBufferedNotifications(turn: CurrentTurn, sessionCtx: SessionContext): void {
    const buffered = pendingNotificationsByTurn.get(turn.turnId);
    if (!buffered) return;
    pendingNotificationsByTurn.delete(turn.turnId);
    for (const notification of buffered) applyNotification(notification, sessionCtx, turn);
  }

  function bufferNotification(turnId: string, notification: CodexAppServerNotification): void {
    const list = pendingNotificationsByTurn.get(turnId) ?? [];
    list.push(notification);
    pendingNotificationsByTurn.set(turnId, list);
  }

  function handleTransportClose(error: CodexAppServerTransportError): void {
    const sessionCtx = ctx;
    const turn = currentTurn;
    if (sessionCtx) {
      sessionCtx.log(`codex app-server transport closed: ${error.message}`);
    }
    if (turn && turn.status === "inProgress" && !turn.stopRequested) {
      turn.failure = { message: error.message, codexErrorInfo: null, additionalDetails: null };
      turn.status = "failed";
      turn.resolveTerminal();
    }
  }

  async function closeAppServerAfterUnknownCustody(
    sessionCtx: SessionContext,
    reason: string,
    err: unknown,
  ): Promise<void> {
    shutdownRequested = true;
    retryQueuedMessages(reason);
    const client = appServer;
    appServer = null;
    threadId = null;
    pendingNotificationsByTurn.clear();
    sessionCtx.log(
      `codex app-server session closed after unknown input custody (${reason}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    await client?.shutdown();
  }

  async function runTurnFromText(
    inputText: string,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
    sessionCtx: SessionContext,
  ): Promise<void> {
    const client = appServer;
    if (!client || !threadId) {
      token.retry(messages, "codex_app_server_missing_thread");
      return;
    }
    if (shutdownRequested) {
      token.retry(messages, "codex_app_server_shutdown_before_turn_start");
      return;
    }

    gitWriteTracker.captureBaseline();
    let result: unknown;
    try {
      result = await client.request("turn/start", {
        threadId,
        input: [textInput(inputText)],
        ...(cwd ? { cwd } : {}),
        approvalPolicy: "never",
        model: currentModel || null,
        effort: currentReasoningEffort,
      });
    } catch (err) {
      const reason = isCodexAppServerTransientError(err)
        ? "codex_app_server_turn_start_unknown_custody_transient"
        : "codex_app_server_turn_start_unknown_custody_failed";
      token.retry(messages, reason);
      await closeAppServerAfterUnknownCustody(sessionCtx, reason, err);
      return;
    }

    const turnRecord = asRecord(asRecord(result)?.turn);
    const turnId = turnRecord ? readString(turnRecord, "id") : null;
    if (!turnId) {
      const reason = "codex_app_server_turn_start_missing_id_unknown_custody";
      token.retry(messages, reason);
      await closeAppServerAfterUnknownCustody(sessionCtx, reason, "missing turn id in turn/start response");
      return;
    }

    const turn = await createCurrentTurn(turnId, messages, token, sessionCtx);
    if (turnRecord && readString(turnRecord, "status") !== "inProgress") {
      settleTerminalNotification(turnRecord, sessionCtx, turn);
    }
    replayBufferedNotifications(turn, sessionCtx);
    await currentTurnPromise;
    turnSettlementInProgress = true;
    try {
      await settleTurn(turn, sessionCtx);
    } finally {
      turnSettlementInProgress = false;
      schedulePostTurnDrain();
    }
  }

  async function createCurrentTurn(
    turnId: string,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
    sessionCtx: SessionContext,
  ): Promise<CurrentTurn> {
    let resolveTerminal: () => void = () => {};
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const turn: CurrentTurn = {
      turnId,
      status: "inProgress",
      primaryToken: token,
      acceptedMessages: [...messages],
      finalAgentText: "",
      completedItemIds: new Set(),
      usageLast: null,
      failure: null,
      providerCompleted: false,
      stopRequested: false,
      resolveTerminal,
    };
    currentTurn = turn;
    token.processingStarted(messages);
    currentTurnPromise = terminalPromise.finally(() => {
      currentTurnPromise = null;
      currentTurn = null;
    });
    sessionCtx.log(`codex app-server turn started turnId=${turnId} accepted=${messages.length}`);
    scheduleSteerDrain();
    return turn;
  }

  async function failCurrentTurnAfterUnknownSteer(
    turn: CurrentTurn,
    entry: QueueEntry,
    reason: string,
    err: unknown,
    sessionCtx: SessionContext,
  ): Promise<void> {
    turn.stopRequested = true;
    turn.status = "failed";
    turn.failure = {
      message: err instanceof Error ? err.message : String(err),
      codexErrorInfo: null,
      additionalDetails: "turn/steer input custody is unknown; app-server session was closed",
    };
    turn.resolveTerminal();
    turn.primaryToken.retry([...turn.acceptedMessages, entry.message], reason);
    await closeAppServerAfterUnknownCustody(sessionCtx, reason, err);
  }

  async function settleTurn(turn: CurrentTurn, sessionCtx: SessionContext): Promise<void> {
    if (turn.stopRequested || shutdownRequested) {
      schedulePostTurnDrain();
      return;
    }

    const completedSuccessfully = turn.providerCompleted && turn.failure === null && turn.status === "completed";
    const usage = turn.usageLast;
    const zeroTokenDelta =
      usage !== null &&
      usage.inputTokens === 0 &&
      usage.cachedInputTokens === 0 &&
      usage.outputTokens === 0 &&
      usage.reasoningOutputTokens === 0;
    const usageLimitEmptyTurn = completedSuccessfully && turn.finalAgentText.trim().length === 0 && zeroTokenDelta;
    const usageLimitFailure = turn.failure ? isUsageLimitErrorInfo(turn.failure.codexErrorInfo) : false;

    let forwardFailed = false;
    let retryReason: string | null = null;
    let consumedErrorReason: TurnConsumedErrorReason | null = null;

    if (usageLimitEmptyTurn || usageLimitFailure) {
      sessionCtx.emitEvent({
        kind: "error",
        payload: {
          source: "runtime",
          message: "codex usage limit reached: turn completed without a usable model response",
        },
      });
      try {
        await sessionCtx.forwardResult(USAGE_LIMIT_NOTICE);
        consumedErrorReason = "usage_limit_notice_posted";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sessionCtx.emitEvent({
          kind: "error",
          payload: { source: "runtime", message: `usage-limit notice delivery failed: ${msg}` },
        });
        retryReason = "codex_usage_limit_notice_delivery_failed";
      }
    } else if (completedSuccessfully && turn.finalAgentText.trim()) {
      try {
        await sessionCtx.forwardResult(turn.finalAgentText);
      } catch (err) {
        forwardFailed = true;
        const msg = err instanceof Error ? err.message : String(err);
        sessionCtx.emitEvent({
          kind: "error",
          payload: { source: "runtime", message: `forwardResult failed: ${msg}` },
        });
      }
    } else if (turn.failure) {
      const kind = classifyAppServerFailure(turn.failure);
      retryReason = `codex_${kind}_failure`;
      sessionCtx.log(`codex app-server turn failed (${kind}): ${turn.failure.message}`);
    } else if (!turn.providerCompleted) {
      retryReason = "codex_app_server_stream_ended_without_completion";
    }

    const settlement = resolveTurnSettlement({
      retryReason,
      consumedErrorReason,
      forwardFailed,
    });

    if (usage) {
      sessionCtx.emitEvent({
        kind: "token_usage",
        payload: {
          provider: "codex",
          model: currentModel || "codex-default",
          inputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
        },
      });
    }
    sessionCtx.emitEvent({ kind: "turn_end", payload: { status: settlement.status } });

    if (settlement.action.kind === "complete") {
      await turn.primaryToken.complete(turn.acceptedMessages, settlement.action.outcome);
    } else {
      turn.primaryToken.retry(turn.acceptedMessages, settlement.action.reason);
    }
    schedulePostTurnDrain();
  }

  function scheduleSteerDrain(): void {
    if (drainSteerScheduled || drainSteerInProgress) return;
    drainSteerScheduled = true;
    setImmediate(() => {
      drainSteerScheduled = false;
      void drainSteerQueue();
    });
  }

  async function drainSteerQueue(): Promise<void> {
    if (drainSteerInProgress) return;
    const sessionCtx = ctx;
    if (!sessionCtx) return;
    drainSteerInProgress = true;
    try {
      while (steerQueue.length > 0 && !shutdownRequested) {
        const entry = steerQueue.shift();
        if (!entry) continue;
        let text: string;
        try {
          text = await sessionCtx.formatInboundContent(entry.message);
        } catch (err) {
          sessionCtx.log(
            `codex app-server inject formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          entry.token.retry(entry.message, "codex_queued_turn_format_failed");
          continue;
        }

        const turn = currentTurn;
        const client = appServer;
        if (!client || !threadId || (!turn && startupTurnPending)) {
          steerQueue.unshift(entry);
          return;
        }
        if (!turn || turn.status !== "inProgress") {
          postTurnQueue.push(entry);
          schedulePostTurnDrain();
          continue;
        }

        try {
          await client.request("turn/steer", {
            threadId,
            expectedTurnId: turn.turnId,
            input: [textInput(text)],
          });
          entry.token.processingStarted(entry.message);
          turn.acceptedMessages.push(entry.message);
        } catch (err) {
          if (shouldFallbackSteerToNextTurn(err)) {
            postTurnQueue.push(entry);
            schedulePostTurnDrain();
          } else {
            const reason = isCodexAppServerTransientError(err)
              ? "codex_app_server_steer_unknown_custody_transient"
              : "codex_app_server_steer_unknown_custody_failed";
            await failCurrentTurnAfterUnknownSteer(turn, entry, reason, err, sessionCtx);
            return;
          }
        }
      }
    } finally {
      drainSteerInProgress = false;
    }
  }

  function schedulePostTurnDrain(): void {
    if (drainPostTurnScheduled || drainPostTurnInProgress) return;
    if (currentTurnPromise || turnSettlementInProgress || postTurnQueue.length === 0 || shutdownRequested) return;
    if (!appServer || !threadId || startupTurnPending) return;
    drainPostTurnScheduled = true;
    setImmediate(() => {
      drainPostTurnScheduled = false;
      void drainPostTurnQueue();
    });
  }

  async function drainPostTurnQueue(): Promise<void> {
    if (drainPostTurnInProgress || currentTurnPromise || shutdownRequested) return;
    if (!appServer || !threadId || startupTurnPending) return;
    const sessionCtx = ctx;
    if (!sessionCtx) return;
    const drained = postTurnQueue.splice(0);
    if (drained.length === 0) return;
    drainPostTurnInProgress = true;
    try {
      const texts: string[] = [];
      let hadFormatFailure = false;
      for (const entry of drained) {
        try {
          texts.push(await sessionCtx.formatInboundContent(entry.message));
        } catch (err) {
          hadFormatFailure = true;
          sessionCtx.log(
            `codex app-server post-turn formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (hadFormatFailure || texts.length === 0) {
        for (const entry of drained) entry.token.retry(entry.message, "codex_queued_turn_format_failed");
        return;
      }
      const token = drained[0]?.token;
      if (!token) return;
      await runTurnFromText(
        texts.join("\n\n"),
        drained.map((entry) => entry.message),
        token,
        sessionCtx,
      );
    } finally {
      drainPostTurnInProgress = false;
      schedulePostTurnDrain();
    }
  }

  function retryQueuedMessages(reason: string): void {
    const queued = [...steerQueue.splice(0), ...postTurnQueue.splice(0)];
    for (const entry of queued) entry.token.retry(entry.message, reason);
  }

  async function interruptCurrentTurn(): Promise<void> {
    const turn = currentTurn;
    const client = appServer;
    if (!turn || !threadId || !client) return;
    turn.stopRequested = true;
    try {
      await client.request("turn/interrupt", { threadId, turnId: turn.turnId }, 2_000);
    } catch (err) {
      ctx?.log(`codex app-server turn interrupt failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      turn.resolveTerminal();
    }
  }

  function requireAppServer(): AppServerClientLike {
    if (!appServer) throw new CodexAppServerStartupError("client", "missing app-server client");
    return appServer;
  }

  return {
    async start(message, sessionCtx, token) {
      const hasExplicitDeliveryToken = token !== undefined;
      const deliveryToken = token ?? deliveryTokenFromSessionContext(sessionCtx);
      shutdownRequested = false;
      startupTurnPending = true;
      ctx = sessionCtx;
      try {
        const { payload, env } = await prepareSession(sessionCtx);
        await startAppServer(sessionCtx, env);
        const id = await startThread(payload);
        let input: string;
        try {
          input = await sessionCtx.formatInboundContent(message);
        } catch (err) {
          deliveryToken.retry(message, "codex_app_server_initial_format_failed");
          sessionCtx.log(
            `codex app-server initial formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return hasExplicitDeliveryToken ? { sessionId: id, route: { kind: "owned", mode: "queued" } } : id;
        }
        await runTurnFromText(input, [message], deliveryToken, sessionCtx);
        return hasExplicitDeliveryToken ? { sessionId: id, route: { kind: "owned", mode: "processing" } } : id;
      } finally {
        startupTurnPending = false;
        scheduleSteerDrain();
        schedulePostTurnDrain();
      }
    },

    async resume(message, sessionId, sessionCtx, token) {
      const hasExplicitDeliveryToken = token !== undefined;
      const deliveryToken = token ?? deliveryTokenFromSessionContext(sessionCtx);
      shutdownRequested = false;
      startupTurnPending = message !== undefined;
      ctx = sessionCtx;
      try {
        const { payload, env } = await prepareSession(sessionCtx);
        await startAppServer(sessionCtx, env);
        await resumeThread(sessionId, payload);
        if (message) {
          let input: string;
          try {
            input = await sessionCtx.formatInboundContent(message);
          } catch (err) {
            deliveryToken.retry(message, "codex_app_server_initial_format_failed");
            sessionCtx.log(
              `codex app-server resume formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return hasExplicitDeliveryToken ? { sessionId, route: { kind: "owned", mode: "queued" } } : sessionId;
          }
          await runTurnFromText(input, [message], deliveryToken, sessionCtx);
        }
        return hasExplicitDeliveryToken
          ? { sessionId, route: message ? { kind: "owned", mode: "processing" } : null }
          : sessionId;
      } finally {
        startupTurnPending = false;
        scheduleSteerDrain();
        schedulePostTurnDrain();
      }
    },

    inject(message, token) {
      if (!ctx || shutdownRequested) return { kind: "rejected", reason: "no_active_context", retryable: true };
      const deliveryToken = token ?? deliveryTokenFromSessionContext(ctx);
      steerQueue.push({ message, token: deliveryToken });
      scheduleSteerDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend() {
      startupTurnPending = false;
      retryQueuedMessages("codex_suspend_before_terminal");
      await interruptCurrentTurn();
      await appServer?.shutdown();
      appServer = null;
    },

    async shutdown() {
      shutdownRequested = true;
      retryQueuedMessages("codex_shutdown_before_terminal");
      await interruptCurrentTurn();
      await appServer?.shutdown();
      appServer = null;
      currentTurn = null;
      currentTurnPromise = null;
      startupTurnPending = false;
      pendingNotificationsByTurn.clear();
      cwd = null;
      threadId = null;
      ctx = null;
    },
  } satisfies AgentHandler;
};

function defaultClientFactory(options: CodexAppServerClientOptions): Promise<AppServerClientLike> {
  return CodexAppServerClient.start(options);
}

function readClientFactory(value: unknown): AppServerClientFactory | null {
  if (typeof value !== "function") return null;
  // HandlerConfig is intentionally extension-shaped; the runtime does not know
  // test seams. Guard the callable shape before using it.
  return value as AppServerClientFactory;
}

function readRuntimeBinaryResolver(value: unknown): RuntimeBinaryResolver | null {
  if (typeof value !== "function") return null;
  // Same HandlerConfig extension seam as readClientFactory.
  return value as RuntimeBinaryResolver;
}

function textInput(text: string): JsonRecord {
  return { type: "text", text, text_elements: [] };
}

function extractThreadId(result: unknown): string | null {
  const root = asRecord(result);
  const thread = asRecord(root?.thread);
  return thread ? readString(thread, "id") : null;
}

function parseTokenUsage(value: JsonRecord | null): TokenUsageBreakdown | null {
  const last = asRecord(value?.last);
  if (!last) return null;
  return {
    totalTokens: readNumber(last, "totalTokens") ?? 0,
    inputTokens: readNumber(last, "inputTokens") ?? 0,
    cachedInputTokens: readNumber(last, "cachedInputTokens") ?? 0,
    outputTokens: readNumber(last, "outputTokens") ?? 0,
    reasoningOutputTokens: readNumber(last, "reasoningOutputTokens") ?? 0,
  };
}

function parseTurnError(value: unknown): TurnErrorInfo | null {
  const record = asRecord(value);
  if (!record) return null;
  const message = readString(record, "message");
  if (!message) return null;
  return {
    message,
    codexErrorInfo: record.codexErrorInfo ?? null,
    additionalDetails: readString(record, "additionalDetails"),
  };
}

function formatAppServerError(message: string): string {
  if (isCodexAuthError(message)) return formatAuthHint("codex", message);
  return message;
}

function classifyAppServerFailure(error: TurnErrorInfo): "deterministic" | "transient" | "unknown" {
  if (isCodexAuthError(error.message) || isDeterministicErrorInfo(error.codexErrorInfo)) return "deterministic";
  if (isTransientCodexErrorMessage(error.message) || isTransientErrorInfo(error.codexErrorInfo)) return "transient";
  return "unknown";
}

function isUsageLimitErrorInfo(value: unknown): boolean {
  return value === "usageLimitExceeded";
}

function isDeterministicErrorInfo(value: unknown): boolean {
  return (
    value === "contextWindowExceeded" ||
    value === "unauthorized" ||
    value === "badRequest" ||
    value === "sandboxError" ||
    value === "cyberPolicy"
  );
}

function isTransientErrorInfo(value: unknown): boolean {
  if (value === "serverOverloaded" || value === "internalServerError") return true;
  const record = asRecord(value);
  if (!record) return false;
  return (
    "httpConnectionFailed" in record ||
    "responseStreamConnectionFailed" in record ||
    "responseStreamDisconnected" in record
  );
}

function shouldFallbackSteerToNextTurn(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (
    message.includes("no active turn") ||
    message.includes("expectedturnid") ||
    message.includes("expected turn") ||
    message.includes("turn mismatch") ||
    message.includes("active turn not steerable") ||
    message.includes("activeturnnotsteerable")
  ) {
    return true;
  }
  if (err instanceof CodexAppServerRpcError) {
    return containsActiveTurnNotSteerable(err.data);
  }
  return false;
}

function containsActiveTurnNotSteerable(value: unknown): boolean {
  if (value === "activeTurnNotSteerable") return true;
  if (Array.isArray(value)) return value.some((item) => containsActiveTurnNotSteerable(item));
  const record = asRecord(value);
  if (!record) return false;
  return Object.entries(record).some(
    ([key, nested]) => key === "activeTurnNotSteerable" || containsActiveTurnNotSteerable(nested),
  );
}

function toolStatus(value: unknown): "ok" | "error" | "pending" {
  if (value === "completed") return "ok";
  if (value === "failed" || value === "declined") return "error";
  return "pending";
}

function contextTreeTargetPathOf(
  filePath: string,
  attribution: ContextTreeAttribution,
  workspaceCwd: string,
): string | null {
  const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(workspaceCwd, filePath);
  const rel = resolveContextTreeRelativePath(absolutePath, attribution);
  return rel === null || rel === "/" ? null : rel;
}

function toolFileRefsFromAppServerFileChange(input: {
  changes: unknown;
  workspaceCwd: string;
  contextTreePath: string | null;
  contextTreeRepoUrl: string | null;
  contextTreeBranch?: string | null;
}): ToolFileRef[] {
  const refs: ToolFileRef[] = [];
  const seen = new Set<string>();
  for (const filePath of collectCodexFileChangePaths(input.changes)) {
    const fileKey = isAbsolute(filePath) ? filePath : resolve(input.workspaceCwd, filePath);
    if (seen.has(fileKey)) continue;
    seen.add(fileKey);
    const repoRelativePath = contextTreeTargetPathOf(
      filePath,
      { contextTreePath: input.contextTreePath, contextTreeRepoUrl: input.contextTreeRepoUrl },
      input.workspaceCwd,
    );
    refs.push({
      origin: "file_change",
      localPath: filePath,
      pathKind: "file",
      ...(input.contextTreeRepoUrl && repoRelativePath
        ? {
            repoUrl: input.contextTreeRepoUrl,
            ...(input.contextTreeBranch ? { repoBranch: input.contextTreeBranch } : {}),
            repoRelativePath,
          }
        : {}),
    });
  }
  return refs;
}

function toolFileRefsForTerminalTool(input: {
  status: "ok" | "error" | "pending";
  existingRefs?: readonly ToolFileRef[];
  gitWriteTracker?: ContextTreeGitWriteTracker | null;
  toolName: string;
  toolUseId: string;
}): ToolFileRef[] | undefined {
  if (input.status !== "ok") {
    if (input.status === "error") input.gitWriteTracker?.captureBaseline();
    return undefined;
  }
  const existingRefs = [...(input.existingRefs ?? [])];
  const gitStatusRefs =
    input.gitWriteTracker?.refsForSuccessfulToolCall({
      toolName: input.toolName,
      toolUseId: input.toolUseId,
      existingRefs,
    }) ?? [];
  const refs = [...existingRefs, ...gitStatusRefs];
  return refs.length > 0 ? refs : undefined;
}

function readString(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function readNumber(record: JsonRecord, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // App-server payloads enter as unknown JSON; all individual fields are
  // narrowed before use.
  return value as JsonRecord;
}
