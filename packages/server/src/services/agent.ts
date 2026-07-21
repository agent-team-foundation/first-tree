import type {
  AgentSkills,
  AgentType,
  AgentVisibility,
  CreateAgent,
  RuntimeProvider,
  UpdateAgent,
} from "@first-tree/shared";
import {
  AGENT_NAME_REGEX,
  AGENT_STATUSES,
  AGENT_TYPES,
  AGENT_VISIBILITY,
  DEFAULT_RUNTIME_PROVIDER,
  defaultRuntimeConfigPayload,
  findReservedAgentMetadataKey,
  isReservedAgentName,
  RESERVED_AGENT_METADATA_KEYS,
  runtimeProviderSchema,
} from "@first-tree/shared";
import { getServerCliBinding } from "@first-tree/shared/channel";
import { and, asc, count, desc, eq, getTableColumns, ilike, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Database } from "../db/connection.js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agentProvisioningAudit } from "../db/schema/agent-provisioning-audit.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import { BadRequestError, ClientRetiredError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import type { OrgScope } from "../scope/types.js";
import { uuidv7 } from "../uuid.js";
import {
  agentAddressableCondition,
  agentNotLandingCampaignTrialCondition,
  agentVisibilityCondition,
} from "./access-control.js";
import { resolveDefaultOrgId } from "./organization.js";
import { recomputeWatchersForAgent } from "./watcher.js";

/**
 * Names beginning with `__` are reserved for First Tree-internal pseudo agents.
 * User-facing creation must not be able to squat on them, otherwise
 * internal traffic could be routed through a real account.
 */
const RESERVED_AGENT_NAME_PREFIX = "__";
type SelectDbLike = Pick<PostgresJsDatabase<Record<string, never>>, "select">;
export type NewChatDefaultCandidateAgent = {
  uuid: string;
  name: string | null;
  displayName: string;
  type: string;
  status: string;
  managerId: string | null;
  createdAt: Date;
};

export function assertUserAgentMetadataHasNoReservedKeys(metadata: Record<string, unknown> | undefined): void {
  const key = findReservedAgentMetadataKey(metadata);
  if (!key) return;
  throw new BadRequestError(`metadata.${key} is reserved for First Tree internal runtime state`);
}

export function stripReservedAgentMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const publicMetadata = { ...(metadata as Record<string, unknown>) };
  for (const key of RESERVED_AGENT_METADATA_KEYS) {
    delete publicMetadata[key];
  }
  return publicMetadata;
}

// Callers provide public metadata; internal runtime state is copied from the existing row.
export function agentMetadataUpdateExpressionPreservingRuntimeState(metadata: Record<string, unknown>) {
  return sql`${JSON.stringify(metadata)}::jsonb || jsonb_strip_nulls(jsonb_build_object(
    'runtimeSwitch', ${agents.metadata}->'runtimeSwitch',
    'runtimeSession', ${agents.metadata}->'runtimeSession'
  ))`;
}

/**
 * Derive the relative URL clients should use to fetch a manager-uploaded
 * avatar image. Returns `null` when no image is set. Embeds the upload
 * timestamp as `?v=<epoch>` so a fresh upload busts any browser cache
 * that may have memoised the previous version.
 *
 * Auth: the image route is intentionally public read — the URL leaks no
 * more than the agent's UUID, which is already required to address it.
 * Keeping it unauthenticated lets `<img src>` render without bespoke
 * fetch-and-blob plumbing.
 */
export function agentAvatarImageUrl(uuid: string, updatedAt: Date | null | undefined): string | null {
  if (!updatedAt) return null;
  return `/api/v1/agents/${uuid}/avatar?v=${updatedAt.getTime()}`;
}

/**
 * Resolve the public avatar image URL for an agent, considering both the
 * manager-uploaded image and — for human agents — the user's external
 * avatar URL (e.g. GitHub `users.avatar_url` injected by OAuth). Returns
 * `null` when neither source is available; the renderer then falls back
 * to color + initial.
 *
 * Priority: uploaded image > human user's avatar > null. The "upload
 * wins" rule gives users explicit control: once they upload a custom
 * avatar for their human agent it always shows, regardless of any later
 * GitHub avatar change.
 */
export function resolveAvatarImageUrl(args: {
  uuid: string;
  type: string;
  avatarImageUpdatedAt: Date | null | undefined;
  userAvatarUrl: string | null | undefined;
}): string | null {
  const uploaded = agentAvatarImageUrl(args.uuid, args.avatarImageUpdatedAt);
  if (uploaded) return uploaded;
  if (args.type === AGENT_TYPES.HUMAN && args.userAvatarUrl) return args.userAvatarUrl;
  return null;
}

/**
 * Look up the external user-avatar URL backing a human agent via the
 * `members.agent_id → members.user_id → users.avatar_url` path. Returns
 * `null` for non-human agents or when the user has no avatar URL
 * captured (e.g. signed in without GitHub OAuth). Used by single-agent
 * API responses; list endpoints inline the join in their SELECT.
 */
export async function fetchUserAvatarForHumanAgent(
  db: Database,
  agent: { uuid: string; type: string },
): Promise<string | null> {
  if (agent.type !== AGENT_TYPES.HUMAN) return null;
  const [row] = await db
    .select({ avatarUrl: users.avatarUrl })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(eq(members.agentId, agent.uuid))
    .limit(1);
  return row?.avatarUrl ?? null;
}

/**
 * True iff `clients.metadata.capabilities` is a non-empty object — i.e. the
 * client has reported at least one runtime probe result. Used to distinguish
 * "we don't know what's installed yet" (empty / never reported) from
 * "client explicitly reports this provider is missing".
 */
function clientCapabilitiesReported(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const meta = metadata as Record<string, unknown>;
  const caps = meta.capabilities;
  if (!caps || typeof caps !== "object") return false;
  return Object.keys(caps as Record<string, unknown>).length > 0;
}

/**
 * Inspect a `clients.metadata.capabilities` blob (jsonb) for a specific
 * runtime provider entry. Capabilities live under the `metadata.capabilities`
 * subkey (Option C); the column is unstructured at the DB layer, so we
 * defensively narrow before key access.
 *
 * "Supports" requires the entry to be **available** — i.e. `available === true`,
 * which under install-only detection means `state: "ok"` (the binary is
 * installed). A `missing` or `error` entry is *reported* but not installed, so
 * we explicitly reject those rather than treating mere key presence as support.
 * Authentication is no longer probed; a logged-out provider is still `available`
 * (installed) and the login is resolved at session run time via the in-chat
 * needs-login entry, not gated here.
 */
function clientSupportsRuntimeProvider(metadata: unknown, provider: RuntimeProvider): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const meta = metadata as Record<string, unknown>;
  const caps = meta.capabilities;
  if (!caps || typeof caps !== "object") return false;
  const entry = (caps as Record<string, unknown>)[provider];
  if (!entry || typeof entry !== "object") return false;
  const available = (entry as { available?: unknown }).available;
  return available === true;
}

