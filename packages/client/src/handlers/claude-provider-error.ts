import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";
import type { ReplaySafety } from "@first-tree/shared";
import type { ProviderAttemptSignal } from "../runtime/provider-attempt.js";
import type { ProviderFailureClassification } from "../runtime/provider-retry-policy.js";
import { formatProviderFailureRuntimeNotice, isEgressForbiddenText } from "../runtime/runtime-notice.js";

type ClaudeProviderErrorShape = {
  name: "ClaudeSdkProviderError";
  message: string;
  code: string;
  reason: string;
  status?: number;
  statusCode?: number;
};

export type ClaudeProviderFailure = {
  signal: ProviderAttemptSignal;
  messagePreview: string;
  origin: "sdk_result" | "assistant_error";
  assistantError?: SDKAssistantMessageError;
};

const CLAUDE_ASSISTANT_ERROR_CODES: Record<SDKAssistantMessageError, true> = {
  authentication_failed: true,
  oauth_org_not_allowed: true,
  billing_error: true,
  rate_limit: true,
  overloaded: true,
  invalid_request: true,
  model_not_found: true,
  server_error: true,
  unknown: true,
  max_output_tokens: true,
};

export function claudeFailureFromSdkResult(message: unknown): ClaudeProviderFailure | null {
  const result = readResultMessage(message);
  if (!result) return null;

  if (result.subtype === "success" && result.isError !== true) return null;

  const messagePreview =
    result.subtype === "success"
      ? firstNonEmpty(result.result, "Claude SDK returned an error result")
      : // Merge the typed error codes with the result text so an API detail
        // like "403 Request not allowed" survives into the preview even when
        // `errors` only carries the opaque `authentication_failed` code —
        // otherwise egress detection downstream never sees it.
        firstNonEmpty(combinePreviews(result.errors.join("; "), result.result ?? ""), result.subtype);
  const status = result.apiErrorStatus ?? undefined;
  const reason = result.subtype === "success" ? "claude_result_is_error" : `claude_result_${result.subtype}`;
  return buildFailure({
    messagePreview,
    reason,
    code: status ? `${reason}_${status}` : reason,
    status,
    replaySafety: result.subtype === "success" ? "pre_visible" : "provider_entered",
    origin: "sdk_result",
  });
}

export function claudeFailureFromAssistantMessage(message: unknown): ClaudeProviderFailure | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "assistant") return null;
  const code = claudeAssistantErrorCode(record.error);
  if (!code) return null;
  const status = statusForAssistantError(code);
  return buildFailure({
    messagePreview: code,
    reason: code,
    code,
    status,
    replaySafety: "provider_entered",
    origin: "assistant_error",
    assistantError: code,
  });
}

export function mergeClaudeProviderFailures(input: {
  resultFailure: ClaudeProviderFailure | null;
  assistantFailure: ClaudeProviderFailure | null;
  replaySafety?: ReplaySafety;
}): ClaudeProviderFailure | null {
  const primary = choosePrimaryFailure(input.resultFailure, input.assistantFailure);
  if (!primary) return null;
  const secondary = primary === input.assistantFailure ? input.resultFailure : input.assistantFailure;
  const merged = secondary ? withMergedPreview(primary, secondary) : primary;
  return input.replaySafety ? withReplaySafety(merged, input.replaySafety) : merged;
}

export function formatClaudeProviderFailureNotice(
  classification: ProviderFailureClassification,
  messagePreview: string,
): string {
  return formatProviderFailureRuntimeNotice({
    event: "provider_failure_terminal",
    provider: "claude-code",
    scope: "provider_turn",
    category: classification.category,
    reasonCode: classification.reasonCode,
    userSeverity: "error",
    messagePreview,
  });
}

/**
 * Anthropic returns HTTP 403 `Request not allowed` (a `forbidden` body) BEFORE
 * authentication when the request is rejected at the edge — most often a blocked
 * network egress (the background daemon not going through the user's proxy), but
 * also a region or account-entitlement block. The string is indistinguishable
 * from a genuine credential 403, so we deliberately do NOT re-classify the retry
 * behavior — but we refuse to print the misleading "run `claude auth login`"
 * lead, which sends operators chasing an auth problem that does not exist.
 * Instead we enumerate the real causes in priority order.
 */
