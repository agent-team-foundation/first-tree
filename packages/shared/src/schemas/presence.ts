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
  BLOCKED: "blocked",
  ERROR: "error",
} as const;

export const runtimeStateSchema = z.enum(["idle", "working", "blocked", "error"]);
export type RuntimeState = z.infer<typeof runtimeStateSchema>;

// -- Session State (client → server, per-session) --

export const SESSION_STATES = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  EVICTED: "evicted",
} as const;

export const sessionStateSchema = z.enum(["active", "suspended", "evicted"]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const sessionStateMessageSchema = z.object({
  chatId: z.string().min(1),
  state: sessionStateSchema,
});
export type SessionStateMessage = z.infer<typeof sessionStateMessageSchema>;

/** Client-reported runtime state override (client → server, per-agent). */
export const runtimeStateMessageSchema = z.object({
  runtimeState: runtimeStateSchema,
});
export type RuntimeStateMessage = z.infer<typeof runtimeStateMessageSchema>;

// -- Agent Bind Payload (client → server) --
// v2: token removed; authorization derives from the WS-level JWT and the
// client_id pinned to the agent (Rule R-RUN).

export const agentBindRequestSchema = z.object({
  agentId: z.string().min(1),
  runtimeType: z.string().max(50),
  runtimeVersion: z.string().max(50).optional(),
});
export type AgentBindRequest = z.infer<typeof agentBindRequestSchema>;

export const AGENT_BIND_REJECT_REASONS = {
  WRONG_CLIENT: "wrong_client",
  NOT_OWNED: "not_owned",
  AGENT_SUSPENDED: "agent_suspended",
  WRONG_ORG: "wrong_org",
  UNKNOWN_AGENT: "unknown_agent",
} as const;

export const agentBindRejectReasonSchema = z.enum([
  "wrong_client",
  "not_owned",
  "agent_suspended",
  "wrong_org",
  "unknown_agent",
]);
export type AgentBindRejectReason = z.infer<typeof agentBindRejectReasonSchema>;

/** Header used on agent-scoped HTTP calls to select which managed agent the JWT acts as. */
export const AGENT_SELECTOR_HEADER = "x-agent-id";

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
  activeSessions: z.number().int().nullable().optional(),
  totalSessions: z.number().int().nullable().optional(),
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
    blocked: z.number().int(),
    error: z.number().int(),
  }),
  clients: z.number().int(),
});
export type ActivityOverview = z.infer<typeof activityOverviewSchema>;
