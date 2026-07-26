import { z } from "zod";

/**
 * First Tree cron jobs V1 — shared DTOs.
 *
 * A schedule is a thin message-materialization primitive: at due time the
 * Server writes one ordinary, visible, explicitly addressed markdown message
 * into the control Chat. Zod remains the DTO source of truth for Agent CLI
 * and Desktop Web.
 */

// ── Constants ───────────────────────────────────────────────────────────────

export const CRON_CHAT_MODES = {
  REUSE_CONTROL_CHAT: "reuse_control_chat",
} as const;

/** V1 only. Future `new_chat_per_run` is schema-reserved, not accepted. */
export const cronChatModeSchema = z.literal("reuse_control_chat");
export type CronChatMode = z.infer<typeof cronChatModeSchema>;

export const CRON_JOB_STATES = {
  ACTIVE: "active",
  PAUSED: "paused",
} as const;

export const cronJobStateSchema = z.enum(["active", "paused"]);
export type CronJobState = z.infer<typeof cronJobStateSchema>;

/** User-writable PATCH state values. Auto-pause reasons are server-owned. */
export const cronJobWritableStateSchema = z.enum(["active", "paused"]);
export type CronJobWritableState = z.infer<typeof cronJobWritableStateSchema>;

export const CRON_JOB_NAME_MAX = 120;
export const CRON_EXPRESSION_MAX = 100;
export const CRON_TIMEZONE_MAX = 100;
export const CRON_PROMPT_MAX_CHARS = 32_768;
export const CRON_PREVIEW_OCCURRENCE_COUNT = 5;
export const CRON_DISPATCH_GRACE_MS = 30_000;
export const CRON_POLLING_INTERVAL_MIN_SECONDS = 1;
/**
 * Preserve at least three polling opportunities inside the dispatch grace
 * window so a valid cadence cannot systematically skip minute-aligned jobs.
 */
export const CRON_POLLING_INTERVAL_MAX_SECONDS = 10;

/**
 * Permanent auto-pause / fail-closed reasons stored in `state_reason` when
 * `state=paused`. `user_paused` is the only human-initiated pause reason.
 */
export const CRON_JOB_PAUSE_REASONS = [
  "user_paused",
  "owner_inactive",
  "owner_not_speaker",
  "agent_manager_changed",
  "agent_inactive",
  "agent_not_speaker",
  "chat_invalid",
  "invalid_schedule",
  "inbox_state_missing",
  "owner_chat_deleted",
  "unsupported_chat_mode",
] as const;
export const cronJobPauseReasonSchema = z.enum(CRON_JOB_PAUSE_REASONS);
export type CronJobPauseReason = z.infer<typeof cronJobPauseReasonSchema>;

/** Occurrence skip reasons (job stays active). Structured logs/metrics only. */
export const CRON_OCCURRENCE_SKIP_REASONS = [
  "late",
  "agent_offline",
  "client_paused",
  "route_stale",
  "previous_trigger_unacked",
] as const;
export const cronOccurrenceSkipReasonSchema = z.enum(CRON_OCCURRENCE_SKIP_REASONS);
export type CronOccurrenceSkipReason = z.infer<typeof cronOccurrenceSkipReasonSchema>;

/**
 * Stable machine-readable error codes for cron HTTP responses. Routes that
 * need a code return `{ error, code }` so Web/CLI can branch without sniffing
 * message text.
 */
export const CRON_JOB_ERROR_CODES = [
  "CRON_JOB_NOT_FOUND",
  "CRON_JOB_FORBIDDEN",
  "CRON_JOB_REVISION_MISMATCH",
  "CRON_JOB_NAME_CONFLICT",
  "CRON_JOB_INVALID_SCHEDULE",
  "CRON_JOB_INVALID_TIMEZONE",
  "CRON_JOB_INVALID_STATE",
  /** Request/header/body shape errors that are not schedule/timezone/state. */
  "CRON_JOB_INVALID_REQUEST",
  "CRON_JOB_CHAT_REQUIRED",
  "CRON_TRIGGER_METADATA_RESERVED",
] as const;
export const cronJobErrorCodeSchema = z.enum(CRON_JOB_ERROR_CODES);
export type CronJobErrorCode = z.infer<typeof cronJobErrorCodeSchema>;

/** Reserved message metadata key for trusted cron trigger materialization. */
export const CRON_TRIGGER_METADATA_KEY = "cronTrigger" as const;

export const cronTriggerMetadataSchema = z
  .object({
    jobId: z.string().min(1),
    /** ISO-8601 UTC instant the occurrence was scheduled for. */
    scheduledFor: z.string().min(1),
    /** Stable `cron/<jobId>/<scheduledFor ISO>` idempotency key. */
    runKey: z.string().min(1),
  })
  .strict();
