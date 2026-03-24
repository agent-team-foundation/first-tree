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
