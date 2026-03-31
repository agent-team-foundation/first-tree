import { z } from "zod";

export const ADAPTER_PLATFORMS = {
  FEISHU: "feishu",
  SLACK: "slack",
} as const;

export const adapterPlatformSchema = z.enum(["feishu", "slack"]);
export type AdapterPlatform = z.infer<typeof adapterPlatformSchema>;

export const ADAPTER_STATUSES = {
  ACTIVE: "active",
  INACTIVE: "inactive",
} as const;

export const adapterStatusSchema = z.enum(["active", "inactive"]);
export type AdapterStatus = z.infer<typeof adapterStatusSchema>;

export const createAdapterConfigSchema = z.object({
  platform: adapterPlatformSchema,
  agentId: z.string().min(1),
  credentials: z.record(z.unknown()),
  status: adapterStatusSchema.default("active"),
});
export type CreateAdapterConfig = z.infer<typeof createAdapterConfigSchema>;

export const updateAdapterConfigSchema = z.object({
  agentId: z.string().min(1).optional(),
  credentials: z.record(z.unknown()).optional(),
  status: adapterStatusSchema.optional(),
});
export type UpdateAdapterConfig = z.infer<typeof updateAdapterConfigSchema>;

/** Response schema — credentials are never returned, only a boolean flag. */
export const adapterConfigSchema = z.object({
  id: z.number(),
  platform: z.string(),
  agentId: z.string(),
  hasCredentials: z.boolean(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdapterConfig = z.infer<typeof adapterConfigSchema>;

export const ADAPTER_BIND_METHODS = {
  CODE: "code",
  REVERSE_TOKEN: "reverse_token",
  OAUTH: "oauth",
  MANUAL: "manual",
} as const;

export const adapterBindMethodSchema = z.enum(["code", "reverse_token", "oauth", "manual"]);
export type AdapterBindMethod = z.infer<typeof adapterBindMethodSchema>;

// -- Self-service Feishu bot binding --

export const selfServiceFeishuBotSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
});
export type SelfServiceFeishuBot = z.infer<typeof selfServiceFeishuBotSchema>;