export type CronTriggerMetadata = z.infer<typeof cronTriggerMetadataSchema>;

export function isCronTriggerMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  return cronTriggerMetadataSchema.safeParse(metadata?.[CRON_TRIGGER_METADATA_KEY]).success;
}

export function buildCronRunKey(jobId: string, scheduledFor: Date | string): string {
  const iso = typeof scheduledFor === "string" ? scheduledFor : scheduledFor.toISOString();
  return `cron/${jobId}/${iso}`;
}

// ── Schedule / timezone string shapes ───────────────────────────────────────

/**
 * Normalize five-field cron whitespace. Semantic validation (aliases, DOM/DOW
 * OR, future occurrences) belongs to the Server Croner path — Zod only rejects
 * obviously malformed strings before they leave the request boundary.
 */
export function normalizeCronExpression(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

const FIVE_FIELD_CRON_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;

/**
 * Reject non-portable / non-OR extensions without matching day/month aliases.
 *
 * Field semantics (Croner 10):
 * - Minute/hour/DOM: any `L`/`W` is a Quartz/calendar modifier — reject
 * - Month/DOW: only Croner's three-letter aliases (JAN…SAT) are valid; full
 *   names like MARCH/WEDNESDAY are rejected because Croner's substring
 *   replace leaves illegal residue
 * - Also reject `#`/`?`/`+`/`H`/`@` modifier tokens
 */
export function hasNonPortableCronExtension(expression: string): boolean {
  const fields = normalizeCronExpression(expression).split(" ");
  if (fields.length !== 5) return true;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];

  for (const field of fields) {
    if (field.startsWith("+")) return true;
    if (/[?@#]/.test(field)) return true;
    // Jenkins `H` / `H(...)` — linear atom scan (avoid anchored regex ReDoS).
    if (fieldHasJenkinsHashAtom(field)) return true;
  }

  // Minute/hour/DOM never have letter aliases; any L/W is a modifier.
  if (/[LlWw]/.test(minute) || /[LlWw]/.test(hour) || /[LlWw]/.test(dom)) return true;

  // Month/DOW: inspect atoms so JUL/WED survive while 5L / W / LW / MARCH do not.
  for (const field of [month, dow]) {
    for (const atom of field.split(/[,/-]/)) {
      if (!atom || atom === "*") continue;
      if (/^\d+$/.test(atom)) continue;
      if (isCronMonthOrDowAlias(atom)) continue;
      if (/[LlWw]/i.test(atom)) return true;
      // Unknown letter token (including full aliases Croner rejects).
      if (/[A-Za-z]/.test(atom)) return true;
    }
  }

  return false;
}

/** Croner 10 three-letter aliases only (substring replace breaks full names). */
const CRON_MONTH_OR_DOW_ALIAS_RE = /^(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT)$/i;

function isCronMonthOrDowAlias(atom: string): boolean {
  return CRON_MONTH_OR_DOW_ALIAS_RE.test(atom);
}

/** True when a cron field contains Jenkins hash `H` or `H(...)` as an atom. */
function fieldHasJenkinsHashAtom(field: string): boolean {
  const n = field.length;
  let i = 0;
  while (i < n) {
    const atAtomStart =
      i === 0 || field.charAt(i - 1) === "," || field.charAt(i - 1) === "/" || field.charAt(i - 1) === "-";
    const ch = field.charAt(i);
    if (atAtomStart && (ch === "H" || ch === "h")) {
      if (i + 1 >= n) return true;
      const next = field.charAt(i + 1);
      if (next === "," || next === "/" || next === "-") return true;
      if (next === "(") {
        let depth = 1;
        let j = i + 2;
        while (j < n && depth > 0) {
          const c = field.charAt(j);
          if (c === "(") depth += 1;
          else if (c === ")") depth -= 1;
          j += 1;
        }
        if (depth === 0 && (j >= n || field.charAt(j) === "," || field.charAt(j) === "/" || field.charAt(j) === "-")) {
          return true;
        }
        // Malformed or glued `H(...` — still non-portable; reject.
        return true;
      }
    }
    i += 1;
  }
  return false;
}

export const cronExpressionSchema = z
  .string()
  .trim()
  .min(1)
  .max(CRON_EXPRESSION_MAX)
  .transform(normalizeCronExpression)
  .refine((value) => FIVE_FIELD_CRON_RE.test(value), {
    message: "schedule must be exactly five cron fields: minute hour day-of-month month day-of-week",
  })
  .refine((value) => !hasNonPortableCronExtension(value), {
    message: "schedule must not use seconds, macros, or non-portable cron extensions",
  });

/**
 * Validate and normalize an IANA timezone via `Intl`. Rejects empty, overly
 * long, and unrecognized zone ids.
 */
export function normalizeIanaTimezone(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("timezone must be a non-empty IANA zone");
  }
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
    if (!resolved) {
      throw new Error(`unrecognized IANA timezone: ${trimmed}`);
    }
    return resolved;
  } catch {
    throw new Error(`unrecognized IANA timezone: ${trimmed}`);
  }
}

