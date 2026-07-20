import { z } from "zod";
import { paginationQuerySchema } from "./common.js";
import { presenceStatusSchema, runtimeStateSchema } from "./presence.js";
import { runtimeProviderSchema } from "./runtime-provider.js";

export const AGENT_TYPES = {
  HUMAN: "human",
  AGENT: "agent",
} as const;

export const agentTypeSchema = z.enum(["human", "agent"]);
export type AgentType = z.infer<typeof agentTypeSchema>;

/**
 * Wire-compatibility enum for `agent:pinned` WebSocket frames. Accepts the
 * post-merge values (`human`, `agent`) AND the pre-merge values
 * (`personal_assistant`, `autonomous_agent`) so that:
 *
 *   - **Old clients (≤ 0.5.1)** can still parse frames pushed by post-merge
 *     servers — the server translates `agent` rows back to the old enum based
 *     on `visibility` (private → personal_assistant, organization →
 *     autonomous_agent) before sending. The old client decodes a value it
 *     recognises and keeps working without an upgrade.
 *   - **New clients (≥ 0.5.2)** can still parse frames pushed by pre-merge
 *     servers if the rollout interleaves — they see one of the legacy values
 *     and downstream code collapses it to `agent` (visibility is the
 *     authoritative axis post-merge anyway).
 *
 * Remove the two legacy values once every deployed client is on a release
 * that emits/consumes only the post-merge values.
 */
export const legacyWireAgentTypeSchema = z.enum(["human", "agent", "personal_assistant", "autonomous_agent"]);
export type LegacyWireAgentType = z.infer<typeof legacyWireAgentTypeSchema>;

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
  /**
   * Created by another *agent* through the gated self-provisioning path
   * (`POST /api/v1/agent/managed-agents`). Distinct from `admin-api` (human
   * operator / web console) so agent-initiated creates are first-class and
   * queryable in provenance without reading `metadata.createdBy`.
   */
  AGENT_API: "agent-api",
} as const;

export const agentSourceSchema = z.enum(["admin-api", "portal", "agent-api"]);
export type AgentSource = z.infer<typeof agentSourceSchema>;

export const agentStatusSchema = z.enum(["active", "suspended"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/**
 * Metadata keys that are First Tree-managed internal state, never writable
 * through the free-form `metadata` field on create/update. Two families:
 *   - runtime state (`runtimeSwitch`, `runtimeSession`) — set by the runtime.
 *   - provisioning state (`agentCapabilities`, `createdBy`) — `agentCapabilities`
 *     is an admin-granted capability set (e.g. `provision-agents`); `createdBy`
 *     is agent-provisioning provenance. Both are write-protected here so a
 *     manager (or their agent, which holds the manager's JWT) cannot self-grant
 *     or spoof provenance via `metadata`. They are surfaced for reading through
 *     dedicated endpoints (see `GET /agents/:uuid/capabilities`), not the
 *     stripped `metadata` projection.
 *
 * NOTE distinct from `clients.metadata.capabilities`, which is a machine's
 * reported runtime-provider capability blob — unrelated to this per-agent grant.
 */
export const RESERVED_AGENT_METADATA_KEYS = [
  "runtimeSwitch",
  "runtimeSession",
  "agentCapabilities",
  "createdBy",
] as const;

const reservedAgentMetadataKeySet: ReadonlySet<string> = new Set(RESERVED_AGENT_METADATA_KEYS);

export function findReservedAgentMetadataKey(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata) return null;
  for (const key of Object.keys(metadata)) {
    if (reservedAgentMetadataKeySet.has(key)) return key;
  }
  return null;
}

export const userAgentMetadataSchema = z.record(z.string(), z.unknown()).superRefine((metadata, ctx) => {
  const key = findReservedAgentMetadataKey(metadata);
  if (!key) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `metadata.${key} is reserved for First Tree internal runtime state`,
    path: [key],
  });
});

