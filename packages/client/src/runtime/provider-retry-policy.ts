import type {
  ProviderFailureCategory,
  ProviderRetryEventName,
  ProviderRetryEventPayload,
  ProviderRetryScope,
  ReplaySafety,
  RuntimeProvider,
} from "@first-tree/shared";
import { type Classification, classify, ERROR_KINDS } from "./error-taxonomy.js";
import { redactErrorPreview } from "./redact-error-preview.js";

export type ProviderFailureClassification = {
  category: ProviderFailureCategory;
  reasonCode: string;
  message: string;
  retryAfterMs?: number;
  sourceKind: Classification["kind"];
};

export type ProviderRetryDecision =
  | {
      action: "retry";
      delayMs: number;
      reasonCode: string;
      attempt: number;
      maxAttempts?: number;
      retryMode: "foreground" | "background";
      replaySafety: ReplaySafety;
      userSeverity: "info" | "warning";
    }
  | {
      action: "stop";
      reasonCode: string;
      terminalKind: "deterministic" | "exhausted" | "unsafe_replay" | "needs_operator" | "capacity_wait_required";
      replaySafety: ReplaySafety;
      userSeverity: "warning" | "error";
    };

export type ProviderFailureSource = "session" | "stream" | "sdk" | "auth" | "bind";

const PROVIDER_TURN_MAX_RETRIES = 2;
const PROVIDER_TURN_DELAYS_MS = [500, 1500] as const;
const PROVIDER_TURN_CAPACITY_SHORT_WAIT_MS = 30_000;
const UNKNOWN_MAX_RETRIES = 2;
const UNKNOWN_DELAYS_MS = [5_000, 15_000] as const;
const SESSION_FOREGROUND_RETRIES = 3;
const SESSION_TRANSIENT_CAP_MS = 60_000;
const SESSION_CAPACITY_CAP_MS = 5 * 60_000;
const AUTH_HTTP_CODE_RE = /\b(401|403)\b/;
const TRANSIENT_HTTP_CODE_RE = /\b(500|502|503|504)\b/;

