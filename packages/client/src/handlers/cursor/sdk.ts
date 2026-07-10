import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import {
  type AgentRuntimeConfigPayload,
  DEFAULT_CURSOR_RUNTIME_CONFIG_PAYLOAD,
  runtimeProviderSchema,
  type SessionEvent,
  type ToolFileRef,
} from "@first-tree/shared";
import { ensureAgentBootstrap } from "../../runtime/agent-bootstrap.js";
import { buildAgentBriefing } from "../../runtime/agent-briefing.js";
import type { AgentConfigCache } from "../../runtime/agent-config-cache.js";
import type { PredeclaredSourceRepo } from "../../runtime/bootstrap.js";
import { type ChatContext, fetchChatContext } from "../../runtime/chat-context.js";
import { renderChatContextPrompt, renderRuntimeOutputContract } from "../../runtime/chat-context-section.js";
import { getChildProcessRegistry, type RegisteredChild } from "../../runtime/child-process-registry.js";
import { resolveContextTreeRelativePath } from "../../runtime/context-tree-file-refs.js";
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
import type { TurnSettlement } from "../turn-settlement.js";
import {
  consumeCursorEvent,
  createCursorTurnState,
  evaluateCursorNoResult,
  finalizeCursorBinaryMissing,
  finalizeCursorResult,
} from "./parser.js";

/** Bounded stderr tail retained for the no-result error path. */
const STDERR_TAIL_LIMIT = 8_000;

/**
 * Prefix marking a synthetic, UNCONFIRMED session id. cursor-agent mints the
 * real session id via `system:init`; when the very first turn exits before init
 * (e.g. broken auth) no id is captured. Rather than throw AFTER the turn has
 * already settled the delivery (double-handling — see the start path), we return
 * a synthetic id with this prefix. It is never replayed via `--resume` until a
 * real init upgrades it, so a bogus resume can never re-drive a lost session.
 */
const SYNTHETIC_SESSION_ID_PREFIX = "cursor-pending-";

/** Grace window between SIGTERM and SIGKILL when tearing a turn's child down. */
const KILL_TERMINATE_GRACE_MS = 5_000;
/** Upper bound on awaiting a turn's own settlement after the child is killed. */
const KILL_FINAL_WAIT_MS = 2_000;
/**
 * Cap on waiting for the child `close` (all stdio drained) after `exit`. `close`
 * normally fires within milliseconds; this only guards a wedged/inherited pipe.
 */
