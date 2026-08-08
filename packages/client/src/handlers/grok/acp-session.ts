/**
 * Thin ACP (Agent Client Protocol v1) transport for the Grok Build CLI.
 *
 * One short-lived `grok ... stdio` process per provider turn; this module
 * owns the child lifecycle and the JSON-RPC sequence:
 *
 *   spawn → ndJsonStream over stdio → initialize (EMPTY clientCapabilities,
 *   so Grok keeps file/terminal ops on its own local backends) →
 *   session/new (first turn) or session/load (resume; NEVER silently falls
 *   back to session/new on failure — replay safety) → legacy replay drain →
 *   session/set_model (after EVERY session open, every turn: session/load
 *   restores the session's PERSISTED selection, so even an empty config
 *   re-asserts the initialize default model; empty effort OMITS `_meta`
 *   entirely; a non-empty effort is confirmed by requiring THIS set_model's
 *   non-replay, same-session `model_changed` echo with the effective
 *   model_id + reasoning_effort — the waiter arms BEFORE the request) →
 *   session/prompt (client-generated `_meta.promptId`) → settle barrier:
 *   stdin EOF → bounded wait for real close + connection.closed → stable
 *   drain of the routed-handler queue → only then read settlement state →
 *   require exit 0.
 *
 * Auth is deliberately NOT negotiated: Grok auto-selects its
 * `defaultAuthMethodId`, and an explicit `authenticate(cached_token)` can
 * fall through to the interactive grok.com flow. Auth failures surface as
 * prompt/JSON-RPC errors and classify through the retry policy.
 *
 * Replay fence: `session/load` is sent with `_meta.noReplay: true` (Grok's
 * own headless resume contract), any notification stamped
 * `_meta.isReplay === true` is ALWAYS dropped regardless of arrival time,
 * and as a legacy fallback for builds without the marker the wrapper drains
 * the post-load replay before sending the current prompt (bounded
 * quiet-window — the SDK dispatches notification handlers asynchronously, so
 * a naive "prompt sent" boolean races the replay) and drops every
 * notification that arrives before the current `session/prompt` request has
 * been sent. Routed updates whose sessionId contradicts the active session
 * are dropped. Prompt-id correlation of `turn_completed` usage stays in the
 * handler (events.ts + index.ts).
 *
 * The defensive `session/request_permission` handler always denies: under
 * `--always-approve` + yoloMode it must never fire, and auto-approving would
 * silently widen the approval posture.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import type { InitializeResponse, McpServer, NewSessionResponse } from "@agentclientprotocol/sdk";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import type { ProviderProcessSupervisor } from "../../runtime/provider-support/index.js";
import {
  grokNotificationIsReplay,
  grokNotificationSessionId,
  parseGrokModelChangedEcho,
  parseGrokModelState,
} from "./events.js";

export const GROK_ACP_PROTOCOL_VERSION = 1;

/** Canonical argv prefix shared by turn spawns and model discovery. */
export const GROK_ACP_BASE_ARGS: readonly string[] = ["--no-auto-update", "agent", "--no-leader", "--always-approve"];

/**
 * Canonical turn argv (exported so tests can lock the spawn contract).
 * `--model` / `--effort` are omitted when the config values are empty so
 * Grok falls back to its local defaults; the prompt NEVER rides argv.
 */
export function buildGrokTurnArgs(input: { model: string; reasoningEffort: string }): string[] {
  const args = [...GROK_ACP_BASE_ARGS];
  if (input.model) args.push("--model", input.model);
  if (input.reasoningEffort) args.push("--effort", input.reasoningEffort);
  args.push("stdio");
  return args;
}

/** Bounded stderr tail kept for failure classification (never persisted raw). */
const STDERR_TAIL_LIMIT = 8_192;
/** Grace between SIGTERM and SIGKILL on abort, and the final close wait. */
const KILL_GRACE_MS = 5_000;
const FINAL_CLOSE_WAIT_MS = 10_000;
/** Pre-prompt (replay-fence) drops are logged a bounded number of times. */
const REPLAY_DROP_LOG_LIMIT = 3;
/**
 * Post-session/load replay drain: historical updates stream in right after
 * the load response; the prompt is sent only after the inbound channel has
 * been quiet for REPLAY_QUIET_MS (hard-capped at REPLAY_DRAIN_CAP_MS). The
 * SDK dispatches notification handlers asynchronously, so without the drain
 * a replayed chunk can be dispatched after our continuation has already
 * marked the prompt as sent.
 */
export const GROK_ACP_REPLAY_QUIET_MS = 25;
export const GROK_ACP_REPLAY_DRAIN_CAP_MS = 2_000;
/**
 * Bounded wait for THIS set_model's `model_changed` effort echo. The echo is
 * local state (no model call), so it should land within milliseconds; the
 * bound only guards a misbehaving build.
 */
export const GROK_SET_MODEL_ECHO_WAIT_MS = 2_000;

export type GrokAcpMcpCapabilities = { http: boolean; sse: boolean };

function headerRecordToArray(headers: Record<string, string> | undefined): Array<{ name: string; value: string }> {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
}

