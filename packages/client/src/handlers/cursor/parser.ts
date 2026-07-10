import {
  encodeProviderRetryEventMessage,
  type ProviderRetryEventName,
  type ReplaySafety,
  type RuntimeProvider,
  type SessionEvent,
  type ToolFileRef,
} from "@first-tree/shared";
import {
  buildProviderRetryEvent,
  classifyProviderFailure,
  decideProviderRetry,
  type ProviderFailureClassification,
} from "../../runtime/provider-retry-policy.js";
import { chunkAssistantText } from "../assistant-text.js";
import { formatAuthHint } from "../auth-error-hint.js";
import { resolveTurnSettlement, type TurnSettlement } from "../turn-settlement.js";

/**
 * Pure parser for the Cursor CLI `--output-format stream-json` event stream.
 *
 * The handler feeds each parsed JSON line into {@link consumeCursorEvent},
 * which folds it into a small mutable {@link CursorTurnState} and returns the
 * `SessionEvent`s to emit for that line. When the child process closes, the
 * handler calls {@link finalizeCursorTurn} to produce the terminal events
 * (token_usage / assistant_text / error / turn_end) and a settlement decision.
 *
 * Design notes:
 *   - Streaming `assistant` events are IGNORED. The authoritative full assistant
 *     text is the `result.result` string present on every successful turn, so
 *     assistant_text is emitted once at finalize (chunked). This keeps the
 *     parser robust regardless of whether `--stream-partial-output` was passed.
 *   - `thinking` is presence-only: one `thinking` event per `thinking:completed`
 *     (deltas are dropped so we don't emit per token).
 *   - The `result` event does NOT emit inline; finalize emits its derived events
 *     so wire ordering (usage → text → turn_end) is deterministic.
 */

const RESULT_PREVIEW_LIMIT = 400;
const ERROR_MESSAGE_LIMIT = 2000;

const CURSOR_PROVIDER: RuntimeProvider = "cursor";

/** Friendly `tool_call.name` per known Cursor tool union key. */
const TOOL_NAME_BY_UNION_KEY: Readonly<Record<string, string>> = {
  editToolCall: "edit",
  readToolCall: "read",
  shellToolCall: "shell",
};

/**
 * Sibling metadata keys that live under `event.tool_call` alongside the tool
 * union key. Skipped when locating the union key so a future metadata field
 * cannot be mistaken for the tool payload.
 */
const TOOL_CALL_META_KEYS: ReadonlySet<string> = new Set([
  "hookAdditionalContexts",
  "toolCallId",
  "startedAtMs",
  "completedAtMs",
]);

export type CursorUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** Per-turn mutable accumulator threaded through the stream. */
export type CursorTurnState = {
  sessionId: string | null;
  model: string | null;
  /** Tool-call `started` args captured by `call_id`, reattached on `completed`. */
  startedToolCalls: Map<string, { name: string; args: unknown }>;
  /** `system:init` seen — the provider was reached (replay safety: provider_entered). */
  sawInit: boolean;
  /**
   * A tool_call was emitted — a real side effect (edit/shell) may have run, so a
   * no-result crash must NOT replay the turn (replay safety: user_visible).
   */
  sawToolEffect: boolean;
  sawResult: boolean;
  resultText: string;
  usage: CursorUsage | null;
  isError: boolean;
};

export function createCursorTurnState(): CursorTurnState {
  return {
    sessionId: null,
    model: null,
    startedToolCalls: new Map(),
    sawInit: false,
    sawToolEffect: false,
    sawResult: false,
    resultText: "",
    usage: null,
    isError: false,
  };
}

/** Classification of a no-result process exit derived from the stderr tail. */
export type CursorNoResultKind = "auth" | "invalid_model" | "usage_limit" | "generic";

export type CursorFinalizeResult = {
  events: SessionEvent[];
  settlement: TurnSettlement;
};

/**
 * Fold one parsed stream-json event into `state` and return the events to emit
 * for it. `raw` is the already-`JSON.parse`d line; malformed lines are handled
 * (skipped) by the caller before reaching here.
 */
export function consumeCursorEvent(state: CursorTurnState, raw: unknown): SessionEvent[] {
  const event = asRecord(raw);
  if (!event) return [];
  const type = getString(event, "type");
  if (!type) return [];

  switch (type) {
    case "system":
      return consumeSystem(state, event);
    case "thinking":
      return consumeThinking(event);
    case "tool_call":
      return consumeToolCall(state, event);
    case "result":
      return consumeResult(state, event);
    // `user` (our echoed prompt) and `assistant` (streaming text) are ignored
    // for emission — see the module header for the assistant-text rationale.
    default:
      return [];
  }
}

