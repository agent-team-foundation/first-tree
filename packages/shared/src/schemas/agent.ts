import { z } from "zod";
import { presenceStatusSchema } from "./presence.js";

export const AGENT_TYPES = {
  HUMAN: "human",
  PERSONAL_ASSISTANT: "personal_assistant",
  AUTONOMOUS_AGENT: "autonomous_agent",
} as const;

export const agentTypeSchema = z.enum(["human", "personal_assistant", "autonomous_agent"]);
export type AgentType = z.infer<typeof agentTypeSchema>;

export const AGENT_VISIBILITY = {
  PRIVATE: "private",
  ORGANIZATION: "organization",
} as const;

export const agentVisibilitySchema = z.enum(["private", "organization"]);
export type AgentVisibility = z.infer<typeof agentVisibilitySchema>;

export const AGENT_STATUSES = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DELETED: "deleted",
} as const;

export const AGENT_SOURCES = {
  ADMIN_API: "admin-api",
  PORTAL: "portal",
} as const;

export const agentSourceSchema = z.enum(["admin-api", "portal"]);
export type AgentSource = z.infer<typeof agentSourceSchema>;

export const agentStatusSchema = z.enum(["active", "suspended"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const createAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_-]+$/, "Only lowercase alphanumeric, hyphens, and underscores")
    .optional(),
  type: agentTypeSchema,
  displayName: z.string().max(200).optional(),
  delegateMention: z.string().max(100).optional(),
  organizationId: z.string().max(100).optional(),
  /** How this agent was created */
  source: agentSourceSchema.optional(),
  /** Agent visibility: "private" (manager only) or "organization" (all members) */
  visibility: agentVisibilitySchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Member who manages this agent */
  managerId: z.string().optional(),
  /**
   * Physical client this agent is pinned to. Optional — when omitted for a
   * non-human agent the row stays NULL and is claimed on the first WS bind
   * (see `api/agent/ws-client.ts`). Human agents must omit it.
   */
  clientId: z.string().min(1).max(100).optional(),
});
export type CreateAgent = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = z.object({
  type: agentTypeSchema.optional(),
  displayName: z.string().max(200).nullable().optional(),
  delegateMention: z.string().max(100).nullable().optional(),
  visibility: agentVisibilitySchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Admin-only: reassign the manager */
  managerId: z.string().nullable().optional(),
  /**
   * One-shot bind. NULL → ID is allowed (admin claims an unbound agent for
   * a known client); ID → another ID and ID → null are rejected by the
   * service layer with explicit 400s.
   */
  clientId: z.string().min(1).max(100).nullable().optional(),
});
export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const agentSchema = z.object({
  uuid: z.string(),
  name: z.string().nullable(),
  organizationId: z.string(),
  type: agentTypeSchema,
  displayName: z.string().nullable(),
  delegateMention: z.string().nullable(),
  inboxId: z.string(),
  status: z.string(),
  /** How this agent was created */
  source: z.string().nullable().optional(),
  /** Control-plane user association (nullable, cloud-only) */
  cloudUserId: z.string().nullable().optional(),
  /** Agent visibility: "private" (manager only) or "organization" (all members) */
  visibility: agentVisibilitySchema,
  metadata: z.record(z.string(), z.unknown()),
  /** Member who manages this agent */
  managerId: z.string().nullable(),
  /** Physical client this agent is pinned to. NULL for human agents only. */
  clientId: z.string().nullable(),
  presenceStatus: presenceStatusSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Agent = z.infer<typeof agentSchema>;

export const contextTreeInfoSchema = z.object({
  repo: z.string().nullable(),
  branch: z.string().nullable(),
});
export type ContextTreeInfo = z.infer<typeof contextTreeInfoSchema>;