export function classifyProviderFailure(
  err: unknown,
  context: {
    provider: RuntimeProvider;
    scope: ProviderRetryScope;
    source?: ProviderFailureSource;
  },
): ProviderFailureClassification {
  const source = context.source === "sdk" ? undefined : context.source;
  const base = classify(err, source ? { source } : undefined);
  const shape = readErrorShape(err);
  const text = `${shape.name ?? ""} ${shape.message ?? ""} ${shape.code ?? ""} ${shape.reason ?? ""}`.toLowerCase();
  const retryAfterMs = readRetryAfterMs(shape);
  const status = shape.status ?? shape.statusCode;

  if (isBillingLimit(text)) {
    return {
      category: "provider_capacity",
      reasonCode: "provider_billing_limit",
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (isCredential(text, base, status, context.provider)) {
    return {
      category: "credential",
      reasonCode: credentialReason(base),
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (isCapability(text, base)) {
    return {
      category: "capability",
      reasonCode: base.reasonCode,
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (isConfiguration(text, base, context.provider)) {
    return {
      category: "configuration",
      reasonCode: configurationReason(base),
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (isDeterministicInput(text, base)) {
    return {
      category: "deterministic_input",
      reasonCode: deterministicReason(base),
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (isCapacity(text, base, retryAfterMs)) {
    return {
      category: "provider_capacity",
      reasonCode: capacityReason(text, base),
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if ((base.kind === ERROR_KINDS.TRANSIENT && base.reasonCode !== "unknown") || isTransportText(text)) {
    return {
      category: "transient_transport",
      reasonCode: transientReason(base, context.provider),
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (base.reasonCode === "unknown") {
    return { category: "unknown", reasonCode: "unknown", message: base.message, retryAfterMs, sourceKind: base.kind };
  }
  return {
    category: "unknown",
    reasonCode: base.reasonCode || "unknown",
    message: base.message,
    retryAfterMs,
    sourceKind: base.kind,
  };
}

export function decideProviderRetry(input: {
  classification: ProviderFailureClassification;
  scope: ProviderRetryScope;
  attempt: number;
  firstFailedAt?: number;
  retryAfterMs?: number;
  replaySafety: ReplaySafety;
}): ProviderRetryDecision {
  const attempt = Math.max(1, Math.floor(input.attempt));
  const retryAfterMs = input.retryAfterMs ?? input.classification.retryAfterMs;

  if (
    input.scope === "provider_turn" &&
    isUnsafeReplay(input.replaySafety) &&
    !isRetryableUserVisibleFailure(input.classification.category, input.replaySafety)
  ) {
    return stop("unsafe_replay", "unsafe_replay", input.replaySafety, "warning");
  }

  switch (input.classification.category) {
    case "credential":
      return stop(input.classification.reasonCode, "needs_operator", input.replaySafety, "error");
    case "capability":
    case "configuration":
      return stop(input.classification.reasonCode, "needs_operator", input.replaySafety, "error");
    case "deterministic_input":
      return stop(input.classification.reasonCode, "deterministic", input.replaySafety, "error");
    case "unknown":
      return decideUnknown(input.scope, attempt, input.replaySafety);
    case "transient_transport":
      return input.scope === "provider_turn"
        ? decideProviderTurnTransient(input.classification.reasonCode, attempt, input.replaySafety)
        : decideSessionTransient(input.classification.reasonCode, attempt, input.replaySafety);
    case "provider_capacity":
      return input.scope === "provider_turn"
        ? decideProviderTurnCapacity(input.classification.reasonCode, attempt, retryAfterMs, input.replaySafety)
        : decideSessionCapacity(input.classification.reasonCode, attempt, retryAfterMs, input.replaySafety);
  }
}

export function buildProviderRetryEvent(input: {
  event: ProviderRetryEventName;
  provider: RuntimeProvider;
  scope: ProviderRetryScope;
  classification: ProviderFailureClassification;
  decision?: ProviderRetryDecision;
  messagePreview?: string | null;
  now?: number;
}): ProviderRetryEventPayload {
  const retryDecision = input.decision?.action === "retry" ? input.decision : null;
  const severity =
    input.decision?.userSeverity ??
    (input.event === "provider_retry_exhausted" || input.event === "provider_failure_terminal" ? "error" : "info");
  return {
    event: input.event,
    provider: input.provider,
    scope: input.scope,
    category: input.classification.category,
    reasonCode: input.decision?.reasonCode ?? input.classification.reasonCode,
    ...(retryDecision ? { attempt: retryDecision.attempt } : {}),
    ...(retryDecision?.maxAttempts ? { maxAttempts: retryDecision.maxAttempts } : {}),
    ...(retryDecision ? { retryMode: retryDecision.retryMode } : {}),
    ...(retryDecision ? { delayMs: retryDecision.delayMs } : {}),
    ...(retryDecision
      ? { nextRetryAt: new Date((input.now ?? Date.now()) + retryDecision.delayMs).toISOString() }
      : {}),
    ...(input.decision?.replaySafety ? { replaySafety: input.decision.replaySafety } : {}),
    userSeverity: severity,
    ...(input.messagePreview ? { messagePreview: redactErrorPreview(input.messagePreview, 256) } : {}),
  };
}

export function maxProviderTurnRetryAttempts(): number {
  return PROVIDER_TURN_MAX_RETRIES;
}

function decideProviderTurnTransient(
  reasonCode: string,
  attempt: number,
  replaySafety: ReplaySafety,
): ProviderRetryDecision {
  if (attempt <= PROVIDER_TURN_MAX_RETRIES) {
    return retry(
      reasonCode,
      attempt,
      PROVIDER_TURN_MAX_RETRIES,
      PROVIDER_TURN_DELAYS_MS[attempt - 1] ?? 1500,
      "foreground",
      replaySafety,
      "info",
    );
  }
  return stop(`${reasonCode}_exhausted`, "exhausted", replaySafety, "error");
}

function decideProviderTurnCapacity(
  reasonCode: string,
  attempt: number,
  retryAfterMs: number | undefined,
  replaySafety: ReplaySafety,
): ProviderRetryDecision {
  if (reasonCode === "provider_billing_limit") {
    return stop(reasonCode, "capacity_wait_required", replaySafety, "error");
  }
  if (replaySafety === "pre_provider") {
    return decideProviderTurnTransient(reasonCode, attempt, replaySafety);
  }
  if (reasonCode === "provider_overloaded" && retryAfterMs === undefined) {
    if (attempt <= PROVIDER_TURN_MAX_RETRIES) {
      return retry(
        reasonCode,
        attempt,
        PROVIDER_TURN_MAX_RETRIES,
        PROVIDER_TURN_DELAYS_MS[attempt - 1] ?? 1500,
        "foreground",
        replaySafety,
        "warning",
      );
    }
    return stop(`${reasonCode}_exhausted`, "exhausted", replaySafety, "error");
  }
  if (retryAfterMs !== undefined && retryAfterMs <= PROVIDER_TURN_CAPACITY_SHORT_WAIT_MS) {
    if (attempt <= PROVIDER_TURN_MAX_RETRIES) {
      return retry(reasonCode, attempt, PROVIDER_TURN_MAX_RETRIES, retryAfterMs, "foreground", replaySafety, "warning");
    }
    return stop(`${reasonCode}_exhausted`, "exhausted", replaySafety, "error");
  }
  return stop("capacity_wait_required", "capacity_wait_required", replaySafety, "warning");
}

function decideSessionTransient(
  reasonCode: string,
  attempt: number,
  replaySafety: ReplaySafety,
): ProviderRetryDecision {
  const delayMs = Math.min(1000 * 2 ** (attempt - 1), SESSION_TRANSIENT_CAP_MS);
  return retry(
    reasonCode,
    attempt,
    undefined,
    delayMs,
    attempt <= SESSION_FOREGROUND_RETRIES ? "foreground" : "background",
    replaySafety,
    attempt <= SESSION_FOREGROUND_RETRIES ? "info" : "warning",
  );
}

function decideSessionCapacity(
  reasonCode: string,
  attempt: number,
  retryAfterMs: number | undefined,
  replaySafety: ReplaySafety,
): ProviderRetryDecision {
  const backoffMs = Math.min(1000 * 2 ** (attempt - 1), SESSION_CAPACITY_CAP_MS);
  return retry(reasonCode, attempt, undefined, retryAfterMs ?? backoffMs, "background", replaySafety, "warning");
}

function decideUnknown(scope: ProviderRetryScope, attempt: number, replaySafety: ReplaySafety): ProviderRetryDecision {
  if (attempt <= UNKNOWN_MAX_RETRIES) {
    return retry(
      "unknown",
      attempt,
      UNKNOWN_MAX_RETRIES,
      UNKNOWN_DELAYS_MS[attempt - 1] ?? 15_000,
      scope === "provider_turn" ? "foreground" : "foreground",
      replaySafety,
      "warning",
    );
  }
  return stop("unknown_exhausted", "exhausted", replaySafety, "error");
}

function retry(
  reasonCode: string,
  attempt: number,
  maxAttempts: number | undefined,
  delayMs: number,
  retryMode: "foreground" | "background",
  replaySafety: ReplaySafety,
  userSeverity: "info" | "warning",
): ProviderRetryDecision {
  return {
    action: "retry",
    delayMs,
    reasonCode,
    attempt,
    ...(maxAttempts ? { maxAttempts } : {}),
    retryMode,
    replaySafety,
    userSeverity,
  };
}

function stop(
  reasonCode: string,
  terminalKind: Extract<ProviderRetryDecision, { action: "stop" }>["terminalKind"],
  replaySafety: ReplaySafety,
  userSeverity: "warning" | "error",
): ProviderRetryDecision {
  return { action: "stop", reasonCode, terminalKind, replaySafety, userSeverity };
}

function isUnsafeReplay(replaySafety: ReplaySafety): boolean {
  return replaySafety === "user_visible" || replaySafety === "unsafe" || replaySafety === "unknown";
}

function isRetryableUserVisibleFailure(category: ProviderFailureCategory, replaySafety: ReplaySafety): boolean {
  return replaySafety === "user_visible" && (category === "provider_capacity" || category === "transient_transport");
}

type ErrorShape = {
  name?: string;
  message?: string;
  code?: string | number;
  status?: number;
  statusCode?: number;
  reason?: string;
  retryAfterMs?: number;
  retryAfter?: string | number;
};

function readErrorShape(err: unknown): ErrorShape {
  if (err instanceof Error) {
    const record = err as unknown as Record<string, unknown>;
    return {
      name: err.name,
      message: err.message,
      code: typeof record.code === "string" || typeof record.code === "number" ? record.code : undefined,
      status: typeof record.status === "number" ? record.status : undefined,
      statusCode: typeof record.statusCode === "number" ? record.statusCode : undefined,
      reason: typeof record.reason === "string" ? record.reason : undefined,
      retryAfterMs: typeof record.retryAfterMs === "number" ? record.retryAfterMs : undefined,
      retryAfter:
        typeof record.retryAfter === "string" || typeof record.retryAfter === "number" ? record.retryAfter : undefined,
    };
  }
  if (typeof err === "string") return { message: err };
  if (!err || typeof err !== "object") return { message: String(err) };
  const record = err as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? record.name : undefined,
    message: typeof record.message === "string" ? record.message : JSON.stringify(err),
    code: typeof record.code === "string" || typeof record.code === "number" ? record.code : undefined,
    status: typeof record.status === "number" ? record.status : undefined,
    statusCode: typeof record.statusCode === "number" ? record.statusCode : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    retryAfterMs: typeof record.retryAfterMs === "number" ? record.retryAfterMs : undefined,
    retryAfter:
      typeof record.retryAfter === "string" || typeof record.retryAfter === "number" ? record.retryAfter : undefined,
  };
}

function readRetryAfterMs(shape: ErrorShape): number | undefined {
  if (typeof shape.retryAfterMs === "number" && Number.isFinite(shape.retryAfterMs) && shape.retryAfterMs >= 0) {
    return Math.floor(shape.retryAfterMs);
  }
  if (typeof shape.retryAfter === "number" && Number.isFinite(shape.retryAfter) && shape.retryAfter >= 0) {
    return Math.floor(shape.retryAfter * 1000);
  }
  if (typeof shape.retryAfter === "string") {
    const numeric = Number(shape.retryAfter);
    if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric * 1000);
    const dateMs = Date.parse(shape.retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function isCredential(
  text: string,
  base: Classification,
  status: number | undefined,
  provider: RuntimeProvider,
): boolean {
  if (
    status === 401 ||
    status === 403 ||
    base.reasonCode.includes("auth") ||
    base.reasonCode.includes("unauthorized") ||
    AUTH_HTTP_CODE_RE.test(text) ||
    /unauthorized|forbidden|invalid api key|invalid_api_key|authentication|login required|not authenticated|oauth_org_not_allowed/.test(
      text,
    )
  ) {
    return true;
  }
  // Cursor CLI logged-out phrasings (kept in sync with isCursorAuthError in
  // handlers/auth-error-hint.ts). Provider-gated: the in-chat "Log in to
  // Cursor" CTA renders only for category=credential, so a wording variant
  // that drops the word "authentication" must still classify credential —
  // without leaking these generic phrases into other providers' traffic.
  return provider === "cursor" && /not logged in|agent login|cursor_api_key/.test(text);
}

function credentialReason(base: Classification): string {
  return base.reasonCode === "unknown" ? "provider_credential_required" : base.reasonCode;
}

function isCapability(text: string, base: Classification): boolean {
  return base.reasonCode.includes("binary_missing") || /binary missing|executable missing|unable to locate/.test(text);
}

function isConfiguration(text: string, base: Classification, provider: RuntimeProvider): boolean {
  if (
    base.reasonCode.includes("mismatch") ||
    /provider mismatch|runtime_provider_mismatch|bad config|sandbox|approval|model_not_found|model not found/.test(text)
  ) {
    return true;
  }
  // Cursor CLI literal invalid-model / explicit-deny / trust-wall phrasings
  // (captured in Phase 0). Gated to the cursor provider: this classifier is
  // shared and configuration wins over capacity in the classify chain, so an
  // ungated generic English phrase like "cannot use this model" could turn
  // another provider's retryable capacity message into a terminal stop.
  return (
    provider === "cursor" && /cannot use this model|blocked by permissions configuration|workspace trust/.test(text)
  );
}

function configurationReason(base: Classification): string {
  return base.reasonCode === "unknown" ? "provider_configuration_error" : base.reasonCode;
}

function isDeterministicInput(text: string, base: Classification): boolean {
  return (
    base.reasonCode.includes("context") ||
    /context length|context_length|context window|invalid request|invalid_request|bad request|max_output_tokens|error_max_turns|exceeded max turns|error_max_budget_usd|error_max_structured_output_retries/.test(
      text,
    ) ||
    (text.includes("ran out of room") && text.includes("context"))
  );
}

function deterministicReason(base: Classification): string {
  return base.reasonCode === "unknown" ? "provider_deterministic_input" : base.reasonCode;
}

function isCapacity(text: string, base: Classification, retryAfterMs: number | undefined): boolean {
  return (
    retryAfterMs !== undefined ||
    base.reasonCode.includes("rate_limit") ||
    /rate.?limit|usage limit|session limit|quota|insufficient_quota|overloaded|capacity/.test(text)
  );
}

function isTransportText(text: string): boolean {
  return (
    TRANSIENT_HTTP_CODE_RE.test(text) ||
    /server error|server_error|unavailable|timed out|timeout|fetch failed|network|unable to connect|connection refused|connectionrefused|econnreset|econnrefused|etimedout|epipe/.test(
      text,
    )
  );
}

function capacityReason(text: string, base: Classification): string {
  if (/usage limit|session limit|quota|insufficient_quota/.test(text)) return "provider_usage_limit";
  if (/overloaded|capacity/.test(text)) return "provider_overloaded";
  if (/rate.?limit/.test(text) || base.reasonCode.includes("rate_limit")) return "provider_rate_limited";
  return base.reasonCode === "unknown" ? "provider_capacity" : base.reasonCode;
}

function isBillingLimit(text: string): boolean {
  return (
    /billing_error|insufficient account balance|credit balance is too low|credits_required|out_of_credits/.test(text) ||
    (text.includes("billing") && text.includes("credit"))
  );
}

function transientReason(base: Classification, provider: RuntimeProvider): string {
  if (provider === "codex" && base.reasonCode.startsWith("claude_")) return "provider_transient_transport";
  return base.reasonCode === "unknown" ? "provider_transient_transport" : base.reasonCode;
}