function consumeSystem(state: CursorTurnState, event: Record<string, unknown>): SessionEvent[] {
  if (getString(event, "subtype") !== "init") return [];
  state.sawInit = true;
  state.sessionId = getString(event, "session_id") ?? state.sessionId;
  state.model = getString(event, "model") ?? state.model;
  return [];
}

function consumeThinking(event: Record<string, unknown>): SessionEvent[] {
  // One presence-only marker per completed thinking block; deltas are dropped.
  if (getString(event, "subtype") !== "completed") return [];
  return [{ kind: "thinking", payload: {} }];
}

function consumeToolCall(state: CursorTurnState, event: Record<string, unknown>): SessionEvent[] {
  const subtype = getString(event, "subtype");
  const callId = getString(event, "call_id");
  const toolCall = getRecord(event, "tool_call");
  if (!callId || !toolCall) return [];

  const unionKey = findToolUnionKey(toolCall);
  if (!unionKey) return [];
  const unionValue = getRecord(toolCall, unionKey);
  const name = TOOL_NAME_BY_UNION_KEY[unionKey] ?? unionKey;
  const args = unionValue ? unionValue.args : undefined;

  if (subtype === "started") {
    state.sawToolEffect = true;
    state.startedToolCalls.set(callId, { name, args });
    return [{ kind: "tool_call", payload: { toolUseId: callId, name, args, status: "pending" } }];
  }

  if (subtype === "completed") {
    state.sawToolEffect = true;
    const started = state.startedToolCalls.get(callId);
    state.startedToolCalls.delete(callId);
    const effectiveArgs = args ?? started?.args;
    const effectiveName = started?.name ?? name;
    const result = unionValue ? getRecord(unionValue, "result") : null;
    const status = toolStatus(result);
    const durationMs = toolDurationMs(toolCall);
    const resultPreview = toolResultPreview(unionKey, result);
    const toolFileRefs = toolFileRefsFor(unionKey, effectiveArgs);
    return [
      {
        kind: "tool_call",
        payload: {
          toolUseId: callId,
          name: effectiveName,
          args: effectiveArgs,
          status,
          ...(durationMs !== null ? { durationMs } : {}),
          ...(resultPreview ? { resultPreview: resultPreview.slice(0, RESULT_PREVIEW_LIMIT) } : {}),
          ...(toolFileRefs ? { toolFileRefs } : {}),
        },
      },
    ];
  }

  return [];
}

function consumeResult(state: CursorTurnState, event: Record<string, unknown>): SessionEvent[] {
  state.sawResult = true;
  state.resultText = getString(event, "result") ?? "";
  state.isError = getBoolean(event, "is_error") ?? false;
  state.sessionId = getString(event, "session_id") ?? state.sessionId;
  const usage = getRecord(event, "usage");
  if (usage) {
    state.usage = {
      inputTokens: getNumber(usage, "inputTokens") ?? 0,
      outputTokens: getNumber(usage, "outputTokens") ?? 0,
      cacheReadTokens: getNumber(usage, "cacheReadTokens") ?? 0,
      cacheWriteTokens: getNumber(usage, "cacheWriteTokens") ?? 0,
    };
  }
  // Emit nothing now — finalize emits the derived events in deterministic order.
  return [];
}

/**
 * Produce the terminal events + settlement for a closed turn.
 *
 * With a `result`: emit token_usage (when usage present), the full assistant
 * text (chunked, from `result.result`), then `turn_end`. `is_error` maps to a
 * consumed provider error; otherwise success.
 *
 * Without a `result` (process exited before completing — the error path):
 * classify the stderr tail and run it through the shared provider-retry policy
 * with replay safety derived from turn progress. Auth / invalid-model /
 * usage-limit are terminal (consumed error); a generic crash retries ONLY when
 * no tool side effect / user-visible output occurred, otherwise it too settles
 * terminal. Terminal failures also emit the encoded provider-retry event that
 * drives SessionManager's durable chat notice.
 */
