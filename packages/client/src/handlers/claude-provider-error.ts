import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderFailureCategory, ReplaySafety } from "@first-tree/shared";
import type { ProviderAttemptSignal } from "../runtime/provider-attempt.js";
import type { ProviderFailureClassification } from "../runtime/provider-retry-policy.js";
import { redactErrorPreview } from "../runtime/redact-error-preview.js";

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
      : firstNonEmpty(result.errors.join("; "), result.result, result.subtype);
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
  const detail = redactErrorPreview(messagePreview.trim(), 500);
  const suffix = detail.length > 0 ? ` Original provider message: ${detail}` : "";
  return `${noticeLead(classification.category, classification.reasonCode)}${suffix}`;
}

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

function noticeLead(category: ProviderFailureCategory, reasonCode: string): string {
  if (category === "credential") {
    return "Claude Code could not run this turn: Anthropic rejected the local Claude authentication. Run `claude auth login` on this machine, then retry.";
  }
  if (category === "provider_capacity") {
    if (reasonCode === "provider_billing_limit") {
      return "Claude Code could not run this turn: Anthropic reports insufficient account balance or unavailable billing credits. Add credits or switch accounts, then retry.";
    }
    if (reasonCode === "provider_rate_limited") {
      return "Claude Code could not run this turn: Anthropic rate-limited this account. Wait for the limit to reset, then retry.";
    }
    return "Claude Code could not run this turn: Anthropic reported a capacity or usage limit. Wait or switch accounts, then retry.";
  }
  if (category === "transient_transport") {
    return "Claude Code could not run this turn: the Anthropic connection failed after retry handling. Retry later.";
  }
  if (category === "configuration") {
    return "Claude Code could not run this turn: the Claude runtime configuration is invalid. Update the agent or provider configuration, then retry.";
  }
  if (category === "deterministic_input") {
    return "Claude Code could not run this turn: Anthropic rejected this request as invalid. Adjust the request or configuration, then retry.";
  }
  if (category === "capability") {
    return "Claude Code could not run this turn: the Claude runtime is not launchable on this machine. Fix the local runtime, then retry.";
  }
  return "Claude Code could not run this turn: Claude SDK reported a provider failure. Retry after checking the provider status.";
}
