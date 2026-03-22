import { z } from "zod";

export const systemConfigSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  updatedAt: z.string(),
});
export type SystemConfig = z.infer<typeof systemConfigSchema>;

export const updateSystemConfigSchema = z.record(z.string(), z.unknown());
export type UpdateSystemConfig = z.infer<typeof updateSystemConfigSchema>;

export const SYSTEM_CONFIG_KEYS = {
  INBOX_TIMEOUT_SECONDS: "inbox_timeout_seconds",
  MAX_RETRY_COUNT: "max_retry_count",
  POLLING_INTERVAL_SECONDS: "polling_interval_seconds",
  PRESENCE_CLEANUP_SECONDS: "presence_cleanup_seconds",
} as const;

export const SYSTEM_CONFIG_DEFAULTS: Record<string, unknown> = {
  [SYSTEM_CONFIG_KEYS.INBOX_TIMEOUT_SECONDS]: 300,
  [SYSTEM_CONFIG_KEYS.MAX_RETRY_COUNT]: 3,
  [SYSTEM_CONFIG_KEYS.POLLING_INTERVAL_SECONDS]: 5,
  [SYSTEM_CONFIG_KEYS.PRESENCE_CLEANUP_SECONDS]: 60,
};