/**
 * Map First Tree managed MCP servers to the ACP schema. HTTP/SSE entries are
 * dropped (with one log line per server) when the agent did not advertise the
 * transport in its initialize response — never claim a transport the agent
 * did not offer.
 */
export function mapGrokAcpMcpServers(
  servers: AgentRuntimeConfigPayload["mcpServers"],
  capabilities: GrokAcpMcpCapabilities,
  log: (message: string) => void,
): McpServer[] {
  const mapped: McpServer[] = [];
  for (const server of servers) {
    if (server.transport === "stdio") {
      mapped.push({ name: server.name, command: server.command, args: server.args ?? [], env: [] });
      continue;
    }
    if (!capabilities[server.transport]) {
      log(
        `grok ACP: dropping MCP server "${server.name}" — agent did not advertise mcpCapabilities.${server.transport}`,
      );
      continue;
    }
    mapped.push({
      name: server.name,
      type: server.transport,
      url: server.url,
      headers: headerRecordToArray(server.headers),
    });
  }
  return mapped;
}

export type GrokAcpFailurePhase = "initialize" | "session_new" | "session_load" | "set_model" | "prompt";

export type GrokAcpAttemptInput = {
  supervisor: ProviderProcessSupervisor;
  binary: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  abortSignal: AbortSignal;
  label: string;
  /** Advertised as clientInfo.version ("0" when the build has no shared version). */
  clientVersion: string;
  /** Confirmed provider session id to `session/load`; null runs `session/new`. */
  resumeSessionId: string | null;
  mcpServers: AgentRuntimeConfigPayload["mcpServers"];
  /**
   * Operator-configured model / reasoning effort for this turn ("" = provider
   * default / no override). Applied via ACP `session/set_model` after EVERY
   * session open (new AND load) because `session/load` restores the session's
   * PERSISTED selection — mirroring Grok's own headless
   * `apply_headless_model_and_effort`. An explicit model is always re-applied;
   * an empty effort omits the effort meta; an empty model resolves to the
   * initialize-advertised default model, so "" resets to the provider default
   * rather than inheriting the load-restored value.
   */
  model: string;
  reasoningEffort: string;
  promptText: string;
  /** Bounded wait for process close after stdin EOF on the success path. */
  eofCloseWaitMs?: number;
  /** Grace between SIGTERM and SIGKILL on the terminate path (tests shorten this). */
  killGraceMs?: number;
  /** Bounded wait for the model_changed effort echo after set_model (tests shorten this). */
  setModelEchoWaitMs?: number;
  /** Bounded cap for the legacy replay drain after session/load (tests shorten this). */
  replayDrainCapMs?: number;
  /** Fired once initialize completed and capabilities validated (replay-ladder "saw provider" rung). */
  onInitialized?: () => void;
  /** Fired as soon as session/new or session/load confirms the active session id. */
  onSessionId?: (sessionId: string) => void;
  onSessionUpdate: (params: unknown) => void;
  onXaiNotification: (params: unknown) => void;
  log: (message: string) => void;
};

export type GrokAcpAttemptOutcome = {
  /** Session id confirmed by session/new (or the loaded id); null when the attempt died earlier. */
  sessionId: string | null;
  /** session/prompt response; null when the prompt never completed. */
  prompt: { stopReason: string; meta: Record<string, unknown> | null } | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  /** True only when the process closed with exit code 0 after stdin EOF. */
  cleanExit: boolean;
  spawnError?: Error;
  failure?: { phase: GrokAcpFailurePhase; error: Error };
};

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Cap on the JSON-RPC error `data` payload preserved in classification text. */
const ACP_ERROR_DATA_CAP = 256;

/**
 * Error message for classification/log surfaces, preserving the ACP
 * RequestError's `data` payload (length-capped, never the whole object
 * graph). The real unknown-model failure is `Invalid params` (-32602) with
 * the actual reason only in `data` ("unknown model id").
 */
function acpErrorDetail(err: unknown): string {
  const base = toError(err).message;
  if (!err || typeof err !== "object" || !("data" in err)) return base;
  const data = err.data;
  if (data === undefined || data === null) return base;
  const text = typeof data === "string" ? data : JSON.stringify(data) || "";
  const capped = text.trim().slice(0, ACP_ERROR_DATA_CAP);
  return capped.length > 0 ? `${base} (data: ${capped})` : base;
}

/** Bounded wait for a reclaimed non-piped child to die after SIGKILL. */
const UNPIPED_RECLAIM_WAIT_MS = 5_000;

/**
 * Reclaim a spawned child whose stdio turned out not to be piped (defensive
 * branch — a non-piped child cannot be negotiated with). Fail closed with an
 * immediate process-tree SIGKILL, then bounded-wait for the close so the
 * caller never returns while the process is still running. The close waiter
 * is registered BEFORE the kill (and an already-exited child short-circuits)
 * so a fast close is never missed behind the full deadline.
 */
