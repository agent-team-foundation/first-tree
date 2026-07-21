import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type CreateSessionOptions,
  createKimiHarness,
  type Event as KimiEvent,
  type KimiHarness,
  type KimiHarnessOptions,
  LocalKaos,
  type ResumeSessionInput,
  type Session,
  type SessionUsage,
  type TokenUsage,
} from "@botiverse/kimi-code-sdk";
import {
  type AgentRuntimeConfigPayload,
  classifyShellCommandIo,
  DEFAULT_KIMI_CODE_RUNTIME_CONFIG_PAYLOAD,
  encodeProviderRetryEventMessage,
  isLandingCampaignTrialAgentMetadata,
  runtimeProviderSchema,
  type ToolFileRef,
} from "@first-tree/shared";
import { ensureAgentBootstrap } from "../runtime/agent-bootstrap.js";
import { buildAgentBriefing } from "../runtime/agent-briefing.js";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import type { PredeclaredSourceRepo } from "../runtime/bootstrap.js";
import { fetchChatContext } from "../runtime/chat-context.js";
import { renderChatContextPrompt, renderRuntimeOutputContract } from "../runtime/chat-context-section.js";
import {
  type ContextTreeAttribution,
  resolveContextTreeRelativePath,
  toolFileRefsFromShellCommand,
} from "../runtime/context-tree-file-refs.js";
import {
  type ContextTreeGitWriteTracker,
  createContextTreeGitWriteTracker,
} from "../runtime/context-tree-git-status.js";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerFactory,
  SessionContext,
  SessionMessage,
} from "../runtime/handler.js";
import { deliveryTokenFromSessionContext } from "../runtime/handler.js";
import { ProviderAttempt, type ProviderAttemptSettlement } from "../runtime/provider-attempt.js";
import { maxProviderTurnRetryAttempts } from "../runtime/provider-retry-policy.js";
import { materializeResourceSkills } from "../runtime/resource-skills.js";
import { currentSourceRepoNamesFromPayload, declaredSourceRepos } from "../runtime/source-repos.js";
import { acquireAgentHome, markWorkspaceInitComplete } from "../runtime/workspace.js";
import { chunkAssistantText } from "./assistant-text.js";
import { formatAuthHint, isKimiCodeAuthError } from "./auth-error-hint.js";

const RESULT_PREVIEW_LIMIT = 400;
const KIMI_IDENTITY_VERSION = "0.1.2";

type KimiHarnessLike = Pick<KimiHarness, "createSession" | "resumeSession" | "close">;
type KimiHarnessFactory = (options: KimiHarnessOptions) => KimiHarnessLike;
type KimiKaosFactory = () => Promise<LocalKaos>;

type ActiveTool = {
  name: string;
  args: unknown;
  startedAt: number;
  refs: ToolFileRef[];
};

type TurnObservation = {
  assistantText: string;
  ended: Extract<KimiEvent, { type: "turn.ended" }> | null;
  error: Error | null;
  thinkingEmitted: boolean;
  unsafeToolEffectStarted: boolean;
};