export { isEgressForbiddenText };

function readResultMessage(message: unknown): {
  subtype: string;
  result?: string;
  errors: string[];
  isError?: boolean;
  apiErrorStatus?: number | null;
} | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "result" || typeof record.subtype !== "string") return null;
  return {
    subtype: record.subtype,
    result: typeof record.result === "string" ? record.result : undefined,
    errors: Array.isArray(record.errors)
      ? record.errors.filter((item): item is string => typeof item === "string")
      : [],
    isError: typeof record.is_error === "boolean" ? record.is_error : undefined,
    apiErrorStatus: typeof record.api_error_status === "number" ? record.api_error_status : undefined,
  };
}

function claudeAssistantErrorCode(value: unknown): SDKAssistantMessageError | null {
  if (typeof value !== "string") return null;
  return value in CLAUDE_ASSISTANT_ERROR_CODES ? (value as SDKAssistantMessageError) : null;
}

function statusForAssistantError(code: SDKAssistantMessageError): number | undefined {
  switch (code) {
    case "authentication_failed":
      return 401;
    case "oauth_org_not_allowed":
    case "billing_error":
      return 403;
    case "rate_limit":
      return 429;
    case "overloaded":
    case "server_error":
      return 503;
    case "invalid_request":
    case "max_output_tokens":
      return 400;
    case "model_not_found":
      return 404;
    case "unknown":
      return undefined;
  }
}

function buildFailure(input: {
  messagePreview: string;
  reason: string;
  code: string;
  status?: number;
  replaySafety: NonNullable<ProviderAttemptSignal["replaySafety"]>;
  origin: ClaudeProviderFailure["origin"];
  assistantError?: SDKAssistantMessageError;
}): ClaudeProviderFailure {
  const error: ClaudeProviderErrorShape = {
    name: "ClaudeSdkProviderError",
    message: input.messagePreview,
    code: input.code,
    reason: input.reason,
    ...(input.status ? { status: input.status, statusCode: input.status } : {}),
  };
  return {
    messagePreview: input.messagePreview,
    origin: input.origin,
    ...(input.assistantError ? { assistantError: input.assistantError } : {}),
    signal: {
      kind: "provider_error",
      error,
      source: "sdk",
      replaySafety: input.replaySafety,
      messagePreview: input.messagePreview,
    },
  };
}

function choosePrimaryFailure(
  resultFailure: ClaudeProviderFailure | null,
  assistantFailure: ClaudeProviderFailure | null,
): ClaudeProviderFailure | null {
  if (!assistantFailure) return resultFailure;
  if (!resultFailure) return assistantFailure;
  if (assistantFailure.origin === "assistant_error" && assistantFailure.assistantError !== "unknown") {
    return assistantFailure;
  }
  return resultFailure;
}

function withMergedPreview(primary: ClaudeProviderFailure, secondary: ClaudeProviderFailure): ClaudeProviderFailure {
  const messagePreview = combinePreviews(primary.messagePreview, secondary.messagePreview);
  if (messagePreview === primary.messagePreview) return primary;
  return {
    ...primary,
    messagePreview,
    signal: {
      ...primary.signal,
      messagePreview,
      error: withErrorMessage(primary.signal.error, messagePreview),
    },
  };
}

function withReplaySafety(failure: ClaudeProviderFailure, replaySafety: ReplaySafety): ClaudeProviderFailure {
  if (failure.signal.replaySafety === replaySafety) return failure;
  return {
    ...failure,
    signal: {
      ...failure.signal,
      replaySafety,
    },
  };
}

function combinePreviews(primary: string, secondary: string): string {
  const values = [primary.trim(), secondary.trim()].filter((value) => value.length > 0);
  return [...new Set(values)].join("\n");
}

function withErrorMessage(error: unknown, message: string): unknown {
  if (!error || typeof error !== "object") return error;
  return { ...(error as Record<string, unknown>), message };
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "Claude SDK provider failure";
}
