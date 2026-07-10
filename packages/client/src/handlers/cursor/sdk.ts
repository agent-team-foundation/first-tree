import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import {
  type AgentRuntimeConfigPayload,
  DEFAULT_CURSOR_RUNTIME_CONFIG_PAYLOAD,
  runtimeProviderSchema,
} from "@first-tree/shared";
import { ensureAgentBootstrap } from "../../runtime/agent-bootstrap.js";
import { buildAgentBriefing } from "../../runtime/agent-briefing.js";
import type { AgentConfigCache } from "../../runtime/agent-config-cache.js";
import type { PredeclaredSourceRepo } from "../../runtime/bootstrap.js";
import { type ChatContext, fetchChatContext } from "../../runtime/chat-context.js";
import { renderChatContextPrompt, renderRuntimeOutputContract } from "../../runtime/chat-context-section.js";
import { getChildProcessRegistry, type RegisteredChild } from "../../runtime/child-process-registry.js";
import { findCursorExecutableOnPath, formatCursorBinaryMissingMessage } from "../../runtime/cursor-binary.js";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerFactory,
  SessionContext,
  SessionMessage,
} from "../../runtime/handler.js";
import { deliveryTokenFromSessionContext } from "../../runtime/handler.js";
import { materializeResourceSkills } from "../../runtime/resource-skills.js";
import {
  buildBriefingUpdateNotice,
  computeBriefingFingerprint,
  readSessionBriefingFingerprint,
  writeSessionBriefingFingerprint,
} from "../../runtime/session-briefing-fingerprint.js";
import { currentSourceRepoNamesFromPayload, declaredSourceRepos } from "../../runtime/source-repos.js";
import { acquireAgentHome, markWorkspaceInitComplete } from "../../runtime/workspace.js";
import { consumeCursorEvent, createCursorTurnState, finalizeCursorTurn } from "./parser.js";

/** Bounded stderr tail retained for the no-result error path. */
const STDERR_TAIL_LIMIT = 8_000;

/**
 * Cursor Handler — session-oriented handler that drives the `cursor-agent` CLI
 * via a fresh per-turn child-process spawn.
 *
 * Each turn spawns `agent -p --output-format stream-json --trust --force
 * --sandbox disabled [--model …] [--resume …]`, writes the prompt to stdin,
 * streams newline-delimited JSON events off stdout through the pure
 * {@link consumeCursorEvent} parser, and settles on process close via
 * {@link finalizeCursorTurn} (the `result` event is NOT guaranteed, so the
 * stderr tail is folded into the error path).
 *
 * Unlike codex there is no persistent SDK client or dual engine — the session
 * is just the captured cursor `session_id`, replayed with `--resume` on later
 * turns. Inject buffers messages and drains them one run-to-completion turn at
 * a time; suspend/shutdown kill the current child via the registry and never
 * delete the (agent-scoped, persistent) agent home.
 */