/**
 * Agent-name rules (see first-tree-context:agent-hub/agent-naming.md §3.1):
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
 * reserved for First Tree-internal pseudo-agents (enforced in the server service
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
  metadata: userAgentMetadataSchema.optional(),
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
});
export type CreateAgent = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = z.object({
  // Agent kind is established at creation. Human mirrors are owned by the
  // member lifecycle, so generic PATCH must not support human <-> agent flips.
  type: z.never().optional(),
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
  metadata: userAgentMetadataSchema.optional(),
  /** Admin-only: reassign the manager */
  managerId: z.string().nullable().optional(),
  /**
   * One-shot bind. NULL → ID still allowed (admin claims an unbound agent for
   * a known client). ID → another ID and ID → null are rejected at the
   * generic PATCH service layer; moving a bound runtime must go through the
   * managed switch-runtime endpoint.
   */
  clientId: z.string().min(1).max(100).nullable().optional(),
  /**
   * Avatar color override. Explicit `null` clears the override (falls back
   * to the deterministic hash). Omitting the field leaves the row untouched.
   */
  avatarColorToken: avatarColorTokenSchema.nullable().optional(),
});
export type UpdateAgent = z.infer<typeof updateAgentSchema>;

/**
 * Per-agent capabilities that a human admin may grant to unlock otherwise
 * operator-only actions from inside a running agent session. Default-deny:
 * an agent has no capability unless an admin explicitly grants it.
 *
 * v1 defines a single capability:
 *   - `provision-agents` — may create teammate agents in its own org, managed
 *     by its own manager, on a human-owned client, via
 *     `POST /api/v1/agent/managed-agents`.
 */
export const AGENT_CAPABILITIES = {
  PROVISION_AGENTS: "provision-agents",
} as const;

export const agentCapabilitySchema = z.enum(["provision-agents"]);
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;

export const agentCapabilitiesSchema = z.array(agentCapabilitySchema);
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

/**
 * Provenance stamp written to `agents.metadata.createdBy` when an agent is
 * created through the gated self-provisioning path. `agentId` is the acting
 * (creator) agent; `memberId` is the managing member both agents share; `at`
 * is an ISO timestamp.
 */
export const agentProvenanceSchema = z.object({
  agentId: z.string(),
  memberId: z.string(),
  at: z.string(),
});
export type AgentProvenance = z.infer<typeof agentProvenanceSchema>;

/**
 * Body for `POST /api/v1/agent/managed-agents` — the agent-scoped teammate
 * create. Deliberately narrow: `type`, `organizationId`, `managerId`, `source`,
 * and `metadata` are NOT accepted — the server forces them from the acting
 * agent's identity so a caller can never widen scope. `type` is always `agent`.
 */
export const createManagedAgentSchema = createAgentSchema.pick({
  name: true,
  displayName: true,
  visibility: true,
  clientId: true,
  runtimeProvider: true,
});
export type CreateManagedAgent = z.infer<typeof createManagedAgentSchema>;

/**
 * Body for the admin-only `PATCH /api/v1/agents/:uuid/capabilities` grant
 * route. Replaces the agent's full capability set (empty array clears it).
 */
export const setAgentCapabilitiesSchema = z.object({
  capabilities: agentCapabilitiesSchema,
});
export type SetAgentCapabilities = z.infer<typeof setAgentCapabilitiesSchema>;

/**
 * Read-back shape for the capabilities endpoints. `createdBy` is only populated
 * for admin callers (provisioning provenance); non-admin managers see the
 * capability set but not the provenance.
 */
export const agentCapabilitiesViewSchema = z.object({
  agentId: z.string(),
  agentCapabilities: agentCapabilitiesSchema,
  createdBy: agentProvenanceSchema.nullable().optional(),
});
export type AgentCapabilitiesView = z.infer<typeof agentCapabilitiesViewSchema>;