const POST_EXIT_DRAIN_GRACE_MS = 2_000;

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
  // Kill-escalation timings. Defaults are production values; a test can inject
  // short windows to exercise SIGTERM→SIGKILL escalation without a real wait.
  const killTerminateGraceMs = readNumberConfig(config.cursorKillTerminateGraceMs) ?? KILL_TERMINATE_GRACE_MS;
  const killFinalWaitMs = readNumberConfig(config.cursorKillFinalWaitMs) ?? KILL_FINAL_WAIT_MS;
  // Upper bound applied to the shared policy's foreground provider-turn retry
  // delay. Default `Infinity` honors the policy exactly (`Math.min(d, ∞) === d`);
  // a test injects a small cap so the retry LOOP is exercised without real waits.
  const retryDelayCapMs = readNumberConfig(config.cursorRetryDelayCapMs) ?? Number.POSITIVE_INFINITY;

  let cwd: string | null = null;
  /** The cursor `session_id` — captured from `system:init`, or a synthetic id. */
  let sessionId: string | null = null;
  /**
   * Whether `sessionId` was minted by cursor (`system:init`/`result`). Only a
   * confirmed id is replayed via `--resume`; a synthetic id is never resumed
   * (see {@link SYNTHETIC_SESSION_ID_PREFIX}).
   */
  let sessionConfirmed = false;
  /** Operator-configured model (empty = let the Cursor CLI choose). */
  let currentModel = "";
  let ctx: SessionContext | null = null;
  let currentChild: RegisteredChild | null = null;
  let currentTurnPromise: Promise<boolean> | null = null;
  /**
   * Per-turn ownership fence (mirrors codex's `currentAbort` identity). Each turn
   * creates its OWN AbortController and installs it here; the turn continuation
   * checks its CAPTURED `abort.signal` (not a shared boolean a newer turn could
   * reset) and only clears the global child/promise slots while it is still the
   * current turn (`currentAbort === myAbort`). So a continuation abandoned by a
   * timed-out teardown can neither settle a newer turn's delivery nor erase its
   * live slots. suspend/shutdown abort the current turn via `currentAbort.abort()`.
   */
  let currentAbort: AbortController | null = null;

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
    // Only replay a CONFIRMED (cursor-minted) session id. A synthetic id from a
    // pre-init first-turn failure must never be `--resume`d — cursor would
    // reject it and the message would loop instead of starting fresh.
    if (sessionId && sessionConfirmed) args.push("--resume", sessionId);
    return args;
  }

  /**
   * Adopt the session id cursor minted DURING THIS process stream. `state`
   * starts with `sessionId === null` and only `consumeSystem` / `consumeResult`
   * set it (an id truly observed on the wire), so a non-null `state.sessionId`
   * is always provider-observed — a synthetic seed can never be mistaken for a
   * confirmed id (finding 1). When it replaces an id SessionManager already
   * holds (a synthetic id being upgraded, or a changed real id), rebind custody
   * via `replaceSessionId` so continuity survives.
   */
  function captureSessionId(state: { sessionId: string | null }, sessionCtx: SessionContext): void {
    if (!state.sessionId) return;
    const previous = sessionId;
    if (previous && previous !== state.sessionId) {
      sessionCtx.replaceSessionId?.(
        state.sessionId,
        sessionConfirmed ? "cursor_session_id_changed" : "cursor_session_id_assigned",
      );
    }
    sessionId = state.sessionId;
    sessionConfirmed = true;
  }

  /**
   * Gate finalize on the child `close` event — which fires only after ALL stdio
   * (stdout AND stderr) has fully drained — plus the stdout line-reader close.
   * `exit` alone is insufficient: Node can deliver the remaining stderr AFTER
   * `exit`, and the stderr tail is what classifies auth/model/quota failures, so
   * settling on `exit` could classify a permanent failure as a generic retry
   * (finding 4). The exit code is captured from `exit`, but the barrier is
   * `close`. A bounded post-exit grace prevents a wedged stdio pipe from hanging
   * the turn forever.
   */
  function awaitChildSettled(child: ChildProcess, rl: Interface): Promise<number | null> {
    return new Promise((resolve) => {
      let closed = false;
      let readerClosed = false;
      let exitCode: number | null = null;
      let done = false;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (graceTimer) clearTimeout(graceTimer);
        resolve(exitCode);
      };
      const settle = (): void => {
        if (closed && readerClosed) finish();
      };
      child.once("exit", (code) => {
        exitCode = code;
        // Safety net: if `close` (all stdio drained) does not arrive shortly
        // after exit, settle anyway so a wedged/inherited stdio pipe cannot hang
        // the turn. In the normal case `close` fires within milliseconds.
        graceTimer = setTimeout(() => {
          closed = true;
          readerClosed = true;
          finish();
        }, POST_EXIT_DRAIN_GRACE_MS);
        graceTimer.unref?.();
      });
      child.once("close", () => {
        closed = true;
        settle();
      });
      child.once("error", () => {
        // Spawn failure — no stdio stream will open/close on its own.
        closed = true;
        readerClosed = true;
        finish();
      });
      rl.once("close", () => {
        readerClosed = true;
        settle();
      });
    });
  }

  async function settleTurn(
    settlement: TurnSettlement,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
  ): Promise<boolean> {
    if (settlement.action.kind === "complete") {
      await token.complete(messages, settlement.action.outcome);
      return true;
    }
    token.retry(messages, settlement.action.reason);
    return false;
  }

  /** Enrich a `tool_call` event's file refs with Context Tree repo coordinates. */
  function enrichToolCallEvent(event: SessionEvent): SessionEvent {
    if (event.kind !== "tool_call") return event;
    const refs = event.payload.toolFileRefs;
    if (!refs || refs.length === 0) return event;
    const enriched = enrichCursorToolFileRefs(refs, { cwd, contextTreePath, contextTreeRepoUrl, contextTreeBranch });
    return { ...event, payload: { ...event.payload, toolFileRefs: enriched } };
  }

  type AttemptResult = { kind: "ok"; exitCode: number | null; stderrTail: string } | { kind: "no_stdout" };

  /**
   * Spawn one cursor CLI attempt and stream it into `state`. `isCurrent` gates
   * writes to the global `currentChild` slot so a stale continuation cannot
   * overwrite a newer turn's live child.
   */
  async function runOneAttempt(
    binary: string,
    env: Record<string, string>,
    promptText: string,
    state: ReturnType<typeof createCursorTurnState>,
    sessionCtx: SessionContext,
    isCurrent: () => boolean,
  ): Promise<AttemptResult> {
    let stderrTail = "";
    const { child, record } = getChildProcessRegistry().spawn(binary, buildTurnArgs(), {
      category: "other",
      label: `cursor-agent turn (${sessionCtx.chatId})`,
      cwd: cwd ?? undefined,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (isCurrent()) currentChild = record;

    const stdout = child.stdout;
    if (!stdout) {
      if (isCurrent()) currentChild = null;
      return { kind: "no_stdout" };
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
        sessionCtx.emitEvent(enrichToolCallEvent(event));
      }
    });

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });
    }

    const exitCode = await awaitChildSettled(child, rl);
    if (isCurrent()) currentChild = null;
    return { kind: "ok", exitCode, stderrTail };
  }

  /**
   * Run one cursor turn — a FOREGROUND provider-turn retry loop mirroring codex's
   * runTurn. Each attempt re-spawns with a FRESH turn state (so replay safety is
   * re-evaluated per attempt), and the shared provider-retry policy decides
   * whether to foreground-wait + re-spawn, hand back to the inbox, or settle
   * terminal. A per-turn `abort` (installed as `currentAbort`) fences the turn:
   * the continuation checks its CAPTURED signal and only touches the global
   * child/promise slots while it is still current. Returns whether the turn was
   * delivered (settled complete) so callers can advance the briefing baseline.
   */
  async function runTurn(
    inputText: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
  ): Promise<boolean> {
    const promptText = consumePendingChatContext(inputText);
    token.processingStarted(messages);

    const env = buildEnv(sessionCtx);
    const binary = findCursorExecutableOnPath(env);
    if (!binary) {
      // finding 3: an unresolved binary after bind is a terminal needs-operator
      // CAPABILITY failure with a durable notice — NOT a bare transient retry.
      const message = formatCursorBinaryMissingMessage("no `agent` or `cursor-agent` binary found on PATH");
      const { events, settlement } = finalizeCursorBinaryMissing(message);
      for (const event of events) sessionCtx.emitEvent(event);
      return settleTurn(settlement, messages, token);
    }

    const abort = new AbortController();
    currentAbort = abort;
    const isCurrent = (): boolean => currentAbort === abort;
    const abortRetry = (): boolean => {
      // Deliberate suspend/shutdown kill — settle THIS (old) delivery for
      // redelivery; the fence stops it from touching a newer turn's slots.
      token.retry(messages, "cursor_turn_aborted");
      return false;
    };

    const promise = (async (): Promise<boolean> => {
      for (let attempt = 1; ; attempt++) {
        if (abort.signal.aborted) return abortRetry();

        const state = createCursorTurnState();
        const attemptResult = await runOneAttempt(binary, env, promptText, state, sessionCtx, isCurrent);
        if (attemptResult.kind === "no_stdout") {
          sessionCtx.emitEvent({
            kind: "error",
            payload: { source: "runtime", message: "cursor-agent child produced no stdout stream" },
          });
          sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
          token.retry(messages, "cursor_no_stdout");
          return false;
        }
        if (abort.signal.aborted) return abortRetry();

        // Adopt any session id observed on THIS attempt's stream.
        captureSessionId(state, sessionCtx);

        if (state.sawResult) {
          // finding 5: forwardResult (the completion hook that clears the
          // per-chat trigger) runs for EVERY successful result, INCLUDING an
          // empty/silent/tool-only reply — it is a completion hook, not a text
          // path. A rejection becomes a consumed forward-failed settlement.
          let forwardFailed = false;
          if (!state.isError) {
            try {
              await sessionCtx.forwardResult(state.resultText);
            } catch (err) {
              forwardFailed = true;
              sessionCtx.emitEvent({
                kind: "error",
                payload: {
                  source: "runtime",
                  message: `forwardResult failed: ${err instanceof Error ? err.message : String(err)}`,
                },
              });
            }
          }
          if (abort.signal.aborted) return abortRetry();
          const { events, settlement } = finalizeCursorResult(state, { forwardFailed });
          for (const event of events) sessionCtx.emitEvent(event);
          return settleTurn(settlement, messages, token);
        }

        const disposition = evaluateCursorNoResult(state, attemptResult.exitCode, attemptResult.stderrTail, attempt);
        if (disposition.action === "retry") {
          sessionCtx.emitEvent(disposition.scheduledEvent);
          const delayMs = Math.min(disposition.delayMs, retryDelayCapMs);
          sessionCtx.log(`cursor provider-turn retry ${attempt} after ${delayMs}ms`);
          try {
            await sleepWithAbort(delayMs, abort.signal);
          } catch {
            return abortRetry();
          }
          continue;
        }
        for (const event of disposition.events) sessionCtx.emitEvent(event);
        return settleTurn(disposition.settlement, messages, token);
      }
    })();

    if (isCurrent()) currentTurnPromise = promise;
    try {
      return await promise;
    } finally {
      // Generation-guarded clear: a continuation abandoned by a timed-out
      // teardown (its `currentAbort` already replaced by a newer turn) must NOT
      // erase the newer turn's live slots.
      if (isCurrent()) {
        currentAbort = null;
        currentTurnPromise = null;
        currentChild = null;
      }
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

  /**
   * Tear down the active turn: abort it (turn-local, via `currentAbort`) and
   * kill its child with a bounded SIGTERM → SIGKILL escalation
   * (`RegisteredChild.kill` sends a single signal — it does NOT escalate). Every
   * await is deadline-bounded so a CLI that ignores SIGTERM, or a wedged reader,
   * cannot hang suspend/shutdown forever (mirrors the codex app-server client's
   * `shutdown()` escalation).
   *
   * The global child/promise slots are NOT cleared here: if the wait times out
   * and the continuation is abandoned, its own generation-guarded `finally`
   * clears them when it eventually resolves — and only if it is still the
   * current turn, so a newer turn's slots are never erased.
   */
  async function killCurrentTurn(): Promise<void> {
    currentAbort?.abort();
    const child = currentChild;
    const turn = currentTurnPromise;
    if (child) {
      child.kill("SIGTERM");
      const exited = await exitedWithin(child.exited, killTerminateGraceMs);
      if (!exited) child.kill("SIGKILL");
    }
    // The turn promise resolves once the child exits and stdout drains; bound it
    // so a stuck reader can't wedge the caller even after the child is gone.
    if (turn) await raceWithTimeout(turn, killFinalWaitMs);
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
      sessionConfirmed = false;

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

      // runTurn ALWAYS settles the delivery token (complete or retry), so the
      // turn's disposition is already authoritative. If the first turn exited
      // before `system:init` (e.g. broken auth) no id was captured — return a
      // synthetic UNCONFIRMED id rather than throwing, which would double-handle
      // an already-settled inbox row. A later real init upgrades it.
      if (!sessionId) {
        sessionId = `${SYNTHETIC_SESSION_ID_PREFIX}${randomUUID()}`;
        sessionConfirmed = false;
        sessionCtx.log(
          "cursor first turn produced no session id (pre-init exit); returning a synthetic unconfirmed id",
        );
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
      // A synthetic id from a prior pre-init failure is NOT resumable; treat any
      // other id as a real cursor session to replay via `--resume`.
      sessionConfirmed = !resumeSessionId.startsWith(SYNTHETIC_SESSION_ID_PREFIX);

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
      sessionConfirmed = false;
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

function readNumberConfig(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Resolve `true` if `exited` settles within `ms`, else `false` (unref'd timer). */
function exitedWithin(exited: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, ms);
    timer.unref?.();
    void exited.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Await `promise` but give up after `ms` so a wedged turn can't hang teardown. */
function raceWithTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, ms);
    timer.unref?.();
    void Promise.resolve(promise)
      .catch(() => {})
      .then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
  });
}

/**
 * Abort-aware foreground sleep for the provider-turn retry backoff. Rejects with
 * an `AbortError` on abort (suspend/shutdown) so the turn loop can bail instead
 * of starting another attempt; a non-positive delay resolves immediately.
 */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Enrich cursor `tool_call` file refs (which carry only `localPath` from the
 * pure parser) with Context Tree repo coordinates when the path is inside the
 * bound tree — mirroring how the codex handler resolves
 * `repoUrl`/`repoBranch`/`repoRelativePath` (`toolFileRefsFromCodexFileChange`).
 * Without this the server's Context Tree I/O normalizer skips the ref (it counts
 * only refs matching the org binding), so cursor edit/write/read events would
 * be recognized by tool NAME but never actually counted (finding 6). Pure +
 * exported so the resolution is unit-testable without a live handler.
 */
export function enrichCursorToolFileRefs(
  refs: readonly ToolFileRef[],
  binding: {
    cwd: string | null;
    contextTreePath: string | null;
    contextTreeRepoUrl: string | null;
    contextTreeBranch: string | null;
  },
): ToolFileRef[] {
  return refs.map((ref) => enrichCursorToolFileRef(ref, binding));
}

function enrichCursorToolFileRef(
  ref: ToolFileRef,
  binding: {
    cwd: string | null;
    contextTreePath: string | null;
    contextTreeRepoUrl: string | null;
    contextTreeBranch: string | null;
  },
): ToolFileRef {
  // Already repo-resolved, or no local path to resolve → leave untouched.
  if (ref.repoRelativePath || !ref.localPath) return ref;
  if (!binding.contextTreeRepoUrl) return ref;
  const absolutePath = isAbsolute(ref.localPath)
    ? resolve(ref.localPath)
    : binding.cwd
      ? resolve(binding.cwd, ref.localPath)
      : null;
  if (!absolutePath) return ref;
  const repoRelativePath = resolveContextTreeRelativePath(absolutePath, {
    contextTreePath: binding.contextTreePath,
    contextTreeRepoUrl: binding.contextTreeRepoUrl,
  });
  // Not inside the bound tree, or the repo root itself → not a file-level ref.
  if (repoRelativePath === null || repoRelativePath === "/") return ref;
  return {
    ...ref,
    repoUrl: binding.contextTreeRepoUrl,
    ...(binding.contextTreeBranch ? { repoBranch: binding.contextTreeBranch } : {}),
    repoRelativePath,
  };
}
