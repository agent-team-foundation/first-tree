import { z } from "zod";
import { runtimeProviderSchema } from "./runtime-provider.js";

export const providerRetryScopeSchema = z.enum(["session_start", "session_resume", "provider_turn"]);
export type ProviderRetryScope = z.infer<typeof providerRetryScopeSchema>;

export const providerFailureCategorySchema = z.enum([
  "transient_transport",
  "provider_capacity",
  "credential",
  "capability",
  "configuration",
  "deterministic_input",
  "unknown",
]);
export type ProviderFailureCategory = z.infer<typeof providerFailureCategorySchema>;

export const replaySafetySchema = z.enum([
  "pre_provider",
  "pre_visible",
  "provider_entered",
  "user_visible",
  "unsafe",
  "unknown",
]);
export type ReplaySafety = z.infer<typeof replaySafetySchema>;

export const providerRetryEventNameSchema = z.enum([
  "provider_retry_scheduled",
  "provider_retry_started",
  "provider_retry_succeeded",
  "provider_retry_exhausted",
  "provider_failure_terminal",
]);
export type ProviderRetryEventName = z.infer<typeof providerRetryEventNameSchema>;

export const providerRetryEventPayloadSchema = z.object({
  event: providerRetryEventNameSchema,
  provider: runtimeProviderSchema,
  scope: providerRetryScopeSchema,
  category: providerFailureCategorySchema,
  reasonCode: z.string().min(1),
  attempt: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
  retryMode: z.enum(["foreground", "background"]).optional(),
  delayMs: z.number().int().nonnegative().optional(),
  nextRetryAt: z.string().optional(),
  replaySafety: replaySafetySchema.optional(),
  userSeverity: z.enum(["info", "warning", "error"]),
  messagePreview: z.string().max(800).optional(),
});
export type ProviderRetryEventPayload = z.infer<typeof providerRetryEventPayloadSchema>;

export const agentStatusReasonSchema = z.object({
  kind: z.enum(["retrying", "waiting", "terminal"]),
  severity: z.enum(["info", "warning", "error"]),
  provider: runtimeProviderSchema,
  scope: providerRetryScopeSchema,
  category: providerFailureCategorySchema,
  reasonCode: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
  nextRetryAt: z.string().optional(),
});
export type AgentStatusReason = z.infer<typeof agentStatusReasonSchema>;

export const PROVIDER_RETRY_EVENT_MESSAGE_PREFIX = "provider.retry:";

export function encodeProviderRetryEventMessage(payload: ProviderRetryEventPayload): string {
  return `${PROVIDER_RETRY_EVENT_MESSAGE_PREFIX} ${JSON.stringify(providerRetryEventPayloadSchema.parse(payload))}`;
}

export function parseProviderRetryEventMessage(message: string): ProviderRetryEventPayload | null {
  if (!message.startsWith(PROVIDER_RETRY_EVENT_MESSAGE_PREFIX)) return null;
  const raw = message.slice(PROVIDER_RETRY_EVENT_MESSAGE_PREFIX.length).trim();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = providerRetryEventPayloadSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function statusReasonFromProviderRetryEvent(payload: ProviderRetryEventPayload): AgentStatusReason | null {
  if (payload.event === "provider_retry_succeeded") return null;

  const terminal = payload.event === "provider_retry_exhausted" || payload.event === "provider_failure_terminal";
  const kind: AgentStatusReason["kind"] = terminal
    ? "terminal"
    : payload.retryMode === "background"
      ? "waiting"
      : "retrying";

  return agentStatusReasonSchema.parse({
    kind,
    severity: payload.userSeverity,
    provider: payload.provider,
    scope: payload.scope,
    category: payload.category,
    reasonCode: payload.reasonCode,
    label: statusReasonLabel(kind, payload),
    detail: payload.messagePreview,
    attempt: payload.attempt,
    maxAttempts: payload.maxAttempts,
    nextRetryAt: payload.nextRetryAt,
  });
}

function statusReasonLabel(kind: AgentStatusReason["kind"], payload: ProviderRetryEventPayload): string {
  if (kind === "waiting") {
    if (payload.category === "provider_capacity") return "Waiting for provider capacity";
    return "Waiting to retry provider";
  }
  if (kind === "retrying") return "Retrying provider";
  if (payload.reasonCode === "capacity_wait_required" || payload.category === "provider_capacity") {
    return "Provider capacity limit";
  }
  if (payload.event === "provider_retry_exhausted") return "Provider retry exhausted";
  return "Provider failure";
}
