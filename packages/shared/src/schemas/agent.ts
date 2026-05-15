import { z } from "zod";
import { gitRepoSchema } from "./agent-runtime-config.js";
import { presenceStatusSchema } from "./presence.js";
import { runtimeProviderSchema } from "./runtime-provider.js";

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

/**
 * Manager-selected avatar color. Each token references the matching
 * `--avatar-hue-*` CSS variable in the web client. `null` (the default
 * row state and the sentinel for "clear") means "auto" — the renderer
 * falls back to the deterministic djb2 hash of the agent's uuid.
 */
export const AVATAR_COLOR_TOKENS = ["hue-0", "hue-1", "hue-2", "hue-3", "hue-4", "hue-5", "hue-6", "hue-7"] as const;
export const avatarColorTokenSchema = z.enum(AVATAR_COLOR_TOKENS);
export type AvatarColorToken = z.infer<typeof avatarColorTokenSchema>;

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
  /**
   * Post-Phase 2 the DB enforces `NOT NULL`; the service layer defaults
   * missing/empty values to `name` (or "Unnamed Agent") so callers can
   * still omit this. Reject empty / whitespace-only strings at the edge
   * so the silent server-side replacement doesn't mask a user typo.
   */
  displayName: z.string().min(1).max(200).optional(),
  delegateMention: z.string().max(100).optional(),
  organizationId: z.string().min(1).max(100).optional(),
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
  /**
   * Runtime provider that drives this agent. Defaults to `"claude-code"` at
   * the service layer when omitted. Must match a provider available in the
   * pinned client's reported capabilities (or be force-overridden).
   */
  runtimeProvider: runtimeProviderSchema.optional(),
  /** Archive-triggered Context Tree write automation. Default OFF. */
  treeWriteOnArchive: z.boolean().optional(),
  /**
   * Initial gitRepos seed for the runtime config. When provided, the service
   * layer writes them into the version=1 agent_configs row instead of the
   * default empty payload — atomic with the agent insert, so first-chat
   * `prepareGitWorktrees` always sees the bind. Used by onboarding Step 2
   * to wire the picked GitHub repo without a follow-up PATCH race.
   */
  gitRepos: z.array(gitRepoSchema).optional(),
});
export type CreateAgent = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = z.object({
  type: agentTypeSchema.optional(),
  /**
   * Phase 2 of the agent-naming refactor promoted `displayName` to NOT NULL
   * at the DB level, so null is no longer an accepted update — clearing the
   * label would violate the constraint. Callers that used to PATCH
   * `{ displayName: null }` must omit the field (leaves the row untouched)
   * or send a real string.
   */
  displayName: z.string().min(1).max(200).optional(),
  delegateMention: z.string().max(100).nullable().optional(),
  visibility: agentVisibilitySchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Admin-only: reassign the manager */
  managerId: z.string().nullable().optional(),
  /**
   * One-shot bind. NULL → ID still allowed (admin claims an unbound agent for
   * a known client). ID → another ID and ID → null are rejected at the
   * service layer; cross-client moves go through `rebindAgent`, which runs
   * owner / org / capability checks atomically.
   */
  clientId: z.string().min(1).max(100).nullable().optional(),
  /**
   * Avatar color override. Explicit `null` clears the override (falls back
   * to the deterministic hash). Omitting the field leaves the row untouched.
   */
  avatarColorToken: avatarColorTokenSchema.nullable().optional(),
  /** Archive-triggered Context Tree write automation. */
  treeWriteOnArchive: z.boolean().optional(),
});
export type UpdateAgent = z.infer<typeof updateAgentSchema>;

/**
 * Service-level rebind input. Admin / owner re-binds an agent to a new
 * client and/or a new runtime provider in one atomic operation.
 *
 * `force` bypasses the capability-match check (e.g. when the client is
 * offline and capabilities are stale).
 */
export const rebindAgentSchema = z.object({
  clientId: z.string().min(1).max(100),
  runtimeProvider: runtimeProviderSchema,
  force: z.boolean().optional(),
});
export type RebindAgent = z.infer<typeof rebindAgentSchema>;

export const agentSchema = z.object({
  uuid: z.string(),
  name: z.string().nullable(),
  organizationId: z.string(),
  type: agentTypeSchema,
  /**
   * Always populated post-Phase 2 (migration 0024 backfilled + `NOT NULL`).
   * The shared type used to be nullable; old row-shape consumers were
   * retired alongside the server service default.
   */
  displayName: z.string(),
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
  /** Which runtime provider drives this agent. NOT NULL post-0026. */
  runtimeProvider: runtimeProviderSchema,
  /** Archive-triggered Context Tree write automation. */
  treeWriteOnArchive: z.boolean(),
  /**
   * Manager-selected avatar color token (one of `AVATAR_COLOR_TOKENS`).
   * NULL means "auto" — the web renderer falls back to the deterministic
   * djb2 hash of `uuid`. Kept loose (`string`) on the read side so legacy
   * or unrecognised values flow through harmlessly; the renderer guards
   * on the known set.
   */
  avatarColorToken: z.string().nullable(),
  /**
   * Synthesized URL for the manager-uploaded avatar image. NULL when no
   * image is set. Carries a cache-busting suffix derived from the image's
   * last-upload timestamp so browsers refetch after a change. The image
   * itself is served by `GET /api/v1/agents/:uuid/avatar`.
   */
  avatarImageUrl: z.string().nullable(),
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
  /**
   * Always populated post-Phase 2 (agents.display_name is NOT NULL). Old
   * clients that parsed the previous `nullable` variant still accept a
   * non-null string, so tightening this here is wire-compatible.
   */
  displayName: z.string(),
  agentType: agentTypeSchema,
  /**
   * Authoritative runtime provider for this agent (post-0026). Older clients
   * that omit this field on parse are tolerated by the consumer side, which
   * falls back to `"claude-code"` for legacy compatibility.
   */
  runtimeProvider: runtimeProviderSchema,
});
export type AgentPinnedMessage = z.infer<typeof agentPinnedMessageSchema>;
