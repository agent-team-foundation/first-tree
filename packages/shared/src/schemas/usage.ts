import { z } from "zod";

/**
 * Schemas for the token-usage aggregation surface. Driven by `token_usage`
 * session events emitted by the handlers — see `session-event.ts` for the
 * raw event shape. These DTOs describe the *aggregated* views consumed by
 * the web app.
 *
 * All numeric token fields are unsigned integers; cost is intentionally
 * absent for now (handler does not emit cost — see PR #637 review).
 */

const nonnegInt = z.number().int().nonnegative();

/** Per-agent aggregate row for the Team page Usage column. */
export const usageByAgentRow = z.object({
  agentId: z.string(),
  inputTokens: nonnegInt,
  cachedInputTokens: nonnegInt,
  outputTokens: nonnegInt,
  turns: nonnegInt,
});
export type UsageByAgentRow = z.infer<typeof usageByAgentRow>;

export const usageByAgentResponse = z.object({
  from: z.string(),
  to: z.string(),
  rows: z.array(usageByAgentRow),
});
export type UsageByAgentResponse = z.infer<typeof usageByAgentResponse>;

/** Per-day bucket for the agent profile activity grid. */
export const usageDailyBucket = z.object({
  date: z.string(), // YYYY-MM-DD (UTC)
  inputTokens: nonnegInt,
  cachedInputTokens: nonnegInt,
  outputTokens: nonnegInt,
  turns: nonnegInt,
});
export type UsageDailyBucket = z.infer<typeof usageDailyBucket>;

/**
 * Agent profile summary — top-line KPI block plus a daily series for the
 * activity grid. `daily` ALWAYS covers a 90-day window regardless of the
 * `from/to` filter on KPI numbers, because the grid is a fixed long-range
 * density visualisation. KPI numbers (`totals`) reflect the requested window.
 */
export const usageAgentSummary = z.object({
  agentId: z.string(),
  from: z.string(),
  to: z.string(),
  totals: z.object({
    inputTokens: nonnegInt,
    cachedInputTokens: nonnegInt,
    outputTokens: nonnegInt,
    turns: nonnegInt,
    chats: nonnegInt,
    lastUsageAt: z.string().nullable(),
  }),
  /** 90 days ending at `to`, one entry per UTC day (zero buckets omitted). */
  daily: z.array(usageDailyBucket),
});
export type UsageAgentSummary = z.infer<typeof usageAgentSummary>;

/**
 * Single turn row for the Recent turns table. `chatTitle` is `null` when
 * the viewer is not a participant of the chat (chat name is sensitive —
 * aggregate numbers are org-public, chat names are participant-gated).
 */
export const usageTurnRow = z.object({
  seq: z.number().int().positive(),
  chatId: z.string(),
  chatTitle: z.string().nullable(),
  createdAt: z.string(),
  inputTokens: nonnegInt,
  cachedInputTokens: nonnegInt,
  outputTokens: nonnegInt,
  provider: z.string(),
  model: z.string(),
});
export type UsageTurnRow = z.infer<typeof usageTurnRow>;

export const usageTurnsResponse = z.object({
  agentId: z.string(),
  from: z.string(),
  to: z.string(),
  rows: z.array(usageTurnRow),
  nextCursor: z.string().nullable(),
});
export type UsageTurnsResponse = z.infer<typeof usageTurnsResponse>;

/** Shared query-string schema for `?from=&to=` window filtering. */
export const usageWindowQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type UsageWindowQuery = z.infer<typeof usageWindowQuery>;

export const usageTurnsQuery = usageWindowQuery.extend({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type UsageTurnsQuery = z.infer<typeof usageTurnsQuery>;