export const createCursorSdkHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot;
  // Parsed for validation/parity with the other handlers; the provider string
  // is otherwise fixed to "cursor" for this factory.
  runtimeProviderSchema.parse(config.runtimeProvider ?? "cursor");
  // Config boundary: these arrive through the `HandlerConfig` index signature as
  // `unknown`. The `as` narrowings below are the single contained assertion
  // point, mirroring the codex SDK handler's config extraction. A class instance
  // (AgentConfigCache) cannot be structurally type-guarded; the string configs
  // are guarded by `readStringConfig`.
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const contextTreePath = readStringConfig(config.contextTreePath);
  const contextTreeRepoUrl = readStringConfig(config.contextTreeRepoUrl);
  const contextTreeBranch = readStringConfig(config.contextTreeBranch);

  let cwd: string | null = null;
  /** The cursor `session_id` captured from `system:init` — replayed via `--resume`. */
  let sessionId: string | null = null;
  /** Operator-configured model (empty = let the Cursor CLI choose). */
  let currentModel = "";
  let ctx: SessionContext | null = null;
  let currentChild: RegisteredChild | null = null;
  let currentTurnPromise: Promise<boolean> | null = null;
  /** Set by suspend/shutdown so an intentionally-killed turn retries instead of erroring. */
  let currentTurnAborted = false;

  let drainScheduled = false;
  let drainInProgress = false;
  let initialTurnPreparing = false;
  const queuedMessages: Array<{ message: SessionMessage; token: DeliveryToken }> = [];

  /**
   * One-shot provider context. Cursor has no system-prompt channel, so the
   * session/resume chat context (and any briefing re-read notice) is prepended
   * to the next provider turn input and then cleared.
   */
  let pendingChatContextPrompt: string | null = null;
  let sourceReposForPrompt: PredeclaredSourceRepo[] = [];

  function buildEnv(sessionCtx: SessionContext): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
    if (payload) {
      for (const e of payload.env) env[e.key] = e.value;
    }
    const merged = sessionCtx.buildAgentEnv(env);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === "string") out[k] = v;
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

  async function fetchChatContextOrLog(sessionCtx: SessionContext): Promise<ChatContext | undefined> {
    try {
      return await fetchChatContext(sessionCtx.sdk, sessionCtx.chatId, sessionCtx.agent);
    } catch (err) {
      sessionCtx.log(`fetchChatContext failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  function declareSourceReposForPrompt(payload: AgentRuntimeConfigPayload, workspaceCwd: string): void {
    sourceReposForPrompt = declaredSourceRepos(workspaceCwd, payload);
  }

  function ensureCursorBootstrap(
    workspace: string,
    sessionCtx: SessionContext,
    briefing: string,
    payload: AgentRuntimeConfigPayload,
    payloadResolved: boolean,
  ): void {
    ensureAgentBootstrap({
      workspace,
      sessionCtx,
      contextTreePath,
      briefing,
      currentSourceRepoNames: currentSourceRepoNamesFromPayload(payload, payloadResolved),
    });
  }

  /**
   * Prepend the runtime output contract (and any pending chat-context / re-read
   * notice) to a turn's input. Cursor has no persistent system prompt, so this
   * rides every turn — the pending block is consumed once, the contract always.
   */
  function consumePendingChatContext(inputText: string): string {
    const chatPrompt = pendingChatContextPrompt;
    pendingChatContextPrompt = null;
    const contract = renderRuntimeOutputContract();
    const prefix = chatPrompt ? `${contract}\n\n${chatPrompt}` : contract;
    return `${prefix}\n\n${inputText}`;
  }

  function toCursorInput(message: SessionMessage, sessionCtx: SessionContext): Promise<string> {
    return sessionCtx.formatInboundContent(message);
  }

  function buildTurnArgs(): string[] {
    const args = ["-p", "--output-format", "stream-json", "--trust", "--force", "--sandbox", "disabled"];
    if (currentModel) args.push("--model", currentModel);
    if (sessionId) args.push("--resume", sessionId);
    return args;
  }

  /**
   * Await both the child process exit AND the stdout line-reader close so every
   * emitted line is consumed before we finalize. Resolves with the exit code.
   */
  function awaitChildSettled(child: ChildProcess, rl: Interface): Promise<number | null> {
    return new Promise((resolve) => {
      let exited = false;
      let readerClosed = false;
      let exitCode: number | null = null;
      let done = false;
      const settle = (): void => {
        if (done || !exited || !readerClosed) return;
        done = true;
        resolve(exitCode);
      };
      child.once("exit", (code) => {
        exited = true;
        exitCode = code;
        settle();
      });
      child.once("error", () => {
        // Spawn failure — no stdout stream will open/close on its own.
        exited = true;
        readerClosed = true;
        settle();
      });
      rl.once("close", () => {
        readerClosed = true;
        settle();
      });
    });
  }

  /**
   * Run one cursor turn to completion. Returns whether the turn was delivered
   * (settled complete) so callers can advance the briefing baseline.
   */
  async function runTurn(
    inputText: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
  ): Promise<boolean> {
    currentTurnAborted = false;
    const promptText = consumePendingChatContext(inputText);
    token.processingStarted(messages);

    const env = buildEnv(sessionCtx);
    const binary = findCursorExecutableOnPath(env);
    if (!binary) {
      const message = formatCursorBinaryMissingMessage("no `agent` or `cursor-agent` binary found on PATH");
      sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message } });
      sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
      token.retry(messages, "cursor_binary_missing");
      return false;
    }

    const args = buildTurnArgs();
    const state = createCursorTurnState();
    if (sessionId) state.sessionId = sessionId;
    let stderrTail = "";

    const turn = (async (): Promise<boolean> => {
      const { child, record } = getChildProcessRegistry().spawn(binary, args, {
        category: "other",
        label: `cursor-agent turn (${sessionCtx.chatId})`,
        cwd: cwd ?? undefined,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      currentChild = record;

      const stdout = child.stdout;
      if (!stdout) {
        sessionCtx.emitEvent({
          kind: "error",
          payload: { source: "runtime", message: "cursor-agent child produced no stdout stream" },
        });
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
        token.retry(messages, "cursor_no_stdout");
        return false;
      }

      // Swallow stdin EPIPE when the child exits before consuming the prompt.
      child.stdin?.on("error", () => {});
      try {
        child.stdin?.write(promptText);
        child.stdin?.end();
      } catch (err) {
        sessionCtx.log(`cursor stdin write failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const rl = createInterface({ input: stdout });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch (err) {
          sessionCtx.log(`cursor emitted malformed JSON line: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        sessionCtx.recordProviderActivity();
        for (const event of consumeCursorEvent(state, parsed)) {
          sessionCtx.emitEvent(event);
        }
      });

      if (child.stderr) {
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
        });
      }

      const exitCode = await awaitChildSettled(child, rl);
      currentChild = null;

      // Capture the cursor session id assigned this turn (system:init / result).
      if (state.sessionId) sessionId = state.sessionId;

      if (currentTurnAborted) {
        // Deliberate suspend/shutdown kill — keep the message recoverable.
        token.retry(messages, "cursor_turn_aborted");
        return false;
      }

      const { events, settlement } = finalizeCursorTurn(state, exitCode, stderrTail);
      for (const event of events) sessionCtx.emitEvent(event);

      if (settlement.action.kind === "complete") {
        await token.complete(messages, settlement.action.outcome);
        return true;
      }
      token.retry(messages, settlement.action.reason);
      return false;
    })();

    currentTurnPromise = turn;
    try {
      return await turn;
    } finally {
      currentChild = null;
      currentTurnPromise = null;
    }
  }

  async function mergeAndRun(
    drained: Array<{ message: SessionMessage; token: DeliveryToken }>,
    sessionCtx: SessionContext,
  ): Promise<void> {
    const messages = drained.map((entry) => entry.message);
    const token = drained[0]?.token;
    if (!token) return;
    const inputs: string[] = [];
    let hadFormatFailure = false;
    for (const m of messages) {
      try {
        inputs.push(await sessionCtx.formatInboundContent(m));
      } catch (err) {
        hadFormatFailure = true;
        sessionCtx.log(
          `cursor inject formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (hadFormatFailure || inputs.length === 0) {
      for (const queued of drained) queued.token.retry(queued.message, "cursor_queued_turn_format_failed");
      return;
    }
    await runTurn(inputs.join("\n\n"), sessionCtx, messages, token);
  }

  function scheduleQueuedMessagesDrain(): void {
    if (drainScheduled || drainInProgress) return;
    if (queuedMessages.length === 0 || !ctx || currentTurnPromise || initialTurnPreparing) return;

    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      if (drainInProgress || queuedMessages.length === 0 || !ctx || currentTurnPromise || initialTurnPreparing) {
        scheduleQueuedMessagesDrain();
        return;
      }
      const drained = queuedMessages.splice(0);
      const sessionCtx = ctx;
      drainInProgress = true;
      void mergeAndRun(drained, sessionCtx)
        .catch((err) => {
          sessionCtx.log(`cursor queued turn failed: ${err instanceof Error ? err.message : String(err)}`);
          for (const queued of drained) queued.token.retry(queued.message, "cursor_queued_turn_failed");
        })
        .finally(() => {
          drainInProgress = false;
          scheduleQueuedMessagesDrain();
        });
    });
  }

  function retryQueuedMessages(reason: string): void {
    const drained = queuedMessages.splice(0);
    for (const queued of drained) queued.token.retry(queued.message, reason);
  }

  async function killCurrentTurn(): Promise<void> {
    currentTurnAborted = true;
    currentChild?.kill("SIGTERM");
    try {
      await currentTurnPromise;
    } catch {
      // The turn resolves rather than throwing; swallow defensively.
    }
    currentChild = null;
    currentTurnPromise = null;
  }

  return {
    async start(message, sessionCtx, token) {
      const hasExplicitDeliveryToken = token !== undefined;
      const deliveryToken = token ?? deliveryTokenFromSessionContext(sessionCtx);
      ctx = sessionCtx;
      cwd = acquireAgentHome(workspaceRoot);

      let payload: AgentRuntimeConfigPayload | null = null;
      if (agentConfigCache) {
        payload = (await agentConfigCache.refresh(sessionCtx.agent.agentId)).payload;
      }
      const payloadResolved = payload !== null;
      if (!payload) payload = { ...DEFAULT_CURSOR_RUNTIME_CONFIG_PAYLOAD };

      const chatContext = await fetchChatContextOrLog(sessionCtx);
      pendingChatContextPrompt = renderChatContextPrompt(chatContext);

      declareSourceReposForPrompt(payload, cwd);
      await materializeResourceSkills(cwd, payload, sessionCtx);

      const briefing = buildBriefing(sessionCtx, payload, cwd);
      ensureCursorBootstrap(cwd, sessionCtx, briefing, payload, payloadResolved);
      markWorkspaceInitComplete(cwd);

      currentModel = payload.model || "";
      sessionId = null;

      initialTurnPreparing = true;
      let initialTurnCompleted = false;
      try {
        const input = await toCursorInput(message, sessionCtx);
        await runTurn(input, sessionCtx, [message], deliveryToken);
        initialTurnCompleted = true;
      } finally {
        initialTurnPreparing = false;
        if (initialTurnCompleted) scheduleQueuedMessagesDrain();
      }

      if (!sessionId) {
        throw new Error("cursor did not assign a session id during the first turn");
      }
      // Seed the briefing baseline now that the session id is known; a fresh
      // session starts in sync so a later resume only nudges on a real change.
      writeSessionBriefingFingerprint(cwd, sessionId, computeBriefingFingerprint(briefing));
      return hasExplicitDeliveryToken ? { sessionId, route: { kind: "owned", mode: "processing" } } : sessionId;
    },

    async resume(message, resumeSessionId, sessionCtx, token) {
      const hasExplicitDeliveryToken = token !== undefined;
      const deliveryToken = token ?? deliveryTokenFromSessionContext(sessionCtx);
      ctx = sessionCtx;
      cwd = acquireAgentHome(workspaceRoot);

      let payload: AgentRuntimeConfigPayload | null = null;
      if (agentConfigCache) {
        payload = (await agentConfigCache.refresh(sessionCtx.agent.agentId)).payload;
      }
      const resumePayloadResolved = payload !== null;
      if (!payload) payload = { ...DEFAULT_CURSOR_RUNTIME_CONFIG_PAYLOAD };

      const chatContext = await fetchChatContextOrLog(sessionCtx);
      pendingChatContextPrompt = renderChatContextPrompt(chatContext);

      declareSourceReposForPrompt(payload, cwd);
      await materializeResourceSkills(cwd, payload, sessionCtx);

      const briefing = buildBriefing(sessionCtx, payload, cwd);
      ensureCursorBootstrap(cwd, sessionCtx, briefing, payload, resumePayloadResolved);
      markWorkspaceInitComplete(cwd);

      // Briefing-staleness re-read notice: a resumed cursor session will not
      // re-read AGENTS.md, so prepend a one-time re-read notice ahead of the
      // Current Chat Context when the briefing changed since this session last
      // ran a turn. Baseline advances only after a delivered turn below.
      const briefingFingerprint = computeBriefingFingerprint(briefing);
      const briefingChanged =
        Boolean(message) && readSessionBriefingFingerprint(cwd, resumeSessionId) !== briefingFingerprint;
      if (briefingChanged) {
        const notice = buildBriefingUpdateNotice(join(cwd, "AGENTS.md"));
        pendingChatContextPrompt = pendingChatContextPrompt ? `${notice}\n\n${pendingChatContextPrompt}` : notice;
        sessionCtx.log(`Resume: briefing changed since last turn — prepending re-read notice (${resumeSessionId})`);
      }

      currentModel = payload.model || "";
      sessionId = resumeSessionId;

      if (message) {
        initialTurnPreparing = true;
        let initialTurnCompleted = false;
        let turnDelivered = false;
        try {
          const input = await toCursorInput(message, sessionCtx);
          turnDelivered = await runTurn(input, sessionCtx, [message], deliveryToken);
          initialTurnCompleted = true;
        } finally {
          initialTurnPreparing = false;
          if (initialTurnCompleted) scheduleQueuedMessagesDrain();
        }
        if (turnDelivered && sessionId) writeSessionBriefingFingerprint(cwd, sessionId, briefingFingerprint);
      }

      return hasExplicitDeliveryToken
        ? { sessionId: sessionId ?? resumeSessionId, route: message ? { kind: "owned", mode: "processing" } : null }
        : (sessionId ?? resumeSessionId);
    },

    inject(message, token) {
      if (!ctx) return { kind: "rejected", reason: "no_active_context", retryable: true };
      const deliveryToken = token ?? deliveryTokenFromSessionContext(ctx);
      queuedMessages.push({ message, token: deliveryToken });
      scheduleQueuedMessagesDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend() {
      retryQueuedMessages("cursor_suspend_before_terminal");
      await killCurrentTurn();
      initialTurnPreparing = false;
      pendingChatContextPrompt = null;
    },

    async shutdown(reason?: string) {
      retryQueuedMessages(reason ?? "cursor_shutdown_before_terminal");
      await killCurrentTurn();
      // The agent home, source repos, the Context Tree clone, and on-demand
      // worktrees are all agent-scoped persistent state — NEVER deleted here.
      cwd = null;
      sessionId = null;
      ctx = null;
      initialTurnPreparing = false;
      pendingChatContextPrompt = null;
      queuedMessages.length = 0;
    },
  } satisfies AgentHandler;
};

function readStringConfig(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