/**
 * Default visibility per agent type. Both `human` and `agent` default to
 * "organization" — the bot-style default that pre-merge `autonomous_agent`
 * carried. The "personal assistant" framing (private to the manager) is now
 * explicit: callers that want the private default (new-agent dialog, CLI
 * assistant onboarding) pass `visibility: "private"` directly.
 */
function defaultVisibility(type: AgentType): AgentVisibility {
  switch (type) {
    case "human":
    case "agent":
      return AGENT_VISIBILITY.ORGANIZATION;
    default:
      return AGENT_VISIBILITY.PRIVATE;
  }
}

/**
 * Translate a post-merge `agents.type` value into the 3-value enum older
 * clients (≤ 0.5.1) expect on the wire. The pre-merge type enum was
 * `human | personal_assistant | autonomous_agent`; this PR collapsed the
 * latter two into a single `agent` row. Old clients deserialise the
 * `agent:pinned` WS frame via a strict zod enum that rejects the unknown
 * `agent` value — pushing the legacy label keeps them working without an
 * upgrade. Drop this helper (and emit `agentTypeSchema` directly) once
 * every deployed client is on a release that accepts `agent`.
 *
 * Non-human rows are uniformly mapped to `personal_assistant`. The
 * `(visibility=private) ⇔ personal_assistant` invariant the 0018
 * backfill established is *not* preserved going forward (the product
 * allows a PA to be `visibility=organization` and vice versa), so any
 * visibility-based reverse mapping would be misleading. `personal_assistant`
 * is picked because today's data is overwhelmingly PA — for the rare
 * autonomous bot the only knock-on effect on a 0.5.1 client is a cosmetic
 * "personal assistant" string in the generated `CLAUDE.md` self-description.
 * The frame still parses, the daemon still writes its local `agent.yaml`,
 * the runtime still starts.
 *
 * `type` is `string` because callers source it from a drizzle text column;
 * narrowing to `AgentType` at every call site would be needless ceremony.
 */
export function legacyWireAgentType(type: string): "human" | "personal_assistant" {
  return type === "human" ? "human" : "personal_assistant";
}

/**
 * Resolve + validate the client that will own the new agent.
 *
 * Rule (unified-user-token, post-first-bind relaxation):
 *   - Human agents represent the member themselves and have no runtime; a
 *     missing `clientId` is required and the column stays NULL.
 *   - Non-human agents MAY omit `clientId` at creation; the row stays NULL
 *     and is claimed on the first WS bind (see `api/agent/ws-client.ts`).
 *   - When a non-human agent IS created with a `clientId`, the pinned client
 *     must already be owned by the manager's user (Rule R-RUN).
 */
/**
 * Check that a client's reported capabilities show the given runtime provider
 * as **available** (SDK installed, regardless of auth state).
 *
 * Tri-state semantics by `clients.metadata.capabilities` shape:
 *   - empty / absent — client hasn't probed yet (newly registered or pre-P2
 *     install). Treat as "unknown" and allow; the in-band repair path
 *     (RUNTIME_PROVIDER_MISMATCH on bind) catches actual incompatibility.
 *   - reported, entry shows `available: true` (install-only `state: ok`) — allow.
 *   - reported, entry missing OR `state: missing | error` — block unless
 *     `force` is set. We deliberately do NOT treat mere key presence as
 *     support: probeCapabilities() always emits an entry per built-in
 *     provider, including `{ state: "missing" }` for absent SDKs.
 *
 * Skipped entirely for human agents (no clientId) and when `force` is set
 * (e.g. operator overrides for an offline client).
 */
export async function ensureClientSupportsRuntimeProvider(
  db: SelectDbLike,
  clientId: string | null,
  runtimeProvider: RuntimeProvider,
  options: { force?: boolean } = {},
): Promise<void> {
  if (clientId === null) return;
  if (options.force) return;

  const [client] = await db
    .select({ metadata: clients.metadata, retiredAt: clients.retiredAt })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) return; // resolveAgentClient validates existence elsewhere
  if (client.retiredAt) {
    throw new ClientRetiredError(`Client "${clientId}" has been retired`);
  }

  // Best-effort: if the client never reported capabilities, allow and let
  // the runtime path catch real mismatches at bind time.
  if (!clientCapabilitiesReported(client.metadata)) return;

  if (!clientSupportsRuntimeProvider(client.metadata, runtimeProvider)) {
    throw new BadRequestError(
      `Client "${clientId}" does not have runtime provider "${runtimeProvider}" available. ` +
        "Install the matching SDK on that machine and re-run capability detection, " +
        "or retry with `force: true` if the client is offline / capabilities are stale.",
    );
  }
}

async function resolveAgentClient(
  db: SelectDbLike,
  data: { clientId?: string; managerId: string; type: string },
): Promise<string | null> {
  if (data.type === "human") {
    if (data.clientId) {
      throw new BadRequestError("Human agents cannot be pinned to a client");
    }
    return null;
  }

  if (!data.clientId) {
    return null;
  }

  const [manager] = await db
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.id, data.managerId), eq(members.status, "active")))
    .limit(1);
  if (!manager) {
    throw new BadRequestError(`Manager "${data.managerId}" not found`);
  }

  const [client] = await db
    .select({ id: clients.id, userId: clients.userId, retiredAt: clients.retiredAt })
    .from(clients)
    .where(eq(clients.id, data.clientId))
    .for("update")
    .limit(1);
  if (!client) {
    throw new BadRequestError(`Client "${data.clientId}" not found`);
  }

  if (!client.userId) {
    throw new BadRequestError(
      `Client "${data.clientId}" has not been claimed by a user yet. Have the operator run ` +
        `\`${getServerCliBinding().binName} login <code>\` on that machine before pinning an agent to it.`,
    );
  }
  if (client.userId !== manager.userId) {
    throw new ForbiddenError(
      `Client "${data.clientId}" is not owned by the manager's user — pick a client belonging to that user.`,
    );
  }
  if (client.retiredAt) {
    throw new ClientRetiredError(`Client "${data.clientId}" has been retired`);
  }

  return client.id;
}

/**
 * Validate a `delegateMention` write at the service layer. Two checks:
 *   1. Target uuid must resolve to an existing agent — dangling references
 *      would silently break webhook delegation at runtime.
 *   2. Target must belong to the same organization as the source agent —
 *      cross-org delegate links are rejected here at the source so the
 *      database never accumulates dirty rows. The webhook router has a
 *      defense-in-depth check that filters them at fan-out time, but this
 *      keeps the data clean and gives the admin UI an immediate 422 instead
 *      of a silent runtime drop.
 *
 * `null` clears the field — handled by the caller; we are only invoked when
 * the caller wrote a non-null uuid.
 */
async function validateDelegateMentionTarget(db: Database, targetUuid: string, sourceOrgId: string): Promise<void> {
  const [target] = await db
    .select({ uuid: agents.uuid, organizationId: agents.organizationId })
    .from(agents)
    .where(eq(agents.uuid, targetUuid))
    .limit(1);
  if (!target) {
    throw new BadRequestError(`delegateMention target "${targetUuid}" not found`);
  }
  if (target.organizationId !== sourceOrgId) {
    throw new BadRequestError("delegateMention target must belong to the same organization as the agent");
  }
}