export function finalizeCursorTurn(
  state: CursorTurnState,
  exitCode: number | null,
  stderrTail: string,
): CursorFinalizeResult {
  const events: SessionEvent[] = [];

  if (state.sawResult) {
    if (state.usage) {
      events.push({
        kind: "token_usage",
        payload: {
          provider: CURSOR_PROVIDER,
          model: state.model ?? "",
          // Cursor's `usage.inputTokens` is already the NON-cached prompt total
          // (disjoint from cacheReadTokens), matching the schema's `inputTokens`
          // — no subtraction needed.
          inputTokens: state.usage.inputTokens,
          cachedInputTokens: state.usage.cacheReadTokens,
          outputTokens: state.usage.outputTokens,
        },
      });
    }
    for (const chunk of chunkAssistantText(state.resultText)) {
      events.push({ kind: "assistant_text", payload: { text: chunk } });
    }
    events.push({ kind: "turn_end", payload: { status: state.isError ? "error" : "success" } });
    const settlement = state.isError
      ? resolveTurnSettlement({ consumedErrorReason: "provider_clean_error" })
      : resolveTurnSettlement({});
    return { events, settlement };
  }

  // No result — the process exited before completing. Route the failure through
  // the SAME shared provider-retry policy codex uses (classify → decide →
  // encode), so: (finding 1) a crash AFTER a tool side effect / user-visible
  // output settles as a terminal consumed error rather than replaying the turn,
  // and (finding 3) terminal failures emit the structured provider-retry event
  // SessionManager turns into a durable chat notice + ACK guard.
  const kind = classifyCursorNoResult(stderrTail);
  const humanMessage = buildNoResultMessage(kind, stderrTail.trim(), exitCode);
  const replaySafety = noResultReplaySafety(state, kind);
  const classification = classificationForNoResult(kind, humanMessage);
  const decision = decideProviderRetry({ classification, scope: "provider_turn", attempt: 1, replaySafety });
  const eventName: ProviderRetryEventName =
    decision.action === "retry"
      ? "provider_retry_scheduled"
      : decision.terminalKind === "exhausted"
        ? "provider_retry_exhausted"
        : "provider_failure_terminal";
  const retryEventPayload = buildProviderRetryEvent({
    event: eventName,
    provider: CURSOR_PROVIDER,
    scope: "provider_turn",
    classification,
    decision,
    messagePreview: humanMessage,
  });

  // Structured event first (SessionManager decodes this for the durable notice),
  // then the human-readable error, then turn_end — mirroring codex's ordering.
  events.push({
    kind: "error",
    payload: { source: "runtime", message: encodeProviderRetryEventMessage(retryEventPayload) },
  });
  events.push({ kind: "error", payload: { source: "sdk", message: humanMessage.slice(0, ERROR_MESSAGE_LIMIT) } });
  events.push({ kind: "turn_end", payload: { status: "error" } });

  const settlement =
    decision.action === "retry"
      ? resolveTurnSettlement({ retryReason: decision.reasonCode })
      : resolveTurnSettlement({ consumedErrorReason: consumedReasonForDecision(decision) });
  return { events, settlement };
}

export function classifyCursorNoResult(stderrTail: string): CursorNoResultKind {
  if (/Authentication required|CURSOR_API_KEY/i.test(stderrTail)) return "auth";
  if (/Cannot use this model:/i.test(stderrTail)) return "invalid_model";
  if (/ActionRequiredError|usage limit/i.test(stderrTail)) return "usage_limit";
  return "generic";
}

/**
 * Replay safety for a no-result exit. A tool_call was emitted → a side effect
 * (edit/shell) may have run → `user_visible` (never replay). A classified
 * provider error (auth/model/quota) means the provider WAS reached even if the
 * `init` line was not parsed (auth exits before init) → `provider_entered`.
 * Otherwise a pre-provider crash is safe to replay.
 */
function noResultReplaySafety(state: CursorTurnState, kind: CursorNoResultKind): ReplaySafety {
  if (state.sawToolEffect) return "user_visible";
  if (state.sawInit || kind !== "generic") return "provider_entered";
  return "pre_provider";
}

/**
 * Build the failure classification for a no-result exit. cursor-agent's exact
 * stderr wordings (e.g. "Cannot use this model:") don't reliably trip the
 * generic text classifier, so the known cases are mapped explicitly; only the
 * generic case defers to `classifyProviderFailure`.
 */