export const cronTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(CRON_TIMEZONE_MAX)
  .superRefine((value, ctx) => {
    try {
      normalizeIanaTimezone(value);
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        message: err instanceof Error ? err.message : "unrecognized IANA timezone",
      });
    }
  })
  .transform((value) => normalizeIanaTimezone(value));

export const cronJobNameSchema = z.string().trim().min(1).max(CRON_JOB_NAME_MAX);

export const cronJobPromptSchema = z.string().min(1, "prompt must be non-empty").max(CRON_PROMPT_MAX_CHARS);

// ── Read model ──────────────────────────────────────────────────────────────

export const cronOutstandingSchema = z.object({
  messageId: z.string().min(1),
  status: z.enum(["pending", "delivered"]),
});
export type CronOutstanding = z.infer<typeof cronOutstandingSchema>;

export const cronJobSchema = z.object({
  id: z.string(),
  ownerMemberId: z.string(),
  controlChatId: z.string(),
  agentId: z.string(),
  name: z.string(),
  chatMode: cronChatModeSchema,
  schedule: z.string(),
  timezone: z.string(),
  prompt: z.string(),
  state: cronJobStateSchema,
  stateReason: z.string().nullable(),
  revision: z.number().int().positive(),
  nextRunAt: z.string().nullable(),
  outstanding: cronOutstandingSchema.nullable(),
  createdAt: z.string(),
});
export type CronJob = z.infer<typeof cronJobSchema>;

export const listCronJobsResponseSchema = z.object({
  items: z.array(cronJobSchema),
});
export type ListCronJobsResponse = z.infer<typeof listCronJobsResponseSchema>;

// ── Preview ─────────────────────────────────────────────────────────────────

export const cronPreviewOccurrenceSchema = z.object({
  /** UTC ISO-8601 instant. */
  at: z.string(),
  /** Same instant formatted in the job timezone for unambiguous display. */
  local: z.string(),
  timezone: z.string(),
});
export type CronPreviewOccurrence = z.infer<typeof cronPreviewOccurrenceSchema>;

export const cronPreviewRequestSchema = z.object({
  schedule: cronExpressionSchema,
  timezone: cronTimezoneSchema,
});
export type CronPreviewRequest = z.infer<typeof cronPreviewRequestSchema>;

export const cronPreviewResponseSchema = z.object({
  schedule: z.string(),
  timezone: z.string(),
  occurrences: z.array(cronPreviewOccurrenceSchema).length(CRON_PREVIEW_OCCURRENCE_COUNT),
});
export type CronPreviewResponse = z.infer<typeof cronPreviewResponseSchema>;

// ── Create / update ─────────────────────────────────────────────────────────

export const createCronJobRequestSchema = z.object({
  name: cronJobNameSchema,
  schedule: cronExpressionSchema,
  timezone: cronTimezoneSchema,
  prompt: cronJobPromptSchema,
});
export type CreateCronJobRequest = z.infer<typeof createCronJobRequestSchema>;

/**
 * PATCH body. Only explicitly provided fields are applied. Never accepts
 * `stateReason`, `nextRunAt`, `outstanding`, or `chatMode`.
 */
export const updateCronJobRequestSchema = z
  .object({
    name: cronJobNameSchema.optional(),
    schedule: cronExpressionSchema.optional(),
    timezone: cronTimezoneSchema.optional(),
    prompt: cronJobPromptSchema.optional(),
    state: cronJobWritableStateSchema.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.name !== undefined ||
      body.schedule !== undefined ||
      body.timezone !== undefined ||
      body.prompt !== undefined ||
      body.state !== undefined,
    { message: "at least one of name, schedule, timezone, prompt, or state is required" },
  );
export type UpdateCronJobRequest = z.infer<typeof updateCronJobRequestSchema>;

export const deleteCronJobResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
  /** True when an accepted trigger may still be pending or executing. */
  acceptedWorkPreserved: z.boolean(),
  lastTriggerMessageId: z.string().nullable(),
});
export type DeleteCronJobResponse = z.infer<typeof deleteCronJobResponseSchema>;

/** HTTP If-Match header value: the caller's known revision. */
export const cronJobRevisionHeaderSchema = z.coerce.number().int().positive();