/**
 * Service-layer guard: `delegateMention` is only available for `human` agents.
 * Mirrors the Web UI in `identity-section.tsx`, which only renders the
 * delegate-mention selector when `agent.type === "human"`. Without this
 * server-side check, CLI / Admin API / internal scripts could write
 * delegateMention onto non-human rows, silently re-enabling the
 * autonomous-agent-self-mention path that resolveGithubAudience would then fan
 * out. Called from `createAgent` / `updateAgent` before
 * `validateDelegateMentionTarget` so a wrong source type fails fast without
 * the target lookup round-trip.
 */
function assertDelegateMentionAllowed(sourceType: string): void {
  // Accepts `string` (not `AgentType`) because callers may forward the
  // value from an `agents` row, whose `type` column is declared as `text`
  // and therefore narrows to `string` after Drizzle inference. The guard
  // only checks one bit — is it `human` — so widening the parameter is
  // safe and avoids forcing an unsound `as AgentType` cast at the caller.
  if (sourceType !== AGENT_TYPES.HUMAN) {
    throw new BadRequestError("delegateMention can only be set on human agents");
  }
}

function assertNonHumanLifecycleTarget(agent: { type: string }): void {
  if (agent.type === AGENT_TYPES.HUMAN) {
    throw new BadRequestError("Human agent lifecycle is managed by member leave/remove/restore.");
  }
}

/**
 * Pick the first admin member in the org for internal system agents. Throws
 * if the org has no admin — the caller should surface the error so an admin
 * is created before the system tries to register more agents.
 */
async function resolveFallbackManagerId(db: Database, orgId: string): Promise<string> {
  const [row] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, orgId), eq(members.role, "admin"), eq(members.status, "active")))
    .orderBy(members.createdAt)
    .limit(1);
  if (!row) {
    throw new BadRequestError(
      `Cannot create agent in organization "${orgId}" — no admin member exists. ` +
        `Create an admin member first (see \`${getServerCliBinding().binName} agent create\`).`,
    );
  }
  return row.id;
}