function classificationForNoResult(kind: CursorNoResultKind, message: string): ProviderFailureClassification {
  switch (kind) {
    case "auth":
      return { category: "credential", reasonCode: "provider_credential_required", message, sourceKind: "permanent" };
    case "invalid_model":
      return {
        category: "configuration",
        reasonCode: "provider_configuration_error",
        message,
        sourceKind: "permanent",
      };
    case "usage_limit":
      return { category: "provider_capacity", reasonCode: "provider_usage_limit", message, sourceKind: "degraded" };
    case "generic":
      return classifyProviderFailure(new Error(message), {
        provider: CURSOR_PROVIDER,
        scope: "provider_turn",
        source: "sdk",
      });
  }
}

/** Map a terminal decision to the consumed-error reason, mirroring codex. */
function consumedReasonForDecision(
  decision: Extract<ReturnType<typeof decideProviderRetry>, { action: "stop" }>,
): string {
  return decision.terminalKind === "capacity_wait_required"
    ? "capacity_wait_required"
    : decision.terminalKind === "exhausted"
      ? "provider_retry_exhausted"
      : decision.reasonCode;
}

function buildNoResultMessage(kind: CursorNoResultKind, stderr: string, exitCode: number | null): string {
  if (kind === "auth") return formatAuthHint("cursor", stderr);
  if (stderr.length > 0) return stderr;
  return `cursor-agent exited (code ${exitCode ?? "null"}) without producing a result`;
}

// ---- tool-call helpers -----------------------------------------------------

/**
 * The tool union key is the first non-metadata key under `event.tool_call`
 * whose value is an object carrying `args` (e.g. `editToolCall`). Falls back to
 * the first non-metadata record key so a future tool shape still resolves a
 * name.
 */
function findToolUnionKey(toolCall: Record<string, unknown>): string | null {
  for (const key of Object.keys(toolCall)) {
    if (TOOL_CALL_META_KEYS.has(key)) continue;
    const value = getRecord(toolCall, key);
    if (value && "args" in value) return key;
  }
  for (const key of Object.keys(toolCall)) {
    if (TOOL_CALL_META_KEYS.has(key)) continue;
    if (getRecord(toolCall, key)) return key;
  }
  return null;
}

function toolStatus(result: Record<string, unknown> | null): "ok" | "error" {
  // `result.failure` (shell exit-nonzero, or any tool failure) → error;
  // `result.success` or no result → ok.
  if (result && getRecord(result, "failure")) return "error";
  return "ok";
}

function toolDurationMs(toolCall: Record<string, unknown>): number | null {
  const started = Number(getString(toolCall, "startedAtMs"));
  const completed = Number(getString(toolCall, "completedAtMs"));
  const delta = completed - started;
  if (!Number.isFinite(delta) || delta < 0) return null;
  return Math.trunc(delta);
}

function toolResultPreview(unionKey: string, result: Record<string, unknown> | null): string | undefined {
  if (!result) return undefined;
  const success = getRecord(result, "success");
  const failure = getRecord(result, "failure");

  if (unionKey === "shellToolCall") {
    const stdout = success ? getString(success, "stdout") : null;
    if (stdout && stdout.trim().length > 0) return stdout;
    const stderr = failure ? getString(failure, "stderr") : null;
    if (stderr && stderr.length > 0) return stderr;
  } else if (unionKey === "readToolCall") {
    const fileSize = success ? getNumber(success, "fileSize") : null;
    if (fileSize !== null) return `${fileSize} bytes`;
  } else if (unionKey === "editToolCall") {
    const message = success ? getString(success, "message") : null;
    if (message) return message;
  }

  // Generic fallback: a bounded JSON slice of whatever the result carried.
  const source = failure ?? success ?? result;
  try {
    return JSON.stringify(source).slice(0, RESULT_PREVIEW_LIMIT);
  } catch {
    return undefined;
  }
}

function toolFileRefsFor(unionKey: string, args: unknown): ToolFileRef[] | undefined {
  const argsRecord = asRecord(args);
  const path = argsRecord ? getString(argsRecord, "path") : null;
  if (!path) return undefined;
  if (unionKey === "editToolCall") {
    return [{ localPath: path, pathKind: "file", origin: "file_change" }];
  }
  if (unionKey === "readToolCall") {
    return [{ localPath: path, pathKind: "file", origin: "tool_arg" }];
  }
  return undefined;
}

// ---- JSON boundary narrowers -----------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // Untyped JSON boundary: cursor stream events are arbitrary JSON. Every field
  // is read through the typed getters below, so this single narrowing cast is
  // the only boundary assertion and stays contained here.
  return value as Record<string, unknown>;
}

function getRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return asRecord(record[key]);
}

function getString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function getNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}
