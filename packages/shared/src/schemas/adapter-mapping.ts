import { z } from "zod";
import { adapterBindMethodSchema, adapterPlatformSchema } from "./adapter.js";

export const createAdapterMappingSchema = z.object({
  platform: adapterPlatformSchema,
  externalUserId: z.string().min(1),
  agentId: z.string().min(1),
  boundVia: adapterBindMethodSchema.default("manual"),
  displayName: z.string().max(200).optional(),
});
export type CreateAdapterMapping = z.infer<typeof createAdapterMappingSchema>;

export const adapterMappingSchema = z.object({
  id: z.number(),
  platform: z.string(),
  externalUserId: z.string(),
  agentId: z.string(),
  boundVia: z.string().nullable(),
  displayName: z.string().nullable(),
  createdAt: z.string(),
});
export type AdapterMapping = z.infer<typeof adapterMappingSchema>;

// -- Delegate Feishu user binding --

export const delegateFeishuUserSchema = z.object({
  feishuUserId: z.string().min(1),
  displayName: z.string().max(200).optional(),
});
export type DelegateFeishuUser = z.infer<typeof delegateFeishuUserSchema>;

// -- Feishu search --

export const feishuSearchQuerySchema = z.object({
  q: z.string().min(1),
  by: z.enum(["name", "email", "mobile"]).default("name"),
});
export type FeishuSearchQuery = z.infer<typeof feishuSearchQuerySchema>;

export const feishuSearchResultSchema = z.object({
  users: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      email: z.string().nullable(),
      department: z.string().nullable(),
    }),
  ),
  botUsed: z.string().nullable(),
});
export type FeishuSearchResult = z.infer<typeof feishuSearchResultSchema>;