export async function createAgent(
  db: Database,
  data: CreateAgent & { managerId?: string },
  options: {
    force?: boolean;
    adoptAsDelegateIfFirst?: boolean;
    provisioningAudit?: {
      actingAgentId: string;
      managingMemberId: string;
      chatId: string | null;
    };
  } = {},
) {
  const uuid = uuidv7();
  const name = data.name ?? null;
  const runtimeProvider: RuntimeProvider = data.runtimeProvider ?? DEFAULT_RUNTIME_PROVIDER;
  assertUserAgentMetadataHasNoReservedKeys(data.metadata);
  if (name?.startsWith(RESERVED_AGENT_NAME_PREFIX)) {
    throw new BadRequestError(
      `Agent name "${name}" is reserved — names starting with "${RESERVED_AGENT_NAME_PREFIX}" are First Tree-internal`,
    );
  }
  if (name && isReservedAgentName(name)) {
    throw new BadRequestError(`Agent name "${name}" is reserved — pick a different one.`);
  }
  const inboxId = `inbox_${uuid}`;

  // Resolve orgId + managerId with a strict "manager owns the org" contract.
  //
  // Three branches:
  //
  //   1. Admin API / onboard — caller passes `managerId` only. We look up the
  //      member and derive `orgId` from their `organization_id`. This is the
  //      M1 fix: previously, when the Web UI POSTed without `organizationId`,
  //      we silently fell back to the `default` org, stranding agents in the
  //      wrong tenant.
  //
  //   2. Bootstrap (services/member.ts::createMember, test helpers) — caller
  //      passes BOTH `managerId` and `organizationId` inside the same
  //      transaction where the member row is being inserted right after the
  //      agent. The member doesn't exist yet in this tx, so a members lookup
  //      would fail. We trust the caller and skip the lookup; DB FK still
  //      enforces the manager_id at commit time.
  //
  //   3. System path (github webhook) — caller omits `managerId` and passes
  //      `organizationId` explicitly. We resolve the first admin of that
  //      org as the manager.
  let orgId: string;
  let managerId: string;

  if (data.managerId && data.organizationId) {
    // Branch 2: explicit pair. If the manager row already exists, validate it
    // like the public API path; if it does not, this is the member bootstrap
    // path that inserts the human agent before inserting the member row in the
    // same transaction, so the deferred FK validates it at commit time.
    const [manager] = await db
      .select({ id: members.id, organizationId: members.organizationId, status: members.status })
      .from(members)
      .where(eq(members.id, data.managerId))
      .limit(1);
    if (!manager && data.type !== AGENT_TYPES.HUMAN) {
      throw new BadRequestError(`Manager "${data.managerId}" not found`);
    }
    if (manager) {
      if (manager.status !== "active") {
        throw new BadRequestError(`Manager "${data.managerId}" not found`);
      }
      if (manager.organizationId !== data.organizationId) {
        throw new BadRequestError("Manager must belong to the same organization as the agent");
      }
    }
    orgId = data.organizationId;
    managerId = data.managerId;
  } else if (data.managerId) {
    // Branch 1: derive orgId from the manager's member row.
    const [manager] = await db
      .select({ id: members.id, organizationId: members.organizationId })
      .from(members)
      .where(and(eq(members.id, data.managerId), eq(members.status, "active")))
      .limit(1);
    if (!manager) {
      throw new BadRequestError(`Manager "${data.managerId}" not found`);
    }
    orgId = manager.organizationId;
    managerId = manager.id;
  } else {
    // Branch 3: fall back to explicit org (or legacy default org) + its first
    // admin as the manager.
    orgId = data.organizationId ?? (await resolveDefaultOrgId(db));
    managerId = await resolveFallbackManagerId(db, orgId);
  }

  const clientId = await resolveAgentClient(db, {
    clientId: data.clientId,
    managerId,
    type: data.type,
  });

  await ensureClientSupportsRuntimeProvider(db, clientId, runtimeProvider, { force: options.force });

  if (data.delegateMention) {
    assertDelegateMentionAllowed(data.type);
    await validateDelegateMentionTarget(db, data.delegateMention, orgId);
  }

  // Phase 2 of the agent-naming refactor promoted `display_name` to NOT NULL
  // and standardized the fallback here so every surface (CLI, server logs,
  // IM bridge, chat roster) sees a populated label without the web-only
  // `useAgentNameMap` cascade. Precedence: explicit non-empty displayName →
  // the agent name → a generic "Unnamed Agent" literal (only reached when
  // the caller omitted both fields, which only happens for bootstrap /
  // system-created agents).
  const resolvedDisplayName = data.displayName?.trim() || name || "Unnamed Agent";

  try {
    // Wrap both inserts in a transaction so the agent row is never visible
    // without its companion `agent_configs` row.
    const agent = await db.transaction(async (tx) => {
      // Serialize the quota decision with the insert. Without the org-row
      // lock, concurrent agent creates can all observe the same count.
      const [org] = await tx
        .select({ maxAgents: organizations.maxAgents })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .for("update")
        .limit(1);
      if (org && org.maxAgents > 0) {
        const rows = await tx
          .select({ value: count() })
          .from(agents)
          .where(and(eq(agents.organizationId, orgId), ne(agents.status, AGENT_STATUSES.DELETED)));
        const activeCount = rows[0]?.value ?? 0;
        if (activeCount >= org.maxAgents) {
          throw new ForbiddenError(
            `Organization "${orgId}" has reached its agent limit (${org.maxAgents}). Upgrade your plan or delete unused agents.`,
          );
        }
      }

      // Close the leave/remove race for non-human agents: lock the manager's
      // member row and re-confirm it is still active inside the same
      // transaction that inserts the agent. `deactivateMembership` (leave) and
      // `deleteMember` (admin removal) both lock the departing member
      // `FOR UPDATE` before scanning and reassigning the agents it manages, so
      // taking the same lock here makes the two paths mutually exclusive: a
      // create that began while the member was still active either (a) commits
      // first, so the departure's scan sees this agent and reassigns/unpins it,
      // or (b) blocks until the departure commits and then sees the member is no
      // longer active and aborts — instead of stranding a freshly-created agent
      // on a left/removed manager (which would re-create the pinned-and-orphaned
      // state issue #1353 fixes). Human mirrors are skipped: they are created in
      // the member-bootstrap transaction before the member row exists, so there
      // is nothing to lock and the deferred FK validates them at commit.
      if (data.type !== AGENT_TYPES.HUMAN) {
        const [stillActive] = await tx
          .select({ id: members.id, userId: members.userId })
          .from(members)
          .where(and(eq(members.id, managerId), eq(members.status, "active")))
          .for("update")
          .limit(1);
        if (!stillActive) {
          throw new BadRequestError(`Manager "${managerId}" not found`);
        }
        if (clientId) {
          const [runtimeClient] = await tx
            .select({ userId: clients.userId, retiredAt: clients.retiredAt })
            .from(clients)
            .where(eq(clients.id, clientId))
            .for("update")
            .limit(1);
          if (!runtimeClient) {
            throw new BadRequestError(`Client "${clientId}" not found`);
          }
          if (runtimeClient.userId !== stillActive.userId) {
            throw new ForbiddenError(`Client "${clientId}" is not owned by the manager's user`);
          }
          if (runtimeClient.retiredAt) {
            throw new ClientRetiredError(`Client "${clientId}" has been retired`);
          }
        }
      }

      const [row] = await tx
        .insert(agents)
        .values({
          uuid,
          name,
          organizationId: orgId,
          type: data.type,
          displayName: resolvedDisplayName,
          delegateMention: data.delegateMention ?? null,
          inboxId,
          source: data.source ?? null,
          visibility: data.visibility ?? defaultVisibility(data.type),
          metadata: data.metadata ?? {},
          managerId,
          clientId,
          runtimeProvider,
        })
        .returning();

      if (!row) throw new Error("Unexpected: INSERT RETURNING produced no row");

      const initialPayload = {
        ...defaultRuntimeConfigPayload(runtimeProvider),
        ...(data.model ? { model: data.model } : {}),
      };
      await tx
        .insert(agentConfigs)
        .values({
          agentId: row.uuid,
          version: 1,
          payload: initialPayload,
          updatedBy: "system",
        })
        .onConflictDoNothing();

      if (options.provisioningAudit) {
        await tx.insert(agentProvisioningAudit).values({
          id: uuidv7(),
          organizationId: orgId,
          actingAgentId: options.provisioningAudit.actingAgentId,
          managingMemberId: options.provisioningAudit.managingMemberId,
          createdAgentId: row.uuid,
          chatId: options.provisioningAudit.chatId,
        });
      }

      // First-agent → delegate adoption. When a member creates their FIRST
      // non-human agent and hasn't picked a delegate yet, adopt it as their
      // delegate (`delegateMention` on their human agent) so it becomes the
      // new-chat default recipient and the GitHub @mention forward target
      // without a manual trip to the profile editor. Runs inside this
      // transaction so the delegate is set atomically with the agent insert.
      // Guards keep it safe and unsurprising:
      //   - SELF-CREATED ONLY. `delegateMention` is a personal choice the
      //     self-only API guard reserves to the member (an admin PATCHing
      //     another member's delegate is rejected). The org agent route lets an
      //     admin create an agent FOR another member, so gating on a resolved
      //     managerId alone would let create-for-Bob silently set Bob's
      //     delegate — the same write the PATCH guard forbids. The caller is
      //     the only one who knows "this is my own create", so the route passes
      //     `adoptAsDelegateIfFirst` true only when `managerId === scope.memberId`.
      //     Every non-self path (admin-for-other, member bootstrap, system /
      //     webhook) omits it and never triggers adoption.
      //   - FIRST agent only — the just-inserted row makes the count 1, so a
      //     2nd agent never steals the delegate.
      //   - ONLY-IF-UNSET, atomically — the final UPDATE carries
      //     `delegateMention IS NULL` in its WHERE, so two concurrent
      //     first-creates can't both win on a stale read; the second's write
      //     no-ops instead of clobbering the first. Never overwrites a
      //     deliberate choice either.
      // The agent stays whatever visibility it was created with (private by
      // default); the picker and webhook routing both accept a private
      // delegate, so no visibility change is forced. Reversible: the member
      // can re-point or clear it anytime.
      if (options.adoptAsDelegateIfFirst && data.type === AGENT_TYPES.AGENT) {
        const [manager] = await tx
          .select({ humanAgentId: members.agentId })
          .from(members)
          .where(eq(members.id, managerId))
          .limit(1);
        if (manager) {
          const [human] = await tx
            .select({ uuid: agents.uuid, delegateMention: agents.delegateMention, type: agents.type })
            .from(agents)
            .where(eq(agents.uuid, manager.humanAgentId))
            .limit(1);
          if (human && human.type === AGENT_TYPES.HUMAN && !human.delegateMention) {
            const [tally] = await tx
              .select({ value: count() })
              .from(agents)
              .where(
                and(
                  eq(agents.managerId, managerId),
                  eq(agents.type, AGENT_TYPES.AGENT),
                  ne(agents.status, AGENT_STATUSES.DELETED),
                ),
              );
            if ((tally?.value ?? 0) === 1) {
              await tx
                .update(agents)
                .set({ delegateMention: row.uuid })
                .where(and(eq(agents.uuid, human.uuid), isNull(agents.delegateMention)));
            }
          }
        }
      }

      return row;
    });

    return agent;
  } catch (err) {
    const pgCode = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "";
    if (pgCode === "23505" && name) {
      throw new ConflictError(`Agent name "${name}" already exists in organization "${orgId}"`);
    }
    throw err;
  }
}