async function reclaimUnpipedChild(child: {
  pid?: number | undefined;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "close", listener: () => void): unknown;
}): Promise<void> {
  const waiter = new Promise<void>((resolve) => {
    const deadline = setTimeout(resolve, UNPIPED_RECLAIM_WAIT_MS);
    deadline.unref?.();
    child.once("close", () => {
      clearTimeout(deadline);
      resolve();
    });
  });
  if (child.exitCode !== null && child.exitCode !== undefined) return;
  if (child.signalCode !== null && child.signalCode !== undefined) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // The process may already be gone.
  }
  await waiter;
}

function asMeta(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Strict same-session gate for config-confirmation echos: a MISSING session id rejects. */
function routedSessionIdEqualsCurrent(routedSessionId: string | null, currentSessionId: string | null): boolean {
  return routedSessionId !== null && currentSessionId !== null && routedSessionId === currentSessionId;
}

/**
 * Prompt correlation id carried on a routed notification, when present:
 * `_meta.promptId` (extension envelopes) or the snake/camel `prompt_id` on
 * the update payload (e.g. `turn_completed`).
 */
function notificationPromptId(params: unknown): string | null {
  const record = asMeta(params);
  const meta = asMeta(record?._meta);
  if (typeof meta?.promptId === "string") return meta.promptId;
  const update = asMeta(record?.update);
  if (typeof update?.prompt_id === "string") return update.prompt_id;
  if (typeof update?.promptId === "string") return update.promptId;
  return null;
}

/**
 * Run one ACP turn attempt against a fresh Grok process. Never throws: every
 * failure mode lands in the returned outcome for the handler to classify
 * (spawn error / protocol failure phase / stderr tail + exit status).
 */
export async function runGrokAcpAttempt(input: GrokAcpAttemptInput): Promise<GrokAcpAttemptOutcome> {
  let supervised: ReturnType<ProviderProcessSupervisor["spawn"]>;
  try {
    supervised = input.supervisor.spawn({
      command: input.binary,
      args: input.args,
      label: input.label,
      options: {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // POSIX: own process group so abort kills the whole tree (mirrors the
        // opencode handler's terminate path).
        ...(process.platform === "win32" ? {} : { detached: true }),
      },
    });
  } catch (err) {
    return {
      sessionId: null,
      prompt: null,
      exitCode: null,
      signal: null,
      stderrTail: "",
      cleanExit: false,
      spawnError: toError(err),
    };
  }
  const child = supervised.child;
  if (!child.stdin || !child.stdout || !child.stderr) {
    await reclaimUnpipedChild(child);
    return {
      sessionId: null,
      prompt: null,
      exitCode: null,
      signal: null,
      stderrTail: "",
      cleanExit: false,
      spawnError: new Error("grok ACP child stdio is not piped"),
    };
  }
  const childStdin = child.stdin;
  const childStdout = child.stdout;
  const childStderr = child.stderr;

  let stderrTail = "";
  let spawnError: Error | undefined;
  let closed: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
  let terminated = false;
  let hardKill: NodeJS.Timeout | null = null;
  let finalDeadline: NodeJS.Timeout | null = null;
  let resolveClose: () => void = () => {};
  const closeWait = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  const killTree = (signal: NodeJS.Signals): void => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The process may already be gone.
    }
  };

  /**
   * The SIGKILL/final-deadline timers MUST be cancelled once the child really
   * closes: on POSIX the kill targets a PGID, and a stale timer can fire
   * against a REUSED PGID under short-process high concurrency, killing an
   * unrelated later turn.
   */
  const clearTerminateTimers = (): void => {
    if (hardKill) {
      clearTimeout(hardKill);
      hardKill = null;
    }
    if (finalDeadline) {
      clearTimeout(finalDeadline);
      finalDeadline = null;
    }
  };

  const killGraceMs = input.killGraceMs ?? KILL_GRACE_MS;

  const terminate = (): void => {
    if (terminated) return;
    terminated = true;
    killTree("SIGTERM");
    hardKill = setTimeout(() => killTree("SIGKILL"), killGraceMs);
    hardKill.unref?.();
    finalDeadline = setTimeout(() => {
      closed ??= { exitCode: null, signal: "SIGKILL" };
      resolveClose();
    }, killGraceMs + FINAL_CLOSE_WAIT_MS);
    finalDeadline.unref?.();
  };

  childStderr.setEncoding("utf8");
  childStderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
  });
  childStderr.on("error", () => {
    /* tail stays best-effort */
  });
  child.on("error", (err) => {
    spawnError = toError(err);
    closed ??= { exitCode: null, signal: null };
    clearTerminateTimers();
    resolveClose();
  });
  child.on("close", (exitCode, signal) => {
    closed = { exitCode, signal };
    clearTerminateTimers();
    resolveClose();
  });

  // Replay-fence state (see module doc): only notifications that belong to
  // the CURRENT prompt may reach the handler. `lastInboundAt` is stamped by
  // the notification PARSERS — the SDK runs them synchronously at receipt,
  // while handlers dispatch asynchronously (a post-load replay message is
  // often dispatched only after our continuation already resumed), so the
  // fence cannot key off handler-dispatch order alone.
  let currentSessionId: string | null = null;
  let promptSent = false;
  let replayDrops = 0;
  let lastInboundAt = 0;
  /** Client-generated correlation id for the in-flight prompt (null until sent). */
  let attemptPromptId: string | null = null;
  /**
   * Latest `model_changed` echo, tagged with its RECEIPT-TIME ingress
   * sequence. Internal config confirmation ONLY — intercepted here and never
   * delivered to the handler, so it cannot become a user-facing event or
   * advance replay-safety state.
   */
  let modelChangedEcho: { modelId: string | null; reasoningEffort: string | null; seq: number } | null = null;
  const echoWaiters = new Set<() => void>();
  let cancelEchoWait: (() => void) | null = null;
  /**
   * Monotonic receipt clock, stamped by the notification PARSERS — the SDK
   * runs them synchronously at ingress, while handlers dispatch
   * asynchronously. The echo confirmation baseline is taken from THIS clock,
   * so a legacy echo received before the waiter armed can never satisfy it,
   * even when its dispatch lands after arming.
   */
  let ingressSeq = 0;
  const pendingNotifications = new Set<Promise<void>>();

  const routeNotification = (
    envelope: { params: unknown; seq: number },
    deliver: (value: unknown) => void,
    channel: string,
  ): void => {
    const { params, seq } = envelope;
    // Exact replay contract (Grok's own headless uses it): a notification
    // marked `_meta.isReplay === true` is ALWAYS historical, regardless of
    // when it arrives — drop it even inside the prompt window.
    if (grokNotificationIsReplay(params)) {
      if (replayDrops < REPLAY_DROP_LOG_LIMIT) {
        input.log(`grok ACP: dropped replay-marked ${channel} notification (_meta.isReplay)`);
      }
      replayDrops++;
      return;
    }
    // Config-confirmation echo: capture ONLY the exact
    // `_x.ai/session_notification` channel with a STRICT same-session id
    // (missing sessionId = reject), wake any armed waiter, and never deliver
    // onward. Identically-shaped payloads on other channels continue through
    // the normal fence/normalization — they never confirm configuration.
    if (channel === "_x.ai/session_notification") {
      const echo = parseGrokModelChangedEcho(params);
      if (echo && routedSessionIdEqualsCurrent(grokNotificationSessionId(params), currentSessionId)) {
        modelChangedEcho = { ...echo, seq };
        for (const waiter of [...echoWaiters]) waiter();
        return;
      }
    }
    const routedSessionId = grokNotificationSessionId(params);
    if (currentSessionId && routedSessionId && routedSessionId !== currentSessionId) {
      input.log(`grok ACP: dropped ${channel} notification for foreign session ${routedSessionId}`);
      return;
    }
    if (!promptSent) {
      if (replayDrops < REPLAY_DROP_LOG_LIMIT) {
        input.log(`grok ACP: dropped pre-prompt ${channel} notification (session/load replay fence)`);
      }
      replayDrops++;
      return;
    }
    // Prompt correlation: anything stamped with a DIFFERENT prompt id than
    // the in-flight prompt belongs to another prompt (e.g. history) — drop.
    const correlatedPromptId = notificationPromptId(params);
    if (attemptPromptId && correlatedPromptId && correlatedPromptId !== attemptPromptId) {
      input.log(`grok ACP: dropped ${channel} notification for foreign prompt ${correlatedPromptId}`);
      return;
    }
    const tracked = Promise.resolve()
      .then(() => deliver(params))
      .then(
        () => {},
        (err: unknown) => {
          input.log(`grok ACP: ${channel} notification handling failed: ${toError(err).message}`);
        },
      );
    pendingNotifications.add(tracked);
    void tracked.then(() => pendingNotifications.delete(tracked));
  };

  /**
   * Bounded wait for THIS set_model's effective-value `model_changed` echo.
   * The arm-time baseline is the ingress receipt clock: only an echo RECEIVED
   * after arming can satisfy, and it must match BOTH the effective model and
   * the requested effort. Diagnostics report only POST-arm candidates — a
   * pre-arm stale echo is never claimed as "observed". `cancel` cleans up
   * AND settles with an explicit cancelled outcome (used by the abort path
   * and every config-phase failure exit; no lingering timer/closure).
   */
  const waitForModelChangedEcho = (
    expectedModelId: string,
    expectedEffort: string,
  ): { promise: Promise<{ ok: true } | { ok: false; observed: string }>; cancel: () => void } => {
    const armSeq = ingressSeq;
    let lastPostArmCandidate: { modelId: string | null; reasoningEffort: string | null } | null = null;
    let settled = false;
    let settle: (result: { ok: true } | { ok: false; observed: string }) => void = () => {};
    const promise = new Promise<{ ok: true } | { ok: false; observed: string }>((resolve) => {
      settle = resolve;
    });
    const finish = (result: { ok: true } | { ok: false; observed: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      echoWaiters.delete(check);
      settle(result);
    };
    const matches = (): boolean =>
      modelChangedEcho !== null &&
      modelChangedEcho.seq > armSeq &&
      modelChangedEcho.modelId === expectedModelId &&
      modelChangedEcho.reasoningEffort === expectedEffort;
    const deadline = setTimeout(() => {
      finish({
        ok: false,
        observed: lastPostArmCandidate
          ? `echo reported model ${lastPostArmCandidate.modelId ?? "(none)"} effort ${lastPostArmCandidate.reasoningEffort ?? "(none)"}`
          : "no current model_changed echo received",
      });
    }, input.setModelEchoWaitMs ?? GROK_SET_MODEL_ECHO_WAIT_MS);
    deadline.unref?.();
    const check = (): void => {
      if (modelChangedEcho && modelChangedEcho.seq > armSeq) {
        lastPostArmCandidate = modelChangedEcho;
      }
      if (!matches()) return;
      finish({ ok: true });
    };
    echoWaiters.add(check);
    check();
    return {
      promise,
      cancel: () => finish({ ok: false, observed: "echo wait cancelled" }),
    };
  };

  // The passthrough parser keeps raw params so events.ts owns ALL tolerant
  // normalization in one tested layer; the SDK's generated schemas must not
  // silently strip `_meta` (x.ai tool metadata) or reject unknown update
  // kinds. The parser ALSO stamps the ingress receipt clock — it runs
  // synchronously at receipt, so this is the trustworthy time boundary (the
  // handler dispatch that follows is asynchronous).
  const passthrough = (params: unknown): { params: unknown; seq: number } => {
    lastInboundAt = Date.now();
    ingressSeq++;
    return { params, seq: ingressSeq };
  };
  const app = client({ name: "first-tree" })
    .onNotification("session/update", passthrough, (context) =>
      routeNotification(context.params, input.onSessionUpdate, "session/update"),
    )
    .onNotification("_x.ai/session_notification", passthrough, (context) =>
      routeNotification(context.params, input.onXaiNotification, "_x.ai/session_notification"),
    )
    .onNotification("_x.ai/session/update", passthrough, (context) =>
      routeNotification(context.params, input.onXaiNotification, "_x.ai/session/update"),
    )
    .onRequest("session/request_permission", () => {
      // Must never fire under --always-approve + yoloMode. Fail closed:
      // cancel, never auto-approve.
      input.log(
        "grok ACP: refused unexpected session/request_permission under --always-approve (provider misbehavior)",
      );
      return { outcome: { outcome: "cancelled" as const } };
    });

  const stream = ndJsonStream(Writable.toWeb(childStdin), Readable.toWeb(childStdout));
  const connection = app.connect(stream);
  const agent = connection.agent;

  let promptInFlight = false;
  const onAbort = (): void => {
    // Cancel any armed echo wait FIRST — an abort must never linger behind a
    // config-confirmation timeout, and the settled-cancel path upstream
    // ensures NO configuration terminal/ACK is produced.
    cancelEchoWait?.();
    if (promptInFlight && currentSessionId) {
      // Best-effort cooperative cancel BEFORE the SIGTERM path.
      void agent.notify("session/cancel", { sessionId: currentSessionId }).catch(() => {});
    }
    terminate();
  };
  input.abortSignal.addEventListener("abort", onAbort, { once: true });

  const outcome = (): GrokAcpAttemptOutcome => ({
    sessionId: currentSessionId,
    prompt: promptResult,
    exitCode: closed?.exitCode ?? null,
    signal: closed?.signal ?? null,
    stderrTail,
    cleanExit: closed?.exitCode === 0,
    ...(spawnError ? { spawnError } : {}),
    ...(failure ? { failure } : {}),
  });

  /**
   * Drain the routed-handler queue to a STABLE empty. The SDK dispatches
   * notification handlers asynchronously, so after the connection closes a
   * dispatch chain may still be queued behind a macrotask; settlement state
   * must not be read until every routed notification has landed.
   */
  const drainPendingNotifications = async (): Promise<void> => {
    for (let idlePasses = 0, guard = 0; guard < 50; guard++) {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      if (pendingNotifications.size === 0) {
        idlePasses++;
        if (idlePasses >= 2) return;
        continue;
      }
      idlePasses = 0;
      await Promise.all([...pendingNotifications]);
    }
  };

  /**
   * Unified transport-settle barrier (success AND failure paths):
   * EOF/terminate FIRST, then a bounded wait for the real child close and
   * the connection teardown, then drain the routed-handler queue — only
   * then may the caller read settlement state.
   */
  const settleBarrier = async (): Promise<void> => {
    try {
      childStdin.end();
    } catch {
      /* already gone */
    }
    if (input.abortSignal.aborted) terminate();
    const eofDeadline = setTimeout(() => {
      input.log("grok ACP: process did not exit after stdin EOF; terminating the process tree");
      terminate();
    }, input.eofCloseWaitMs ?? FINAL_CLOSE_WAIT_MS);
    eofDeadline.unref?.();
    await closeWait;
    clearTimeout(eofDeadline);
    try {
      await connection.closed;
    } catch {
      // Connection teardown errors carry no extra settlement signal.
    }
    await drainPendingNotifications();
  };

  const failAndDrain = async (phase: GrokAcpFailurePhase, err: unknown): Promise<GrokAcpAttemptOutcome> => {
    failure = { phase, error: new Error(acpErrorDetail(err)) };
    // Same settle barrier as the success path: EOF first, bounded close
    // wait, connection teardown, stable handler drain. terminate only fires
    // on abort or when the EOF grace expires — so write/usage notifications
    // dispatched on the tick AFTER a JSON-RPC error are not cut off.
    await settleBarrier();
    return outcome();
  };

  let failure: { phase: GrokAcpFailurePhase; error: Error } | undefined;
  let promptResult: GrokAcpAttemptOutcome["prompt"] = null;

  try {
    // 1. initialize — deliberately EMPTY clientCapabilities (see module doc).
    let initResponse: InitializeResponse;
    try {
      initResponse = await agent.request("initialize", {
        protocolVersion: GROK_ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "first-tree", version: input.clientVersion },
      });
    } catch (err) {
      return await failAndDrain("initialize", err);
    }
    if (initResponse.protocolVersion !== GROK_ACP_PROTOCOL_VERSION) {
      return await failAndDrain(
        "initialize",
        new Error(
          `grok provider mismatch: ACP protocolVersion ${String(initResponse.protocolVersion)} ` +
            `(expected ${GROK_ACP_PROTOCOL_VERSION})`,
        ),
      );
    }
    const agentCapabilities = initResponse.agentCapabilities;
    if (input.resumeSessionId && agentCapabilities?.loadSession !== true) {
      return await failAndDrain(
        "initialize",
        new Error("grok provider mismatch: agent does not advertise session/load capability required for resume"),
      );
    }
    const mcpCapabilities: GrokAcpMcpCapabilities = {
      http: agentCapabilities?.mcpCapabilities?.http === true,
      sse: agentCapabilities?.mcpCapabilities?.sse === true,
    };
    input.onInitialized?.();
    const initializeModelState = parseGrokModelState(initResponse);

    // 2. session/new (first turn) or session/load (resume). A session/load
    // failure is terminal for the attempt — never silently re-run as
    // session/new (a fresh session could re-execute side effects).
    // `_meta.noReplay: true` is the exact replay contract Grok's own headless
    // resume sends; historical traffic is additionally dropped via the
    // `_meta.isReplay` marker and (legacy fallback) the pre-prompt fence.
    const mappedServers = mapGrokAcpMcpServers(input.mcpServers, mcpCapabilities, input.log);
    if (input.resumeSessionId) {
      try {
        await agent.request("session/load", {
          sessionId: input.resumeSessionId,
          cwd: input.cwd,
          mcpServers: mappedServers,
          _meta: { yoloMode: true, noReplay: true },
        });
      } catch (err) {
        return await failAndDrain("session_load", err);
      }
      currentSessionId = input.resumeSessionId;
    } else {
      let newSessionResponse: NewSessionResponse;
      try {
        newSessionResponse = await agent.request("session/new", {
          cwd: input.cwd,
          mcpServers: mappedServers,
          _meta: { yoloMode: true },
        });
      } catch (err) {
        return await failAndDrain("session_new", err);
      }
      currentSessionId = newSessionResponse.sessionId;
    }
    input.onSessionId?.(currentSessionId);

    if (input.resumeSessionId) {
      // Replay drain: historical updates arrive right after the load
      // response; wait until the inbound channel goes quiet before arming
      // the model_changed confirmation and sending the current prompt.
      // Everything received during the drain is dropped by the pre-prompt
      // fence above, so no stale echo can satisfy the confirmation.
      lastInboundAt = Date.now();
      const drainStart = lastInboundAt;
      const drainCapMs = input.replayDrainCapMs ?? GROK_ACP_REPLAY_DRAIN_CAP_MS;
      for (;;) {
        const quietFor = Date.now() - lastInboundAt;
        if (quietFor >= GROK_ACP_REPLAY_QUIET_MS) break;
        if (Date.now() - drainStart >= drainCapMs) {
          if (input.reasoningEffort) {
            // Fail closed: the wire has no request/event id, so a drain that
            // never went quiet cannot prove a late same-value echo belongs to
            // THIS turn's set_model — an unproven drain is a configuration
            // mismatch, never a completed quiet drain.
            return await failAndDrain(
              "session_load",
              new Error(
                `grok provider mismatch: session/load replay drain did not go quiet within ${drainCapMs}ms; ` +
                  "cannot trust effort confirmation for an explicit effort",
              ),
            );
          }
          input.log("grok ACP: replay drain hit its cap; proceeding with the prompt");
          break;
        }
        if (input.abortSignal.aborted) break;
        await new Promise((resolve) => {
          setTimeout(resolve, Math.min(GROK_ACP_REPLAY_QUIET_MS - quietFor, 25));
        });
      }
      if (replayDrops > 0) {
        input.log(`grok ACP: replay fence dropped ${replayDrops} historical notification(s) after session/load`);
      }
    }

    // 2b. Apply model/effort after EVERY session open, every turn (Grok's
    // headless apply_headless_model_and_effort does the same after
    // open_session): session/load restores the session's PERSISTED
    // selection, so even an EMPTY config must re-assert the default — empty
    // model = the INITIALIZE-advertised current model (NOT the load-restored
    // one), empty effort = no effort meta (provider default). A set_model
    // rejection is a configuration failure — never silently fall back to the
    // persisted selection. Fail closed when the provider advertised no
    // current model to apply.
    const effectiveModelId = input.model || initializeModelState.defaultModelId;
    if (!effectiveModelId) {
      return await failAndDrain(
        "set_model",
        new Error("grok provider mismatch: the provider advertised no current model to apply for this turn"),
      );
    }
    // Arm the effort-echo waiter BEFORE the request — the model_changed echo
    // can precede the JSON-RPC response (observed same-millisecond on the
    // live wire). Empty effort keeps "remove override" semantics: the
    // provider default may itself carry an effort, so no echo is required.
    const effortEchoWait = input.reasoningEffort
      ? waitForModelChangedEcho(effectiveModelId, input.reasoningEffort)
      : null;
    cancelEchoWait = effortEchoWait?.cancel ?? null;
    try {
      const setModelResponse: unknown = await agent.request("session/set_model", {
        sessionId: currentSessionId,
        modelId: effectiveModelId,
        // Empty effort must OMIT `_meta` entirely — serializing null is not
        // the same as omitting the effort meta (it would not restore the
        // provider default).
        ...(input.reasoningEffort ? { _meta: { reasoningEffort: input.reasoningEffort } } : {}),
      });
      // The success shape (verified live on 0.2.117) is
      // `_meta.model.Ok === <applied modelId>`; anything else is provider
      // misbehavior — fail closed, never prompt under an unverified model.
      const setModelResult = asMeta(asMeta(asMeta(setModelResponse)?._meta)?.model);
      const appliedModelId = typeof setModelResult?.Ok === "string" ? setModelResult.Ok : null;
      if (appliedModelId !== effectiveModelId) {
        cancelEchoWait?.();
        cancelEchoWait = null;
        return await failAndDrain(
          "set_model",
          new Error(
            `grok provider mismatch: session/set_model response did not confirm model "${effectiveModelId}" ` +
              `(got ${appliedModelId ?? "no _meta.model.Ok"})`,
          ),
        );
      }
    } catch (err) {
      cancelEchoWait?.();
      cancelEchoWait = null;
      return await failAndDrain(
        "set_model",
        new Error(
          `grok provider mismatch: session/set_model rejected model "${effectiveModelId}"` +
            `${input.reasoningEffort ? ` with effort "${input.reasoningEffort}"` : ""}: ${acpErrorDetail(err)}`,
        ),
      );
    }
    if (effortEchoWait) {
      // model_switch.rs (upstream dd04f397): when the selected model does not
      // support reasoning effort, set_model IGNORES the override but still
      // returns a successful _meta.model.Ok — only the effective-value
      // model_changed echo proves the effort was applied.
      const echoConfirmation = await effortEchoWait.promise;
      cancelEchoWait = null; // settled either way; the waiter's own cleanup ran
      if (input.abortSignal.aborted) {
        // Abort raced the confirmation (onAbort settled the wait): tear the
        // transport down, but the upstream abort gate ensures NO
        // configuration terminal/ACK lands from this path.
        return await failAndDrain("prompt", new Error("grok ACP attempt aborted during effort confirmation"));
      }
      if (!echoConfirmation.ok) {
        return await failAndDrain(
          "set_model",
          new Error(
            `grok provider mismatch: reasoning effort "${input.reasoningEffort}" was not confirmed on model ` +
              `"${effectiveModelId}" (observed: ${echoConfirmation.observed})`,
          ),
        );
      }
    }

    // 3. session/prompt — the replay fence opens only now. A client-generated
    // promptId rides `_meta.promptId` (Grok honors it); notifications and the
    // prompt RESPONSE are correlated against it.
    attemptPromptId = randomUUID();
    promptSent = true;
    promptInFlight = true;
    try {
      const promptResponse = await agent.request("session/prompt", {
        sessionId: currentSessionId,
        prompt: [{ type: "text", text: input.promptText }],
        _meta: { promptId: attemptPromptId },
      });
      const responseMeta = asMeta(promptResponse._meta);
      const responsePromptId = typeof responseMeta?.promptId === "string" ? responseMeta.promptId : null;
      if (responsePromptId !== attemptPromptId) {
        // Exact-correlation contract: the response MUST echo the client
        // promptId — a missing or different one fails closed.
        return await failAndDrain(
          "prompt",
          new Error(
            `grok provider mismatch: prompt response carried promptId ${responsePromptId ?? "(none)"} ` +
              `(expected ${attemptPromptId})`,
          ),
        );
      }
      promptResult = { stopReason: promptResponse.stopReason, meta: responseMeta };
    } catch (err) {
      return await failAndDrain("prompt", err);
    } finally {
      promptInFlight = false;
    }

    // 4. Settlement barrier: EOF first, then a bounded wait for the real
    // close + connection teardown, then drain the routed-handler queue to a
    // stable empty — settlement state is read only after late-dispatched
    // notifications have landed. A process that answered the prompt but
    // never exits is reclaimed through the terminate path and lands as a
    // non-clean exit (a failure input, never a silent success).
    await settleBarrier();
    return outcome();
  } finally {
    input.abortSignal.removeEventListener("abort", onAbort);
    cancelEchoWait?.();
    if (!closed) terminate();
  }
}

