import { z } from "zod";
import { presenceStatusSchema } from "./presence.js";

export const AGENT_TYPES = {
  HUMAN: "human",
  PERSONAL_ASSISTANT: "personal_assistant",
  AUTONOMOUS_AGENT: "autonomous_agent",
} as const;

export const agentTypeSchema = z.enum(["human", "personal_assistant", "autonomous_agent"]);
export type AgentType = z.infer<typeof agentTypeSchema>;

export const AGENT_STATUSES = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DELETED: "deleted",
} as const;

export const agentStatusSchema = z.enum(["active", "suspended"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const createAgentSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_-]+$/, "Only lowercase alphanumeric, hyphens, and underscores")
    .optional(),
  type: agentTypeSchema,
  displayName: z.string().max(200).optional(),
  delegateMention: z.string().max(100).optional(),
  profile: z.string().optional(),
  organizationId: z.string().max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateAgent = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = z.object({
  type: agentTypeSchema.optional(),
  displayName: z.string().max(200).nullable().optional(),
  delegateMention: z.string().max(100).nullable().optional(),
  profile: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const agentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: agentTypeSchema,
  displayName: z.string().nullable(),
  delegateMention: z.string().nullable(),
  profile: z.string().nullable(),
  inboxId: z.string(),
  status: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  presenceStatus: presenceStatusSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Agent = z.infer<typeof agentSchema>;

// -- Bootstrap schemas --

export const bootstrapTokenRequestSchema = z.object({
  name: z.string().max(100).optional(),
  /** Optional fields used when the bootstrap endpoint auto-creates the agent. */
  type: agentTypeSchema.optional(),
  displayName: z.string().max(200).optional(),
  profile: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type BootstrapTokenRequest = z.infer<typeof bootstrapTokenRequestSchema>;

export const bootstrapStatusSchema = z.object({
  exists: z.boolean(),
  status: z.enum(["active", "suspended"]).nullable(),
});
export type BootstrapStatus = z.infer<typeof bootstrapStatusSchema>;

export const contextTreeInfoSchema = z.object({
  repo: z.string().nullable(),
  branch: z.string().nullable(),
});
export type ContextTreeInfo = z.infer<typeof contextTreeInfoSchema>;