/**
 * Result of a pre-create agent-name availability probe used by the web
 * creation form. The server is authoritative (the POST still validates);
 * this endpoint only trades one DB lookup for a better UX so the user sees
 * "taken" / "reserved" inline while typing instead of after submit.
 *
 * Possible `reason` values:
 *   - `invalid`  — fails `AGENT_NAME_REGEX` (not a well-formed slug)
 *   - `reserved` — matches `__` prefix or `RESERVED_AGENT_NAMES`
 *   - `taken`    — an active or suspended agent already owns the name in this org
 *
 * `available: true` is returned only if none of the above applies. Deleted
 * rows have their `name` nulled in the `deleteAgent` service so the name
 * is recyclable without a tombstone check here.
 */
export type AgentNameAvailability =
  | { available: true }
  | { available: false; reason: "invalid" | "reserved" | "taken" };

export async function checkAgentNameAvailability(
  db: Database,
  orgId: string,
  name: string,
): Promise<AgentNameAvailability> {
  if (!AGENT_NAME_REGEX.test(name)) {
    return { available: false, reason: "invalid" };
  }
  if (isReservedAgentName(name) || name.startsWith(RESERVED_AGENT_NAME_PREFIX)) {
    return { available: false, reason: "reserved" };
  }
  const [existing] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(eq(agents.organizationId, orgId), eq(agents.name, name), ne(agents.status, AGENT_STATUSES.DELETED)))
    .limit(1);
  return existing ? { available: false, reason: "taken" } : { available: true };
}

/**
 * Reusable projection for single-agent reads + mutation responses: every
 * column on `agents` plus `agent_presence.runtimeState` (the M1+ authority
 * for "is this agent running"; NULL when the agent has no presence row
 * yet, i.e. never bound a runtime client).
 *
 * Threading this through `getAgent`, `requireAgentAccess`, and every
 * mutation service is what keeps `runtimeState` on the wire across all
 * single-agent endpoints — see PR #571 review: the previous shape lost
 * the field on `GET /:uuid` and every PATCH/suspend/reactivate
 * response, which made management surfaces (Team / Settings) read a
 * fictitious "offline" state.
 *
 * Returns `null` when no row exists (the caller decides whether that's a
 * 404 or an internal invariant violation post-update).
 */
export async function selectAgentRowWithRuntime(db: SelectDbLike, uuid: string): Promise<AgentRowWithRuntime | null> {
  const [row] = await db
    .select({
      ...getTableColumns(agents),
      runtimeState: agentPresence.runtimeState,
    })
    .from(agents)
    .leftJoin(agentPresence, eq(agents.uuid, agentPresence.agentId))
    .where(eq(agents.uuid, uuid))
    .limit(1);
  return row ?? null;
}

export type AgentRowWithRuntime = typeof agents.$inferSelect & { runtimeState: string | null };

export async function getAgent(db: Database, uuid: string): Promise<AgentRowWithRuntime> {
  const agent = await selectAgentRowWithRuntime(db, uuid);
  if (!agent || agent.status === AGENT_STATUSES.DELETED) {
    throw new NotFoundError(`Agent "${uuid}" not found`);
  }
  return agent;
}

export async function setAgentProvisioningCapability(db: Database, uuid: string, enabled: boolean) {
  const existing = await getAgent(db, uuid);
  if (existing.type !== AGENT_TYPES.AGENT) {
    throw new BadRequestError("Provisioning capability can only be granted to non-human agents");
  }
  const [updated] = await db
    .update(agents)
    .set({ canProvisionAgents: enabled, updatedAt: new Date() })
    .where(and(eq(agents.uuid, uuid), ne(agents.status, AGENT_STATUSES.DELETED)))
    .returning();
  if (!updated) throw new NotFoundError(`Agent "${uuid}" not found`);
  return updated;
}

export async function getAgentByName(db: Database, orgId: string, name: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.organizationId, orgId), eq(agents.name, name), ne(agents.status, AGENT_STATUSES.DELETED)))
    .limit(1);
  if (!agent) {
    throw new NotFoundError(`Agent "${name}" not found in organization "${orgId}"`);
  }
  return agent;
}