export type GrokAcpModelStateFetch = { ok: true; meta: Record<string, unknown> | null } | { ok: false; error: string };

/**
 * Initialize-only ACP handshake for model discovery: spawn the CLI, run
 * `initialize` (unauthenticated metadata — never touches credentials),
 * capture the response `_meta`, then reclaim the process through a bounded
 * EOF→close barrier. EVERY path reclaims the child: stdin EOF, then a
 * bounded wait, then process-tree terminate. Success requires a clean
 * exit 0 — an early return after initialize would leak the process and ACK
 * a catalog whose transport never drained.
 */
export async function fetchGrokAcpInitializeMeta(input: {
  binary: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  clientVersion: string;
  /** Bounded wait for process close after stdin EOF (tests shorten this). */
  eofCloseWaitMs?: number;
}): Promise<GrokAcpModelStateFetch> {
  const eofCloseWaitMs = input.eofCloseWaitMs ?? FINAL_CLOSE_WAIT_MS;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(input.binary, [...GROK_ACP_BASE_ARGS, "stdio"], {
      env: input.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
  } catch (err) {
    return { ok: false, error: toError(err).message };
  }
  if (!child.stdin || !child.stdout) {
    await reclaimUnpipedChild(child);
    return { ok: false, error: "grok ACP child stdio is not piped" };
  }
  const childStdin = child.stdin;
  const childStdout = child.stdout;

  let stderrTail = "";
  let spawnError: Error | undefined;
  let closed: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
  let resolveClose: () => void = () => {};
  const closeWait = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const killTree = (signal: NodeJS.Signals): void => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The process may already be gone.
    }
  };
  let terminated = false;
  let hardKill: NodeJS.Timeout | null = null;
  let finalDeadline: NodeJS.Timeout | null = null;
  /** Cancel pending kill timers once the child really closes (see the turn
   * transport: a stale timer can SIGKILL a REUSED PGID under concurrency). */
  const clearTerminateTimers = (): void => {
    if (hardKill) {
      clearTimeout(hardKill);
      hardKill = null;
    }
    if (finalDeadline) {
      clearTimeout(finalDeadline);
      finalDeadline = null;
    }
  };
  const terminate = (): void => {
    if (terminated) return;
    terminated = true;
    killTree("SIGTERM");
    hardKill = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
    hardKill.unref?.();
    finalDeadline = setTimeout(() => {
      closed ??= { exitCode: null, signal: "SIGKILL" };
      resolveClose();
    }, KILL_GRACE_MS + FINAL_CLOSE_WAIT_MS);
    finalDeadline.unref?.();
  };

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, input.timeoutMs);
  timer.unref?.();

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
  });
  child.on("error", (err) => {
    spawnError = toError(err);
    closed ??= { exitCode: null, signal: null };
    clearTerminateTimers();
    resolveClose();
  });
  child.on("close", (exitCode, signal) => {
    closed = { exitCode, signal };
    clearTerminateTimers();
    resolveClose();
  });

  const stream = ndJsonStream(Writable.toWeb(childStdin), Readable.toWeb(childStdout));
  const connection = client({ name: "first-tree" }).connect(stream);

  let meta: Record<string, unknown> | null = null;
  let initError: Error | null = null;
  try {
    const initResponse = await connection.agent.request("initialize", {
      protocolVersion: GROK_ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "first-tree", version: input.clientVersion },
    });
    if (initResponse.protocolVersion !== GROK_ACP_PROTOCOL_VERSION) {
      // The turn handler would reject the same build; the UI must not publish
      // a model catalog from an incompatible protocol.
      initError = new Error(
        `grok provider mismatch: ACP protocolVersion ${String(initResponse.protocolVersion)} ` +
          `(expected ${GROK_ACP_PROTOCOL_VERSION})`,
      );
    } else {
      meta = asMeta(initResponse._meta);
    }
  } catch (err) {
    initError = toError(err);
  }

  // Reclaim the process on EVERY path: EOF first, bounded wait, then
  // process-tree terminate. Never resolve while the child is still running.
  try {
    childStdin.end();
  } catch {
    /* already gone */
  }
  const eofDeadline = setTimeout(() => terminate(), eofCloseWaitMs);
  eofDeadline.unref?.();
  await closeWait;
  clearTimeout(eofDeadline);
  clearTimeout(timer);

  if (timedOut) return { ok: false, error: `grok ACP model discovery timed out after ${input.timeoutMs}ms` };
  if (spawnError) return { ok: false, error: spawnError.message };
  if (initError) return { ok: false, error: stderrTail.trim() || initError.message };
  // `closed` is assigned from event callbacks; read it through a function so
  // TS does not narrow it to null from the initializer (microsoft/TypeScript#9998).
  const finalClose = ((): { exitCode: number | null; signal: NodeJS.Signals | null } | null => closed)();
  if (finalClose?.exitCode !== 0) {
    return {
      ok: false,
      error:
        `grok ACP model discovery process exited ${finalClose?.exitCode ?? `signal ${finalClose?.signal ?? "unknown"}`} ` +
        "after initialize (exit 0 required)",
    };
  }
  return { ok: true, meta };
}