type PreparedSession = {
  payload: AgentRuntimeConfigPayload;
  workspaceCwd: string;
  roleAdditional: string;
  additionalDirs: string[];
  kaos: LocalKaos;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function preview(value: unknown): string {
  if (typeof value === "string") return value.slice(0, RESULT_PREVIEW_LIMIT);
  try {
    return JSON.stringify(value).slice(0, RESULT_PREVIEW_LIMIT);
  } catch {
    return String(value).slice(0, RESULT_PREVIEW_LIMIT);
  }
}

function kimiEventError(event: { code: string; message: string; retryable?: boolean }): Error {
  const error = new Error(event.message) as Error & { code?: string; reason?: string; retryable?: boolean };
  error.name = "KimiCodeError";
  error.code = event.code;
  error.reason = event.code;
  error.retryable = event.retryable;
  return error;
}

export function formatKimiCodeError(error: Error): string {
  const record = error as Error & { code?: string };
  const combined = `${record.code ?? ""} ${error.message}`.trim();
  return isKimiCodeAuthError(combined) ? formatAuthHint("kimi-code", combined) : combined;
}

export function kimiToolIsReadOnly(name: string, args: unknown): boolean {
  if (name === "Read" || name === "Grep" || name === "Glob") return true;
  if (name !== "Bash") return false;
  const command = asRecord(args)?.command;
  if (typeof command !== "string") return false;
  const classification = classifyShellCommandIo(command);
  return classification.supported && classification.action === "read";
}

function inputPathForTool(name: string, args: unknown): string | null {
  const record = asRecord(args);
  if (!record) return null;
  const keys = name === "Grep" || name === "Glob" ? ["path", "cwd", "directory"] : ["path", "file_path", "filePath"];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function additionalDirectories(workspaceCwd: string, contextTreePath: string | null): string[] {
  if (!contextTreePath) return [];

  // Declared source repos and the managed Context Tree are descendants of the
  // agent workspace, so Kimi's workDir already grants access to them. They may
  // legitimately be absent until the agent follows the briefing and clones
  // them; passing those paths as additionalDirs would make the SDK reject the
  // session before the agent has a chance to materialize them.
  const workspace = resolve(workspaceCwd);
  const candidate = resolve(contextTreePath);
  const fromWorkspace = relative(workspace, candidate);
  const insideWorkspace =
    fromWorkspace === "" ||
    (fromWorkspace !== ".." && !fromWorkspace.startsWith(`..${sep}`) && !isAbsolute(fromWorkspace));
  if (insideWorkspace) return [];

  // Keep compatibility with an explicitly configured external tree, but only
  // grant a root the SDK can validate at session construction time.
  try {
    return statSync(candidate).isDirectory() ? [candidate] : [];
  } catch {
    return [];
  }
}

/** Kimi Code handler backed by the direct Botiverse/Moonshot Node SDK. */
export const createKimiCodeHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot;
  const runtimeProvider = runtimeProviderSchema.parse(config.runtimeProvider ?? "kimi-code");
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const contextTreePath = (config.contextTreePath as string | undefined) ?? null;
  const contextTreeRepoUrl = (config.contextTreeRepoUrl as string | undefined) ?? null;
  const contextTreeBranch = (config.contextTreeBranch as string | undefined) ?? null;
  const harnessFactory = (config.kimiHarnessFactory as KimiHarnessFactory | undefined) ?? createKimiHarness;
  const kaosFactory = (config.kimiKaosFactory as KimiKaosFactory | undefined) ?? (() => LocalKaos.create());
  const maxRetries = maxProviderTurnRetryAttempts();

  let cwd: string | null = null;
  let ctx: SessionContext | null = null;
  let harness: KimiHarnessLike | null = null;
  let session: Session | null = null;
  let sessionId: string | null = null;
  let activePayload: AgentRuntimeConfigPayload | null = null;
  let sourceReposForPrompt: PredeclaredSourceRepo[] = [];
  let sessionActive = false;
  let initialTurnPreparing = false;
  let currentTurnPromise: Promise<boolean> | null = null;
  let drainScheduled = false;
  let drainInProgress = false;
  let mcpDiagnosticEmitted = false;
  const queuedMessages: Array<{ message: SessionMessage; token: DeliveryToken }> = [];
  const activeTools = new Map<string, ActiveTool>();
  const gitWriteTracker: ContextTreeGitWriteTracker = createContextTreeGitWriteTracker({
    contextTreePath,
    contextTreeRepoUrl,
    contextTreeBranch,
    log: (message) => ctx?.log(message),
  });

  function emitSettlement(sessionCtx: SessionContext, settlement: ProviderAttemptSettlement): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: { source: "runtime", message: encodeProviderRetryEventMessage(settlement.eventPayload) },
    });
  }

  function buildEnv(sessionCtx: SessionContext, payload: AgentRuntimeConfigPayload): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    for (const entry of payload.env) env[entry.key] = entry.value;
    const merged = sessionCtx.buildAgentEnv(env);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(merged)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }

  function buildBriefing(sessionCtx: SessionContext, payload: AgentRuntimeConfigPayload, workspaceCwd: string): string {
    return buildAgentBriefing({
      identity: sessionCtx.agent,
      payload,
      workspacePath: workspaceCwd,
      sourceRepos: sourceReposForPrompt,
      contextTreePath,
      contextTreeRepoUrl,
      contextTreeBranch,
    });
  }

  async function fetchChatContextOrLog(sessionCtx: SessionContext): Promise<string | null> {
    try {
      return renderChatContextPrompt(await fetchChatContext(sessionCtx.sdk, sessionCtx.chatId, sessionCtx.agent));
    } catch (error) {
      sessionCtx.log(`fetchChatContext failed: ${error instanceof Error ? error.message : String(error)}`);
      return renderChatContextPrompt(undefined);
    }
  }

  function emitMcpUnsupportedDiagnosticOnce(sessionCtx: SessionContext, payload: AgentRuntimeConfigPayload): void {
    if (mcpDiagnosticEmitted || payload.mcpServers.length === 0) return;
    mcpDiagnosticEmitted = true;
    sessionCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message:
          `kimi-code provider does not materialize First Tree-managed MCP servers in v1; ` +
          `${payload.mcpServers.length} configured MCP server(s) are not loaded. ` +
          "The operator's own Kimi MCP configuration still applies.",
      },
    });
  }

  function nativeToolRefs(name: string, args: unknown, workspaceCwd: string): ToolFileRef[] {
    if (name === "Bash") {
      const command = asRecord(args)?.command;
      if (typeof command !== "string") return [];
      const commandCwd = asRecord(args)?.cwd;
      return toolFileRefsFromShellCommand({
        command,
        cwd: typeof commandCwd === "string" ? commandCwd : workspaceCwd,
        contextTreePath,
        contextTreeRepoUrl,
        contextTreeBranch,
      });
    }

    const filePath = inputPathForTool(name, args);
    if (!filePath) return [];
    const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(workspaceCwd, filePath);
    const attribution: ContextTreeAttribution = { contextTreePath, contextTreeRepoUrl };
    const repoRelativePath = resolveContextTreeRelativePath(absolutePath, attribution);
    const pathKind = name === "Grep" || name === "Glob" ? ("directory" as const) : ("file" as const);
    return [
      {
        origin: "tool_arg",
        localPath: absolutePath,
        pathKind,
        ...(contextTreeRepoUrl && repoRelativePath
          ? {
              repoUrl: contextTreeRepoUrl,
              ...(contextTreeBranch ? { repoBranch: contextTreeBranch } : {}),
              repoRelativePath,
            }
          : {}),
      },
    ];
  }

  function emitToolCall(
    sessionCtx: SessionContext,
    toolUseId: string,
    tool: ActiveTool,
    status: "pending" | "ok" | "error",
    result?: unknown,
  ): void {
    const refs = status === "ok" ? [...tool.refs] : [];
    if (status === "ok") {
      refs.push(
        ...gitWriteTracker.refsForSuccessfulToolCall({
          toolName: tool.name,
          toolUseId,
          existingRefs: refs,
        }),
      );
    } else if (status === "error") {
      gitWriteTracker.captureBaseline();
    }
    sessionCtx.emitEvent({
      kind: "tool_call",
      payload: {
        toolUseId,
        name: tool.name,
        args: tool.args,
        status,
        ...(status !== "pending" ? { durationMs: Math.max(0, Date.now() - tool.startedAt) } : {}),
        ...(result !== undefined ? { resultPreview: preview(result) } : {}),
        ...(refs.length > 0 ? { toolFileRefs: refs } : {}),
      },
    });
  }

  function processKimiEvent(
    event: KimiEvent,
    sessionCtx: SessionContext,
    attempt: ProviderAttempt,
    observation: TurnObservation,
    resolveEnded: () => void,
  ): void {
    sessionCtx.recordProviderActivity();
    switch (event.type) {
      case "turn.started":
        if (!observation.unsafeToolEffectStarted) attempt.setReplaySafety("pre_visible");
        break;
      case "assistant.delta":
        observation.assistantText += event.delta;
        break;
      case "thinking.delta":
        if (!observation.thinkingEmitted) {
          observation.thinkingEmitted = true;
          sessionCtx.emitEvent({ kind: "thinking", payload: {} });
        }
        break;
      case "tool.call.started": {
        const tool: ActiveTool = {
          name: event.name,
          args: event.args,
          startedAt: Date.now(),
          refs: cwd ? nativeToolRefs(event.name, event.args, cwd) : [],
        };
        activeTools.set(event.toolCallId, tool);
        if (!kimiToolIsReadOnly(event.name, event.args)) observation.unsafeToolEffectStarted = true;
        attempt.setReplaySafety(observation.unsafeToolEffectStarted ? "unsafe" : "pre_visible");
        emitToolCall(sessionCtx, event.toolCallId, tool, "pending");
        break;
      }
      case "tool.result": {
        const tool = activeTools.get(event.toolCallId);
        if (!tool) break;
        emitToolCall(sessionCtx, event.toolCallId, tool, event.isError ? "error" : "ok", event.output);
        activeTools.delete(event.toolCallId);
        break;
      }
      case "error":
        observation.error = kimiEventError(event);
        break;
      case "turn.ended":
        observation.ended = event;
        if (event.error) observation.error = kimiEventError(event.error);
        resolveEnded();
        break;
      default:
        break;
    }
  }

  async function observeOneAttempt(
    activeSession: Session,
    prompt: string,
    sessionCtx: SessionContext,
    attempt: ProviderAttempt,
  ): Promise<TurnObservation> {
    const observation: TurnObservation = {
      assistantText: "",
      ended: null,
      error: null,
      thinkingEmitted: false,
      unsafeToolEffectStarted: false,
    };
    let resolveEnded = (): void => {};
    const endedPromise = new Promise<void>((resolvePromise) => {
      resolveEnded = resolvePromise;
    });
    const unsubscribe = activeSession.onEvent((event) => {
      try {
        processKimiEvent(event, sessionCtx, attempt, observation, resolveEnded);
      } catch (error) {
        sessionCtx.log(`kimi event translation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    try {
      await activeSession.prompt(prompt);
      if (!observation.ended) await endedPromise;
      return observation;
    } finally {
      unsubscribe();
    }
  }

  async function readUsage(activeSession: Session, sessionCtx: SessionContext): Promise<SessionUsage | null> {
    let usage: SessionUsage;
    try {
      usage = await activeSession.getUsage();
    } catch (error) {
      sessionCtx.log(`kimi usage read failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    return usage;
  }

  function usageDelta(current: TokenUsage, baseline: TokenUsage | undefined): TokenUsage {
    return {
      inputOther: Math.max(0, current.inputOther - (baseline?.inputOther ?? 0)),
      inputCacheCreation: Math.max(0, current.inputCacheCreation - (baseline?.inputCacheCreation ?? 0)),
      inputCacheRead: Math.max(0, current.inputCacheRead - (baseline?.inputCacheRead ?? 0)),
      output: Math.max(0, current.output - (baseline?.output ?? 0)),
    };
  }

  async function emitUsage(
    sessionCtx: SessionContext,
    activeSession: Session,
    baseline: SessionUsage | null,
  ): Promise<void> {
    const usage = await readUsage(activeSession, sessionCtx);
    if (!usage) return;
    // `currentTurn` is optional and is absent in some managed:kimi-code
    // sessions. In that case `total` is cumulative, so subtract the reading
    // captured immediately before this First Tree turn.
    const turn = usage.currentTurn ?? (usage.total ? usageDelta(usage.total, baseline?.total) : undefined);
    if (!turn) return;
    sessionCtx.emitEvent({
      kind: "token_usage",
      payload: {
        provider: "kimi-code",
        model: activePayload?.model || "kimi-default",
        inputTokens: turn.inputOther + turn.inputCacheCreation,
        cachedInputTokens: turn.inputCacheRead,
        outputTokens: turn.output,
      },
    });
  }

  async function executeTurn(
    prompt: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
  ): Promise<boolean> {
    const activeSession = session;
    if (!activeSession || !sessionActive) {
      token.retry(messages, "kimi_session_inactive");
      return false;
    }
    token.processingStarted(messages);
    gitWriteTracker.captureBaseline();
    const usageBaseline = await readUsage(activeSession, sessionCtx);

    for (let attemptNumber = 1; attemptNumber <= maxRetries + 1; attemptNumber += 1) {
      if (!sessionActive) {
        token.retry(messages, "kimi_turn_cancelled");
        return false;
      }
      const attempt = new ProviderAttempt({
        provider: runtimeProvider,
        scope: "provider_turn",
        source: "sdk",
      });
      let observation: TurnObservation | null = null;
      let thrown: Error | null = null;
      try {
        observation = await observeOneAttempt(activeSession, prompt, sessionCtx, attempt);
      } catch (error) {
        thrown = error instanceof Error ? error : new Error(String(error));
      }

      if (!sessionActive) {
        token.retry(messages, "kimi_turn_cancelled");
        return false;
      }

      const endedSuccessfully = observation?.ended?.reason === "completed";
      if (endedSuccessfully) {
        const assistantText = observation?.assistantText ?? "";
        for (const [chunkIndex, chunk] of chunkAssistantText(assistantText).entries()) {
          if (chunk.trim()) {
            sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk, continuation: chunkIndex > 0 } });
          }
        }
        await emitUsage(sessionCtx, activeSession, usageBaseline);
        try {
          await sessionCtx.forwardResult(assistantText);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sessionCtx.emitEvent({
            kind: "error",
            payload: { source: "runtime", message: `forward failed: ${message}` },
          });
          sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
          await token.complete(messages, { status: "error", completion: "consumed", reason: "forward_failed" });
          return false;
        }
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
        await token.complete(messages, { status: "success" });
        return true;
      }

      const failure =
        thrown ?? observation?.error ?? new Error(`Kimi turn ended: ${observation?.ended?.reason ?? "unknown"}`);
      const classification = attempt.recordSignal({
        kind: thrown ? "local_error" : "provider_error",
        error: failure,
      });
      const retryable = (failure as Error & { retryable?: boolean }).retryable;
      if (
        classification?.reasonCode === "provider_rate_limited" &&
        retryable === true &&
        !observation?.unsafeToolEffectStarted
      ) {
        // Kimi marks provider.rate_limit as a retryable refusal. With no tool
        // side effect the provider did not take replay custody, so use the
        // shared pre-provider capacity budget instead of terminal waiting.
        attempt.setReplaySafety("pre_provider");
      }
      const settlement = attempt.settle({ attempt: attemptNumber });
      if (!settlement) {
        token.retry(messages, "kimi_unclassified_failure");
        return false;
      }
      emitSettlement(sessionCtx, settlement);
      if (settlement.decision.action === "retry") {
        const delayMs = settlement.decision.delayMs;
        sessionCtx.log(
          `kimi turn retry ${attemptNumber}/${maxRetries + 1} after ${delayMs}ms; ${settlement.messagePreview}`,
        );
        await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
        continue;
      }

      const formatted = formatKimiCodeError(failure);
      await emitUsage(sessionCtx, activeSession, usageBaseline);
      sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
      sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
      await token.complete(messages, {
        status: "error",
        completion: "consumed",
        reason: settlement.decision.reasonCode,
      });
      return false;
    }

    token.retry(messages, "kimi_retry_loop_exited");
    return false;
  }

  async function runTurn(
    prompt: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
  ): Promise<boolean> {
    const promise = executeTurn(prompt, sessionCtx, messages, token);
    currentTurnPromise = promise;
    try {
      return await promise;
    } finally {
      if (currentTurnPromise === promise) currentTurnPromise = null;
      scheduleQueuedMessagesDrain();
    }
  }

  async function mergeAndRun(
    drained: Array<{ message: SessionMessage; token: DeliveryToken }>,
    sessionCtx: SessionContext,
  ): Promise<void> {
    const prompts: string[] = [];
    let failed = false;
    for (const entry of drained) {
      try {
        prompts.push(await sessionCtx.formatInboundContent(entry.message));
      } catch (error) {
        failed = true;
        sessionCtx.log(
          `kimi queued message formatting failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (failed || prompts.length === 0) {
      for (const entry of drained) entry.token.retry(entry.message, "kimi_queued_turn_format_failed");
      return;
    }
    const token = drained[0]?.token;
    if (!token) return;
    await runTurn(
      prompts.join("\n\n"),
      sessionCtx,
      drained.map((entry) => entry.message),
      token,
    );
  }

  function scheduleQueuedMessagesDrain(): void {
    if (drainScheduled || drainInProgress || initialTurnPreparing) return;
    if (!sessionActive || !ctx || !session || currentTurnPromise || queuedMessages.length === 0) return;
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      if (!sessionActive || !ctx || !session || currentTurnPromise || queuedMessages.length === 0) return;
      const drained = queuedMessages.splice(0);
      const sessionCtx = ctx;
      drainInProgress = true;
      void mergeAndRun(drained, sessionCtx)
        .catch((error) => {
          sessionCtx.log(`kimi queued turn failed: ${error instanceof Error ? error.message : String(error)}`);
          for (const entry of drained) entry.token.retry(entry.message, "kimi_queued_turn_failed");
        })
        .finally(() => {
          drainInProgress = false;
          scheduleQueuedMessagesDrain();
        });
    });
  }

  function retryQueuedMessages(reason: string): void {
    for (const entry of queuedMessages.splice(0)) entry.token.retry(entry.message, reason);
  }

  async function prepareSession(sessionCtx: SessionContext): Promise<PreparedSession> {
    if (isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata)) {
      throw new Error(
        "landing campaign trial agents require the codex app-server workspace-only runtime; kimi-code does not support trials",
      );
    }
    ctx = sessionCtx;
    const workspaceCwd = acquireAgentHome(workspaceRoot);
    cwd = workspaceCwd;

    let payload: AgentRuntimeConfigPayload | null = null;
    if (agentConfigCache) payload = (await agentConfigCache.refresh(sessionCtx.agent.agentId)).payload;
    const payloadResolved = payload !== null;
    payload ??= { ...DEFAULT_KIMI_CODE_RUNTIME_CONFIG_PAYLOAD };
    if (payload.kind !== "kimi-code") {
      throw new Error(`runtime provider mismatch: expected kimi-code, got ${payload.kind}`);
    }

    sourceReposForPrompt = declaredSourceRepos(workspaceCwd, payload);
    await materializeResourceSkills(workspaceCwd, payload, sessionCtx);
    const briefing = buildBriefing(sessionCtx, payload, workspaceCwd);
    ensureAgentBootstrap({
      workspace: workspaceCwd,
      sessionCtx,
      contextTreePath,
      briefing,
      currentSourceRepoNames: currentSourceRepoNamesFromPayload(payload, payloadResolved),
    });
    markWorkspaceInitComplete(workspaceCwd);
    emitMcpUnsupportedDiagnosticOnce(sessionCtx, payload);

    const chatContext = await fetchChatContextOrLog(sessionCtx);
    const roleAdditional = [renderRuntimeOutputContract(), chatContext].filter(Boolean).join("\n\n");
    const providerEnv = buildEnv(sessionCtx, payload);
    const localKaos = await kaosFactory();
    const kaos = localKaos.withCwd(workspaceCwd).withEnv(providerEnv);
    activePayload = payload;
    return {
      payload,
      workspaceCwd,
      roleAdditional,
      additionalDirs: additionalDirectories(workspaceCwd, contextTreePath),
      kaos,
    };
  }

  function ensureHarness(): KimiHarnessLike {
    harness ??= harnessFactory({
      identity: { userAgentProduct: "first-tree", version: KIMI_IDENTITY_VERSION },
      uiMode: "first-tree",
    });
    return harness;
  }

  async function closeActiveSession(): Promise<void> {
    const activeSession = session;
    session = null;
    if (!activeSession) return;
    try {
      await activeSession.close();
    } catch (error) {
      ctx?.log(`kimi session close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function closeHarness(): Promise<void> {
    const activeHarness = harness;
    harness = null;
    if (!activeHarness) return;
    try {
      await activeHarness.close();
    } catch (error) {
      ctx?.log(`kimi harness close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function cleanupFailedInitialization(): Promise<void> {
    sessionActive = false;
    retryQueuedMessages("kimi_initialization_failed");
    await closeActiveSession();
    await closeHarness();
    cwd = null;
    ctx = null;
    sessionId = null;
    activePayload = null;
    sourceReposForPrompt = [];
    initialTurnPreparing = false;
    activeTools.clear();
  }

  return {
    async start(message, sessionCtx, token) {
      const explicitToken = token !== undefined;
      const deliveryToken = token ?? deliveryTokenFromSessionContext(sessionCtx);
      const prepared = await prepareSession(sessionCtx);
      const options: CreateSessionOptions = {
        workDir: prepared.workspaceCwd,
        permission: "yolo",
        kaos: prepared.kaos,
        additionalDirs: prepared.additionalDirs,
        roleAdditional: prepared.roleAdditional,
        ...(prepared.payload.model ? { model: prepared.payload.model } : {}),
      };
      try {
        session = await ensureHarness().createSession(options);
        sessionId = session.id;
        sessionActive = true;
        initialTurnPreparing = true;
        const prompt = await sessionCtx.formatInboundContent(message);
        await runTurn(prompt, sessionCtx, [message], deliveryToken);
      } catch (error) {
        await cleanupFailedInitialization();
        throw error;
      } finally {
        initialTurnPreparing = false;
        scheduleQueuedMessagesDrain();
      }
      return explicitToken ? { sessionId, route: { kind: "owned", mode: "processing" } } : sessionId;
    },

    async resume(message, id, sessionCtx, token) {
      const explicitToken = token !== undefined;
      const deliveryToken = token ?? deliveryTokenFromSessionContext(sessionCtx);
      const prepared = await prepareSession(sessionCtx);
      const input: ResumeSessionInput = {
        id,
        kaos: prepared.kaos,
        additionalDirs: prepared.additionalDirs,
        roleAdditional: prepared.roleAdditional,
      };
      try {
        session = await ensureHarness().resumeSession(input);
        sessionId = session.id;
        await session.setPermission("yolo");
        if (prepared.payload.model) await session.setModel(prepared.payload.model);
        sessionActive = true;
        if (message) {
          initialTurnPreparing = true;
          const prompt = await sessionCtx.formatInboundContent(message);
          await runTurn(prompt, sessionCtx, [message], deliveryToken);
        }
      } catch (error) {
        await cleanupFailedInitialization();
        throw error;
      } finally {
        initialTurnPreparing = false;
        scheduleQueuedMessagesDrain();
      }
      return explicitToken ? { sessionId, route: message ? { kind: "owned", mode: "processing" } : null } : sessionId;
    },

    inject(message, token) {
      if (!ctx || !sessionActive) return { kind: "rejected", reason: "no_active_context", retryable: true };
      queuedMessages.push({ message, token: token ?? deliveryTokenFromSessionContext(ctx) });
      scheduleQueuedMessagesDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend(reason) {
      sessionActive = false;
      retryQueuedMessages(reason ?? "kimi_suspend_before_terminal");
      try {
        await session?.cancel();
      } catch {
        // The session may already have completed between the liveness fence and cancel.
      }
      try {
        await currentTurnPromise;
      } catch {
        // The turn path already translated or rescheduled its failure.
      }
      currentTurnPromise = null;
      await closeActiveSession();
      initialTurnPreparing = false;
      activeTools.clear();
    },

    async shutdown(reason) {
      sessionActive = false;
      retryQueuedMessages(reason ?? "kimi_shutdown_before_terminal");
      try {
        await session?.cancel();
      } catch {
        // best-effort cancellation
      }
      try {
        await currentTurnPromise;
      } catch {
        // translated by runTurn
      }
      currentTurnPromise = null;
      await closeActiveSession();
      await closeHarness();
      cwd = null;
      ctx = null;
      sessionId = null;
      activePayload = null;
      sourceReposForPrompt = [];
      initialTurnPreparing = false;
      activeTools.clear();
    },
  } satisfies AgentHandler;
};