export async function listAgents(db: Database, orgId: string, limit: number, cursor?: string, type?: string) {
  const conditions = [ne(agents.status, AGENT_STATUSES.DELETED), eq(agents.organizationId, orgId)];
  if (cursor) conditions.push(lt(agents.createdAt, new Date(cursor)));
  if (type) conditions.push(eq(agents.type, type));
  const where = and(...conditions);

  const rows = await db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      organizationId: agents.organizationId,
      type: agents.type,
      displayName: agents.displayName,
      delegateMention: agents.delegateMention,
      inboxId: agents.inboxId,
      status: agents.status,
      visibility: agents.visibility,
      metadata: agents.metadata,
      managerId: agents.managerId,
      clientId: agents.clientId,
      runtimeProvider: agents.runtimeProvider,
      avatarColorToken: agents.avatarColorToken,
      avatarImageUpdatedAt: agents.avatarImageUpdatedAt,
      // Backing user's external avatar URL (e.g. GitHub) — populated only for
      // human agents through the 1:1 members.agent_id link; null otherwise.
      // Used by `resolveAvatarImageUrl` as the fallback when no avatar has
      // been uploaded for this human agent.
      userAvatarUrl: users.avatarUrl,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
      presenceStatus: agentPresence.status,
      // M1 runtime columns are still materialised on agent_presence. `clientId`
      // comes from the authoritative agents table (the pinned client).
      runtimeType: agentPresence.runtimeType,
      runtimeState: agentPresence.runtimeState,
      activeSessions: agentPresence.activeSessions,
      lastSeenAt: agentPresence.lastSeenAt,
    })
    .from(agents)
    .leftJoin(agentPresence, eq(agents.uuid, agentPresence.agentId))
    .leftJoin(members, eq(members.agentId, agents.uuid))
    .leftJoin(users, eq(users.id, members.userId))
    .where(where)
    .orderBy(desc(agents.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

  return { items, nextCursor };
}

/**
 * Admin-only variant: return every non-deleted agent in the org, ignoring
 * the visibility filter. Used by the `/admin` "All Agents" view so a team
 * admin can see and act on private agents owned by other members. The
 * route layer is responsible for gating this to admin callers — the
 * service does not enforce role by itself, but it does enforce org scope
 * and the not-deleted predicate.
 */
export async function listAgentsForAdmin(db: Database, scope: OrgScope, limit: number, cursor?: string) {
  const conditions = [eq(agents.organizationId, scope.organizationId), ne(agents.status, AGENT_STATUSES.DELETED)];
  if (cursor) conditions.push(lt(agents.createdAt, new Date(cursor)));
  const where = and(...conditions);

  const rows = await db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      organizationId: agents.organizationId,
      type: agents.type,
      displayName: agents.displayName,
      delegateMention: agents.delegateMention,
      inboxId: agents.inboxId,
      status: agents.status,
      visibility: agents.visibility,
      metadata: agents.metadata,
      managerId: agents.managerId,
      clientId: agents.clientId,
      runtimeProvider: agents.runtimeProvider,
      avatarColorToken: agents.avatarColorToken,
      avatarImageUpdatedAt: agents.avatarImageUpdatedAt,
      userAvatarUrl: users.avatarUrl,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
      presenceStatus: agentPresence.status,
      runtimeType: agentPresence.runtimeType,
      runtimeState: agentPresence.runtimeState,
      activeSessions: agentPresence.activeSessions,
      lastSeenAt: agentPresence.lastSeenAt,
    })
    .from(agents)
    .leftJoin(agentPresence, eq(agents.uuid, agentPresence.agentId))
    .leftJoin(members, eq(members.agentId, agents.uuid))
    .leftJoin(users, eq(users.id, members.userId))
    .where(where)
    .orderBy(desc(agents.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

  return { items, nextCursor };
}

/**
 * List agents visible to a specific member.
 * Uses agentVisibilityCondition from access-control (same rules for all roles).
 *
 * `query`, when set, narrows the result set to rows whose `name` or
 * `displayName` matches the term as a case-insensitive substring. Used by
 * the web participant picker so orgs above the `limit` cap (100) can still
 * surface agents past the first page (issue 494). The visibility predicate
 * still wraps the search, so private agents owned by other members never
 * leak through a `?query=` lookup.
 */
export async function listAgentsForMember(
  db: Database,
  scope: OrgScope,
  limit: number,
  cursor?: string,
  type?: string,
  query?: string,
  addressableOnly = false,
) {
  // agentVisibilityCondition already includes org + status + visibility filtering
  const conditions = [agentVisibilityCondition(scope.organizationId, scope.memberId)];
  if (addressableOnly) conditions.push(agentAddressableCondition());
  if (cursor) conditions.push(lt(agents.createdAt, new Date(cursor)));
  if (type) conditions.push(eq(agents.type, type));
  if (query) {
    // Whitespace-split into AND-of-keyword matches: each token must appear
    // as a substring in `name` OR `displayName`. Lets a user search
    // "Picker 110" and reach `picker-agent-110` (the literal substring
    // "Picker 110" doesn't appear in either field, but each token alone
    // does). Single-token input behaves identically to the prior contains
    // semantics.
    //
    // Drizzle escapes the bound value, but we still need to neutralise the
    // ILIKE wildcards (`%`, `_`) inside the user-supplied substring so a
    // search for "10%_off" matches that literal text instead of acting as
    // a wildcard pattern.
    //
    // Performance: each token compiles to two leading-wildcard `ILIKE`
    // predicates, which Postgres can't use a btree index for and always
    // run as a sequential scan over the visibility-filtered subset. Fine
    // for the few-thousand-agents-per-org orders of magnitude we live in
    // today; if a single org grows past ~50k agents and the picker latency
    // starts biting, the right next step is `pg_trgm` + a GIN index on
    // both columns (`USING gin (name gin_trgm_ops)` + likewise on
    // `display_name`). That belongs in a follow-up — not worth the
    // extension dependency until the measured pain shows up.
    for (const token of query.split(/\s+/).filter((t) => t.length > 0)) {
      const escaped = token.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      const pattern = `%${escaped}%`;
      const match = or(ilike(agents.name, pattern), ilike(agents.displayName, pattern));
      if (match) conditions.push(match);
    }
  }

  const where = and(...conditions);

  const rows = await db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      organizationId: agents.organizationId,
      type: agents.type,
      displayName: agents.displayName,
      delegateMention: agents.delegateMention,
      inboxId: agents.inboxId,
      status: agents.status,
      visibility: agents.visibility,
      metadata: agents.metadata,
      managerId: agents.managerId,
      clientId: agents.clientId,
      runtimeProvider: agents.runtimeProvider,
      avatarColorToken: agents.avatarColorToken,
      avatarImageUpdatedAt: agents.avatarImageUpdatedAt,
      userAvatarUrl: users.avatarUrl,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
      presenceStatus: agentPresence.status,
      runtimeType: agentPresence.runtimeType,
      runtimeState: agentPresence.runtimeState,
      activeSessions: agentPresence.activeSessions,
      lastSeenAt: agentPresence.lastSeenAt,
    })
    .from(agents)
    .leftJoin(agentPresence, eq(agents.uuid, agentPresence.agentId))
    .leftJoin(members, eq(members.agentId, agents.uuid))
    .leftJoin(users, eq(users.id, members.userId))
    .where(where)
    .orderBy(desc(agents.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

  return { items, nextCursor };
}

export async function getNewChatDefaultCandidate(
  db: Database,
  scope: OrgScope,
  cachedAgentId: string | null | undefined,
): Promise<{
  agent: NewChatDefaultCandidateAgent | null;
}> {
  const projection = {
    uuid: agents.uuid,
    name: agents.name,
    displayName: agents.displayName,
    type: agents.type,
    status: agents.status,
    managerId: agents.managerId,
    createdAt: agents.createdAt,
  };

  if (cachedAgentId && cachedAgentId !== scope.humanAgentId) {
    const [cachedAgent] = await db
      .select(projection)
      .from(agents)
      .leftJoin(members, eq(members.agentId, agents.uuid))
      .where(
        and(
          eq(agents.uuid, cachedAgentId),
          eq(agents.type, AGENT_TYPES.AGENT),
          agentVisibilityCondition(scope.organizationId, scope.memberId),
          agentAddressableCondition(),
        ),
      )
      .limit(1);
    if (cachedAgent) return { agent: cachedAgent };
  }

  const [ownedFallback] = await db
    .select(projection)
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, scope.organizationId),
        eq(agents.managerId, scope.memberId),
        eq(agents.type, AGENT_TYPES.AGENT),
        eq(agents.status, AGENT_STATUSES.ACTIVE),
        agentNotLandingCampaignTrialCondition(),
      ),
    )
    .orderBy(asc(agents.createdAt))
    .limit(1);
  if (ownedFallback) return { agent: ownedFallback };

  const [orgFallback] = await db
    .select(projection)
    .from(agents)
    .leftJoin(members, eq(members.agentId, agents.uuid))
    .where(
      and(
        eq(agents.type, AGENT_TYPES.AGENT),
        agentVisibilityCondition(scope.organizationId, scope.memberId),
        agentAddressableCondition(),
      ),
    )
    .orderBy(asc(agents.createdAt))
    .limit(1);

  return { agent: orgFallback ?? null };
}

