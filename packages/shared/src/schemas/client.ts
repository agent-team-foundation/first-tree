import { z } from "zod";

// -- Client Status --

export const CLIENT_STATUSES = {
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
} as const;

export const clientStatusSchema = z.enum(["connected", "disconnected"]);
export type ClientStatus = z.infer<typeof clientStatusSchema>;

// -- Client --

export const clientSchema = z.object({
  id: z.string(),
  /** Owning user id (nullable until a legacy client re-registers under an authenticated JWT). */
  userId: z.string().nullable(),
  status: clientStatusSchema,
  sdkVersion: z.string().max(50).nullable(),
  hostname: z.string().max(100).nullable(),
  os: z.string().max(50).nullable(),
  agentCount: z.number().int().min(0),
  connectedAt: z.string().nullable(),
  lastSeenAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type Client = z.infer<typeof clientSchema>;

// -- Client Register (WS payload from client SDK) --

export const clientRegisterSchema = z.object({
  clientId: z.string().min(1).max(100),
  hostname: z.string().max(100).optional(),
  os: z.string().max(50).optional(),
  sdkVersion: z.string().max(50).optional(),
});
export type ClientRegister = z.infer<typeof clientRegisterSchema>;
