import {
  CRON_PREVIEW_OCCURRENCE_COUNT,
  type CronPreviewOccurrence,
  normalizeCronExpression,
  normalizeIanaTimezone,
} from "@first-tree/shared";
import { Cron } from "croner";

/**
 * Croner is the only schedule parser/enumerator. Always construct paused —
 * never use the library as an in-memory timer. `legacyMode: true` restores
 * traditional DOM/DOW OR semantics (Croner 10's successor to `domAndDow: false`).
 */
function buildCron(expression: string, timezone: string): Cron {
  return new Cron(normalizeCronExpression(expression), {
    paused: true,
    timezone: normalizeIanaTimezone(timezone),
    legacyMode: true,
  });
}

export class InvalidCronScheduleError extends Error {
  readonly code = "CRON_JOB_INVALID_SCHEDULE" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidCronScheduleError";
  }
}

/**
 * First occurrence strictly after `after` (exclusive). Returns null when the
 * expression has no future fires (permanent invalidity for our purposes).
 */
export function firstOccurrenceStrictlyAfter(
  expression: string,
  timezone: string,
  after: Date,
): Date | null {
  try {
    const cron = buildCron(expression, timezone);
    const next = cron.nextRun(after);
    if (!next) return null;
    // Croner nextRun is exclusive of the start when the start is exact; still
    // defend against equality so we never re-fire the same scheduledFor.
    if (next.getTime() <= after.getTime()) {
      const again = cron.nextRun(new Date(after.getTime() + 1));
      return again ?? null;
    }
    return next;
  } catch (err) {
    throw new InvalidCronScheduleError(err instanceof Error ? err.message : "invalid cron schedule");
  }
}

export function previewOccurrences(
  expression: string,
  timezone: string,
  after: Date,
  count = CRON_PREVIEW_OCCURRENCE_COUNT,
): { schedule: string; timezone: string; occurrences: CronPreviewOccurrence[] } {
  const schedule = normalizeCronExpression(expression);
  const tz = normalizeIanaTimezone(timezone);
  try {
    const cron = buildCron(schedule, tz);
    const runs = cron.nextRuns(count, after);
    if (runs.length < count) {
      throw new InvalidCronScheduleError("schedule has no future occurrences");
    }
    const occurrences = runs.map((at) => ({
      at: at.toISOString(),
      local: formatLocal(at, tz),
      timezone: tz,
    }));
    return { schedule, timezone: tz, occurrences };
  } catch (err) {
    if (err instanceof InvalidCronScheduleError) throw err;
    throw new InvalidCronScheduleError(err instanceof Error ? err.message : "invalid cron schedule");
  }
}

function formatLocal(at: Date, timezone: string): string {
  // en-CA yields YYYY-MM-DD; combine with time for an unambiguous local display.
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(at);
  return `${date} ${time} (${timezone})`;
}

/** Validate that the expression can produce at least five future occurrences. */
export function assertSchedulable(expression: string, timezone: string, after: Date): {
  schedule: string;
  timezone: string;
  nextRunAt: Date;
} {
  const preview = previewOccurrences(expression, timezone, after);
  const next = firstOccurrenceStrictlyAfter(preview.schedule, preview.timezone, after);
  if (!next) {
    throw new InvalidCronScheduleError("schedule has no future occurrences");
  }
  return { schedule: preview.schedule, timezone: preview.timezone, nextRunAt: next };
}