export async function updateAgent(db: Database, uuid: string, data: UpdateAgent) {
  const agent = await getAgent(db, uuid);

  // `clientId` is one-shot via this generic PATCH entry: NULL → ID is allowed
  // (admin claiming an unbound agent for a known client). Once bound, direct
  // ID → null and ID → another ID updates are rejected; runtime moves must go
  // through the managed switch-runtime flow so sessions and local slots converge.
  if (data.clientId !== undefined) {
    if (data.clientId === null) {
      throw new BadRequestError("clientId cannot be cleared — once bound, an agent stays bound to its client");
    }
    if (agent.clientId === null && agent.status === AGENT_STATUSES.SUSPENDED) {
      throw new BadRequestError("Suspended agents without a runtime route must be recovered through runtime switch.");
    }
    if (agent.clientId !== null && agent.clientId !== data.clientId) {
      throw new BadRequestError(
        "clientId cannot be changed through PATCH once set — use the managed runtime switch flow instead.",
      );
    }
  }

  const updates: Partial<typeof agents.$inferInsert> = { updatedAt: new Date() };
  if (data.type !== undefined) {
    throw new BadRequestError("Agent type is immutable");
  }
  if (data.displayName !== undefined) updates.displayName = data.displayName;
  if (data.delegateMention !== undefined) {
    if (data.delegateMention !== null) {
      assertDelegateMentionAllowed(agent.type);
      await validateDelegateMentionTarget(db, data.delegateMention, agent.organizationId);
    }
    updates.delegateMention = data.delegateMention;
  }
  if (data.visibility !== undefined) updates.visibility = data.visibility;
  if (data.metadata !== undefined) {
    assertUserAgentMetadataHasNoReservedKeys(data.metadata);
    (updates as Record<string, unknown>).metadata = agentMetadataUpdateExpressionPreservingRuntimeState(data.metadata);
  }
  // Explicit null clears the override (renderer falls back to djb2 hash).
  // Omitting the field leaves the column untouched.
  if (data.avatarColorToken !== undefined) updates.avatarColorToken = data.avatarColorToken;

  let newManagerId: string | undefined;
  if (data.managerId !== undefined) {
    if (data.managerId === null) {
      throw new BadRequestError("managerId cannot be cleared — every agent must have a manager");
    }
    const [manager] = await db
      .select({ id: members.id, organizationId: members.organizationId })
      .from(members)
      .where(and(eq(members.id, data.managerId), eq(members.status, "active")))
      .limit(1);
    if (!manager) {
      throw new BadRequestError(`Manager "${data.managerId}" not found`);
    }
    if (manager.organizationId !== agent.organizationId) {
      throw new BadRequestError("Manager must belong to the same organization as the agent");
    }
    updates.managerId = data.managerId;
    newManagerId = data.managerId;
  }

  const reassigningManager = newManagerId !== undefined && newManagerId !== agent.managerId;
  // First-set clientId (NULL → ID): with re-bind removed, this first bind is the
  // ONLY path an unbound agent gets a computer. Its ownership is validated
  // against the manager (reused from createAgent), and it must run the
  // runtime-provider capability gate. Both the resolution and the write happen
  // under lock inside the mutation transaction below so they are departure-safe.
  // `undefined` means "not a first-bind"; a non-null id means "bind to this".
  const bindClientId =
    data.clientId !== undefined && data.clientId !== null && agent.clientId === null ? data.clientId : undefined;
  // The membership whose active state gates this write: the new manager when
  // reassigning, otherwise the agent's current manager (whose user must own the
  // client a first-bind pins to).
  const gatingManagerId = reassigningManager && newManagerId !== undefined ? newManagerId : agent.managerId;

  await db.transaction(async (tx) => {
    // Close the reassignment/leave and first-bind/leave races. When this update
    // reassigns the manager or first-binds a client, lock the gating member row
    // FOR UPDATE and re-confirm it is active — in the SAME member→agent lock
    // order `deactivateMembership` (leave) and `deleteMember` (admin removal)
    // use (member row first, then the agent rows they scan/transfer), so the
    // paths serialize without deadlocking. A departure of the gating member is
    // then mutually exclusive with this write: it either commits first (and the
    // departure's scan transfers/unpins the agent) or blocks until the departure
    // commits and aborts here on the now-inactive manager. This prevents both a
    // reassignment landing on a departed member and a stale first-bind re-pinning
    // the departed owner's client onto an agent leave just transferred + unpinned
    // (which would revive the retireClient deadlock issue #1353 removes).
    if (reassigningManager || bindClientId !== undefined) {
      const [activeManager] = await tx
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.id, gatingManagerId), eq(members.status, "active")))
        .for("update")
        .limit(1);
      if (!activeManager) {
        throw new BadRequestError(`Manager "${gatingManagerId}" not found`);
      }
    }

    if (bindClientId !== undefined) {
      const resolvedClientId = await resolveAgentClient(tx, {
        clientId: bindClientId,
        managerId: gatingManagerId,
        type: agent.type,
      });
      if (resolvedClientId !== null) {
        // `agents.runtime_provider` is a text column (typed `string`); narrow it
        // back to the RuntimeProvider union before the capability check.
        await ensureClientSupportsRuntimeProvider(
          tx,
          resolvedClientId,
          runtimeProviderSchema.parse(agent.runtimeProvider),
        );
        updates.clientId = resolvedClientId;
      }
    }

    const [row] = await tx.update(agents).set(updates).where(eq(agents.uuid, agent.uuid)).returning();
    if (!row) throw new Error("Unexpected: UPDATE RETURNING produced no row");

    // If the manager was reassigned, watcher rows anchored on the old manager
    // need to drop and the new manager's rows need to appear. Recompute is
    // keyed by agent (not chat) since this single agent may participate in many
    // chats. Inside the transaction so the manager change and its watcher
    // fan-out commit atomically.
    if (reassigningManager) {
      await recomputeWatchersForAgent(tx, agent.uuid);
    }
    return row;
  });
  // Re-fetch via the unified projection so the wire response carries
  // `runtimeState` like every other single-agent endpoint.
  const refreshed = await selectAgentRowWithRuntime(db, agent.uuid);
  if (!refreshed) throw new Error("Unexpected: agent disappeared after UPDATE");
  return refreshed;
}

/**
 * Reactivate a suspended agent.
 */
export async function reactivateAgent(db: Database, uuid: string) {
  const [existing] = await db
    .select({ uuid: agents.uuid, status: agents.status, type: agents.type, clientId: agents.clientId })
    .from(agents)
    .where(eq(agents.uuid, uuid))
    .limit(1);
  if (!existing || existing.status === AGENT_STATUSES.DELETED) {
    throw new NotFoundError(`Agent "${uuid}" not found`);
  }
  assertNonHumanLifecycleTarget(existing);
  if (existing.status !== AGENT_STATUSES.SUSPENDED) {
    throw new BadRequestError("Only suspended agents can be reactivated.");
  }
  if (existing.clientId === null) {
    throw new BadRequestError("Suspended agents without a runtime route must be recovered through runtime switch.");
  }

  const [agent] = await db
    .update(agents)
    .set({ status: AGENT_STATUSES.ACTIVE, updatedAt: new Date() })
    .where(eq(agents.uuid, uuid))
    .returning();

  if (!agent) throw new Error("Unexpected: UPDATE RETURNING produced no row");
  const refreshed = await selectAgentRowWithRuntime(db, uuid);
  if (!refreshed) throw new Error("Unexpected: agent disappeared after UPDATE");
  return refreshed;
}

/**
 * Suspend an agent. Once suspended, Rule R-RUN refuses every runtime bind
 * and every agent-selector-authorised HTTP call.
 */
