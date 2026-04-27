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

/**
 * Agent-name rules (see docs/agent-naming-design.md §3.1):
 *   - Lowercase ASCII slug, hyphens + underscores allowed.
 *   - Must start with alphanumeric: `-` / `_` as first char collide with
 *     CLI flag parsing and markdown list syntax.
 *   - 1–64 chars — aligned with `MENTION_REGEX` so any valid name can be
 *     @-mentioned in chat. Older rows created under the previous 1–100
 *     regex are grandfathered; the tight rule only gates new creates.
 */
export const AGENT_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const AGENT_NAME_MAX_LENGTH = 64;

/**
 * Names users cannot claim in the portal. Prefix `__` is separately
 * reserved for Hub-internal pseudo-agents (enforced in the server service
 * layer) — this list covers short, obvious squatters that would confuse
 * routing, docs, or CLI help.
 */
export const RESERVED_AGENT_NAMES: readonly string[] = [
  "admin",
  "agent",
  "first-tree",
  "hub",
  "me",
  "null",
  "system",
  "undefined",
];

const RESERVED_AGENT_NAMES_SET: ReadonlySet<string> = new Set(RESERVED_AGENT_NAMES);

export function isReservedAgentName(name: string): boolean {
  return RESERVED_AGENT_NAMES_SET.has(name);
}

export const createAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(AGENT_NAME_MAX_LENGTH)
    .regex(
      AGENT_NAME_REGEX,
      "Must start with a letter or digit and contain only lowercase letters, digits, hyphens (-), and underscores (_). Max 64 chars.",
    )
    .refine((n) => !isReservedAgentName(n), {
      message: "That agent name is reserved — pick a different one.",
    })
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

/**
 * Server → client WebSocket frame announcing that an agent has just been
 * pinned to the connected client (either created with `clientId` or bound via
 * PATCH NULL → ID). The client can auto-register a local config from this so
 * the operator doesn't have to run `first-tree-hub agent add` manually.
 */
export const agentPinnedMessageSchema = z.object({
  type: z.literal("agent:pinned"),
  agentId: z.string(),
  name: z.string().nullable(),
  displayName: z.string().nullable(),
  agentType: agentTypeSchema,
});
export type AgentPinnedMessage = z.infer<typeof agentPinnedMessageSchema>;