export const switchAgentRuntimeSchema = z.object({
  /**
   * Target computer/client id. This is intentionally a required explicit
   * choice: runtime switches may move local workspace state between machines.
   */
  clientId: z.string().min(1).max(100),
  runtimeProvider: runtimeProviderSchema,
  /**
   * Product-level confirmation that the user accepts interruption of active
   * sessions and possible local-runtime state loss. This is not a safety-check
   * bypass; server preconditions still run.
   */
  confirmLocalDataLoss: z.literal(true),
});
export type SwitchAgentRuntime = z.infer<typeof switchAgentRuntimeSchema>;

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
  /**
   * ISO timestamp of the agent's last presence heartbeat
   * (`agent_presence.last_seen_at`). Drives the "active X ago" hover on the
   * Team page status cell. Absent on single-agent reads that don't join
   * presence; null when the agent has never connected.
   */
  lastSeenAt: z.string().nullable().optional(),
  /**
   * Runtime-A business state from `agent_presence.runtime_state` (the M1+
   * authority for "is this agent running"; NULL when not bound). Carried on
   * single-agent reads + mutations so management surfaces can derive
   * reachability (`runtimeState != null` ⟺ reachable) without depending on
   * the legacy `presenceStatus` column.
   */
  runtimeState: runtimeStateSchema.nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Agent = z.infer<typeof agentSchema>;

export const newChatDefaultCandidateAgentSchema = z.object({
  uuid: z.string(),
  name: z.string().nullable(),
  displayName: z.string(),
  type: agentTypeSchema,
  status: z.string(),
  managerId: z.string().nullable(),
  createdAt: z.string(),
});
export type NewChatDefaultCandidateAgent = z.infer<typeof newChatDefaultCandidateAgentSchema>;

export const newChatDefaultCandidatesRequestSchema = z.object({
  cachedAgentId: z.string().min(1).nullable().optional(),
});
export type NewChatDefaultCandidatesRequest = z.infer<typeof newChatDefaultCandidatesRequestSchema>;

export const newChatDefaultCandidatesResponseSchema = z.object({
  agent: newChatDefaultCandidateAgentSchema.nullable(),
});
export type NewChatDefaultCandidatesResponse = z.infer<typeof newChatDefaultCandidatesResponseSchema>;

export const contextTreeInfoSchema = z.object({
  repo: z.string().nullable(),
  branch: z.string().nullable(),
});
export type ContextTreeInfo = z.infer<typeof contextTreeInfoSchema>;

/**
 * Server → client WebSocket frame announcing that an agent has just been
 * pinned to the connected client (either created with `clientId` or bound via
 * PATCH NULL → ID). The client can auto-register a local config from this so
 * the operator doesn't have to run `agent add` manually.
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
  /**
   * Wire-only: accepts the 4-value legacy enum (`human`, `agent`,
   * `personal_assistant`, `autonomous_agent`) for cross-version
   * compatibility. See {@link legacyWireAgentTypeSchema}. The server emits
   * the post-merge canonical (`human` / `agent`) for new clients and
   * translates `agent` rows back to `personal_assistant` / `autonomous_agent`
   * for older clients that predate the type-merge. New consumers should
   * collapse the two legacy values to `agent` after parsing.
   */
  agentType: legacyWireAgentTypeSchema,
  /**
   * Authoritative runtime provider for this agent (post-0026). Older clients
   * that omit this field on parse are tolerated by the consumer side, which
   * falls back to `"claude-code"` for legacy compatibility.
   */
  runtimeProvider: runtimeProviderSchema,
});
export type AgentPinnedMessage = z.infer<typeof agentPinnedMessageSchema>;

/**
 * Query string accepted by `GET /orgs/:orgId/agents` — pagination + the
 * agent-type filter + an optional substring search.
 *
 * `query` powers the participant picker's server-side search so orgs with
 * more than `limit` (100) visible agents can still reach agents past the
 * first page (issue 494). The cap on `limit` is unchanged; `query` is the
 * other dimension along which the picker narrows the result set.
 *
 * Trimming happens at the schema level so a whitespace-only input behaves
 * the same as an omitted param (no filtering) instead of erroring out —
 * the service treats an empty string as "no search". 60 chars is generous
 * for slug + display name without giving the ILIKE predicate an unbounded
 * input.
 */
export const listAgentsQuerySchema = paginationQuerySchema.extend({
  type: agentTypeSchema.optional(),
  query: z.string().trim().max(60).optional(),
  addressableOnly: z
    .preprocess((value) => {
      if (value === undefined || value === "") return undefined;
      if (value === true || value === "true" || value === "1") return true;
      if (value === false || value === "false" || value === "0") return false;
      return value;
    }, z.boolean().optional())
    .default(false),
});
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;