export async function suspendAgent(db: Database, uuid: string) {
  const [existing] = await db
    .select({ uuid: agents.uuid, status: agents.status, type: agents.type })
    .from(agents)
    .where(eq(agents.uuid, uuid))
    .limit(1);

  if (!existing || existing.status === AGENT_STATUSES.DELETED) {
    throw new NotFoundError(`Agent "${uuid}" not found`);
  }
  assertNonHumanLifecycleTarget(existing);

  await db.update(agents).set({ status: AGENT_STATUSES.SUSPENDED, updatedAt: new Date() }).where(eq(agents.uuid, uuid));

  const refreshed = await selectAgentRowWithRuntime(db, uuid);
  if (!refreshed) throw new Error("Unexpected: agent disappeared after UPDATE");
  return refreshed;
}

/**
 * Delete an agent. Only allowed when status is "suspended". Sets name to NULL
 * so the name becomes reusable.
 */
export async function deleteAgent(db: Database, uuid: string) {
  const [existing] = await db
    .select({ uuid: agents.uuid, status: agents.status, type: agents.type })
    .from(agents)
    .where(eq(agents.uuid, uuid))
    .limit(1);
  if (!existing || existing.status === AGENT_STATUSES.DELETED) {
    throw new NotFoundError(`Agent "${uuid}" not found`);
  }
  assertNonHumanLifecycleTarget(existing);
  if (existing.status !== AGENT_STATUSES.SUSPENDED) {
    throw new BadRequestError("Only suspended agents can be deleted. Suspend the agent first.");
  }

  const [agent] = await db
    .update(agents)
    .set({ status: AGENT_STATUSES.DELETED, name: null, updatedAt: new Date() })
    .where(eq(agents.uuid, uuid))
    .returning();

  if (!agent) throw new Error("Unexpected: UPDATE RETURNING produced no row");
  return agent;
}

/**
 * Supported avatar-image MIME types. The web client always uploads WEBP after
 * its own resize step; we accept PNG/JPEG too so a caller using the raw HTTP
 * API (curl, scripts) doesn't have to re-encode. Anything else is rejected at
 * the boundary — we never store an unknown content type.
 */
export const SUPPORTED_AVATAR_IMAGE_MIMES = ["image/webp", "image/png", "image/jpeg"] as const;
export type SupportedAvatarImageMime = (typeof SUPPORTED_AVATAR_IMAGE_MIMES)[number];

/** Hard server-side ceiling for the stored bytea blob. Client pre-resizes to ~50KB. */
export const MAX_AVATAR_IMAGE_BYTES = 512 * 1024;

function isSupportedAvatarMime(mime: string): mime is SupportedAvatarImageMime {
  return SUPPORTED_AVATAR_IMAGE_MIMES.find((m) => m === mime) !== undefined;
}

/**
 * Fetch the avatar image blob for an agent. Returns `null` when no image
 * is set (the column is NULL). The data + mime pair is always coherent
 * (set/cleared together by the service writes below).
 */
export async function getAgentAvatarImage(
  db: Database,
  uuid: string,
): Promise<{ data: Buffer; mime: string; updatedAt: Date } | null> {
  const [row] = await db
    .select({
      data: agents.avatarImageData,
      mime: agents.avatarImageMime,
      updatedAt: agents.avatarImageUpdatedAt,
    })
    .from(agents)
    .where(and(eq(agents.uuid, uuid), ne(agents.status, AGENT_STATUSES.DELETED)))
    .limit(1);
  if (!row || !row.data || !row.mime || !row.updatedAt) return null;
  return { data: row.data, mime: row.mime, updatedAt: row.updatedAt };
}

/** Replace (or set) an agent's avatar image. Validates mime + size. */
export async function setAgentAvatarImage(db: Database, uuid: string, data: Buffer, mime: string): Promise<Date> {
  if (!isSupportedAvatarMime(mime)) {
    throw new BadRequestError(`Unsupported avatar image type "${mime}". Use PNG, JPEG, or WEBP.`);
  }
  if (data.length === 0) {
    throw new BadRequestError("Avatar image payload is empty.");
  }
  if (data.length > MAX_AVATAR_IMAGE_BYTES) {
    throw new BadRequestError(`Avatar image is too large (${data.length} bytes; max ${MAX_AVATAR_IMAGE_BYTES}).`);
  }
  const now = new Date();
  const result = await db
    .update(agents)
    .set({
      avatarImageData: data,
      avatarImageMime: mime,
      avatarImageUpdatedAt: now,
      updatedAt: now,
    })
    .where(and(eq(agents.uuid, uuid), ne(agents.status, AGENT_STATUSES.DELETED)))
    .returning({ uuid: agents.uuid });
  if (result.length === 0) {
    throw new NotFoundError(`Agent "${uuid}" not found`);
  }
  return now;
}

/** Clear an agent's avatar image (falls back to color + initial). */
export async function clearAgentAvatarImage(db: Database, uuid: string): Promise<void> {
  const result = await db
    .update(agents)
    .set({
      avatarImageData: null,
      avatarImageMime: null,
      avatarImageUpdatedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(agents.uuid, uuid), ne(agents.status, AGENT_STATUSES.DELETED)))
    .returning({ uuid: agents.uuid });
  if (result.length === 0) {
    throw new NotFoundError(`Agent "${uuid}" not found`);
  }
}

/**
 * Read the agent-reported slash-command skill list. Returns `[]` for agents
 * whose daemon has not uploaded yet — the column is `NOT NULL DEFAULT '[]'`
 * so this is a fast row read with no conditional logic.
 */
export async function getAgentSkills(db: Database, uuid: string): Promise<AgentSkills> {
  const [row] = await db
    .select({ skills: agents.skills })
    .from(agents)
    .where(and(eq(agents.uuid, uuid), ne(agents.status, AGENT_STATUSES.DELETED)))
    .limit(1);
  if (!row) {
    throw new NotFoundError(`Agent "${uuid}" not found`);
  }
  // The DB column is typed as `Array<Record<string, unknown>>` in the schema
  // (we keep the row loose so legacy fields don't break reads). Routes are
  // expected to validate the payload with `agentSkillsSchema` on the way
  // in, so the stored shape is trusted on the way out.
  return row.skills as unknown as AgentSkills;
}

/**
 * Replace the agent's full skill list. The daemon uploads the entire
 * snapshot on every restart — no per-skill merge, no diff. Phase 1 keeps
 * this unconditional (users restart daemons rarely); a future revision
 * may persist the last-uploaded content hash in the agent's local yaml
 * to skip no-op PATCHes if write-amplification ever shows up.
 */
export async function updateAgentSkills(db: Database, uuid: string, skills: AgentSkills): Promise<void> {
  const result = await db
    .update(agents)
    .set({ skills, updatedAt: new Date() })
    .where(and(eq(agents.uuid, uuid), ne(agents.status, AGENT_STATUSES.DELETED)))
    .returning({ uuid: agents.uuid });
  if (result.length === 0) {
    throw new NotFoundError(`Agent "${uuid}" not found`);
  }
}
