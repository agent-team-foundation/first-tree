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
 *
 * Nonexistent spring-forward wall times are skipped (not shifted): after Croner
 * proposes an instant we verify its local minute/hour match the expression, and
 * advance past gap artifacts.
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

const MONTH_ALIASES: Record<string, number> = {
  JAN: 1,
  JANUARY: 1,
  FEB: 2,
  FEBRUARY: 2,
  MAR: 3,
  MARCH: 3,
  APR: 4,
  APRIL: 4,
  MAY: 5,
  JUN: 6,
  JUNE: 6,
  JUL: 7,
  JULY: 7,
  AUG: 8,
  AUGUST: 8,
  SEP: 9,
  SEPTEMBER: 9,
  OCT: 10,
  OCTOBER: 10,
  NOV: 11,
  NOVEMBER: 11,
  DEC: 12,
  DECEMBER: 12,
};

const DOW_ALIASES: Record<string, number> = {
  SUN: 0,
  SUNDAY: 0,
  MON: 1,
  MONDAY: 1,
  TUE: 2,
  TUESDAY: 2,
  WED: 3,
  WEDNESDAY: 3,
  THU: 4,
  THURSDAY: 4,
  FRI: 5,
  FRIDAY: 5,
  SAT: 6,
  SATURDAY: 6,
};

type LocalParts = {
  minute: number;
  hour: number;
  day: number;
  month: number;
  /** 0=Sunday … 6=Saturday */
  dow: number;
};

function localParts(at: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = get("weekday").toUpperCase().slice(0, 3);
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")),
    day: Number(get("day")),
    month: Number(get("month")),
    dow: DOW_ALIASES[weekday] ?? 0,
  };
}

function tokenMatches(token: string, value: number, aliases?: Record<string, number>): boolean {
  const raw = token.trim();
  if (!raw || raw === "*") return true;

  let base = raw;
  let step = 1;
  if (raw.includes("/")) {
    const [rangePart, stepPart] = raw.split("/");
    base = rangePart ?? "*";
    step = Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) return false;
  }

  const resolve = (side: string): number | null => {
    if (side === "*") return null;
    const upper = side.toUpperCase();
    if (aliases && upper in aliases) return aliases[upper]!;
    const n = Number(side);
    return Number.isInteger(n) ? n : null;
  };

  if (base.includes("-")) {
    const [startRaw, endRaw] = base.split("-");
    const start = resolve(startRaw ?? "");
    const end = resolve(endRaw ?? "");
    if (start === null || end === null) return false;
    if (value < start || value > end) return false;
    return (value - start) % step === 0;
  }

  if (base === "*" || base === "") {
    return value % step === 0;
  }

  const exact = resolve(base);
  if (exact === null) return false;
  if (exact !== value) return false;
  return step === 1 || value % step === 0;
}

function fieldMatches(field: string, value: number, aliases?: Record<string, number>): boolean {
  return field.split(",").some((token) => tokenMatches(token, value, aliases));
}

/**
 * True when `at`'s civil wall time in `timezone` satisfies the five-field
 * expression (minute/hour/DOM/month/DOW with traditional OR for DOM/DOW).
 */
export function matchesScheduledWallTime(expression: string, timezone: string, at: Date): boolean {
  const fields = normalizeCronExpression(expression).split(" ");
  if (fields.length !== 5) return false;
  const [minuteF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string];
  const local = localParts(at, timezone);

  if (!fieldMatches(minuteF, local.minute)) return false;
  if (!fieldMatches(hourF, local.hour)) return false;
  if (!fieldMatches(monthF, local.month, MONTH_ALIASES)) return false;

  const domStar = domF === "*";
  const dowStar = dowF === "*";
  const domOk = fieldMatches(domF, local.day);
  const dowOk = fieldMatches(dowF, local.dow, DOW_ALIASES);
  // Traditional OR: when both DOM and DOW are restricted, either may match.
  if (!domStar && !dowStar) return domOk || dowOk;
  if (!domStar) return domOk;
  if (!dowStar) return dowOk;
  return true;
}

/**
 * First occurrence strictly after `after` (exclusive). Returns null when the
 * expression has no future fires (permanent invalidity for our purposes).
 * Skips Croner gap-shifted instants whose local hour/minute do not match.
 */
export function firstOccurrenceStrictlyAfter(expression: string, timezone: string, after: Date): Date | null {
  try {
    const schedule = normalizeCronExpression(expression);
    const tz = normalizeIanaTimezone(timezone);
    const cron = buildCron(schedule, tz);
    let cursor = after;
    // Bound well above a year of daily fires so pathological loops fail closed.
    for (let i = 0; i < 400; i++) {
      let next = cron.nextRun(cursor);
      if (!next) return null;
      if (next.getTime() <= cursor.getTime()) {
        next = cron.nextRun(new Date(cursor.getTime() + 1));
        if (!next) return null;
      }
      if (matchesScheduledWallTime(schedule, tz, next)) {
        return next;
      }
      // Gap artifact (e.g. 02:00 → 03:00 spring-forward): skip this instant.
      cursor = next;
    }
    return null;
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
    const occurrences: CronPreviewOccurrence[] = [];
    let cursor = after;
    for (let i = 0; i < count; i++) {
      const next = firstOccurrenceStrictlyAfter(schedule, tz, cursor);
      if (!next) {
        throw new InvalidCronScheduleError("schedule has no future occurrences");
      }
      occurrences.push({
        at: next.toISOString(),
        local: formatLocal(next, tz),
        timezone: tz,
      });
      cursor = next;
    }
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
export function assertSchedulable(
  expression: string,
  timezone: string,
  after: Date,
): {
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
