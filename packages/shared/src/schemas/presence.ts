import { z } from "zod";

export const PRESENCE_STATUSES = {
  ONLINE: "online",
  OFFLINE: "offline",
} as const;

export const presenceStatusSchema = z.enum(["online", "offline"]);
export type PresenceStatus = z.infer<typeof presenceStatusSchema>;

// -- Runtime State --

export const RUNTIME_STATES = {
  IDLE: "idle",
  WORKING: "working",
  ERROR: "error",
} as const;

export const runtimeStateSchema = z.enum(["idle", "working", "error"]);
export type RuntimeState = z.infer<typeof runtimeStateSchema>;

// -- Agent Activity Payload (client → server) --

export const agentActivitySchema = z.object({
  state: runtimeStateSchema,
  description: z.string().max(500).optional(),
  activeSessions: z.number().int().min(0).optional(),
  totalSessions: z.number().int().min(0).optional(),
  errorMessage: z.string().max(1000).optional(),
  taskRef: z.string().max(200).optional(),
});
export type AgentActivity = z.infer<typeof agentActivitySchema>;

// -- Agent Bind Payload (client → server) --

export const agentBindSchema = z.object({
  token: z.string().min(1),
  runtimeType: z.string().max(50),
  runtimeVersion: z.string().max(50).optional(),
});
export type AgentBind = z.infer<typeof agentBindSchema>;

// -- Session Info (reported with activity, not persisted to DB) --

export const sessionInfoSchema = z.object({
  chatId: z.string(),
  status: z.enum(["active", "suspended", "evicted"]),
  claudeSessionId: z.string().nullable(),
  startedAt: z.string(),
  lastActiveAt: z.string(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

// -- Extended Agent Presence --

export const agentPresenceSchema = z.object({
  agentId: z.string(),
  status: presenceStatusSchema,
  connectedAt: z.string().nullable(),
  lastSeenAt: z.string(),
  clientId: z.string().nullable().optional(),
  runtimeType: z.string().nullable().optional(),
  runtimeVersion: z.string().nullable().optional(),
  runtimeState: runtimeStateSchema.nullable().optional(),
  runtimeDescription: z.string().nullable().optional(),
  activeSessions: z.number().int().nullable().optional(),
  totalSessions: z.number().int().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  taskRef: z.string().nullable().optional(),
  runtimeUpdatedAt: z.string().nullable().optional(),
});
export type AgentPresence = z.infer<typeof agentPresenceSchema>;

// -- Activity Overview (admin response) --

export const activityOverviewSchema = z.object({
  total: z.number().int(),
  running: z.number().int(),
  byState: z.object({
    idle: z.number().int(),
    working: z.number().int(),
    error: z.number().int(),
  }),
  clients: z.number().int(),
});
export type ActivityOverview = z.infer<typeof activityOverviewSchema>;
