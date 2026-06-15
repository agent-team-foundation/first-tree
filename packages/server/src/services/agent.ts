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
  isReservedAgentName,
} from "@first-tree/shared";
import { getServerCliBinding } from "@first-tree/shared/channel";
import { and, count, desc, eq, getTableColumns, ilike, lt, ne, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Database } from "../db/connection.js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import type { OrgScope } from "../scope/types.js";
import { uuidv7 } from "../uuid.js";
import { agentAddressableCondition, agentVisibilityCondition } from "./access-control.js";
import { resolveDefaultOrgId } from "./organization.js";
import { recomputeWatchersForAgent } from "./watcher.js";

/**
 * Names beginning with `__` are reserved for First Tree-internal pseudo agents.
 * User-facing creation must not be able to squat on them, otherwise
 * internal traffic could be routed through a real account.
 */
const RESERVED_AGENT_NAME_PREFIX = "__";
type SelectDbLike = Pick<PostgresJsDatabase<Record<string, never>>, "select">;

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
 * "Supports" requires the entry's SDK to be **available** — `state: "ok"` or
 * `state: "unauthenticated"`. A `missing` or `error` entry is *reported* but
 * not usable, so we explicitly reject those rather than treating mere key
 * presence as support. Auth state is left to the user to fix at runtime
 * (the re-bind dialog surfaces an `unauthenticated` hint).
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
 *   - reported, entry shows `state: ok | unauthenticated` (i.e. `available:
 *     true`) — allow.
 *   - reported, entry missing OR `state: missing | error` — block unless
 *     `force` is set. We deliberately do NOT treat mere key presence as
 *     support: probeCapabilities() always emits an entry per built-in
 *     provider, including `{ state: "missing" }` for absent SDKs.
 *
 * Skipped entirely for human agents (no clientId) and when `force` is set
 * (e.g. operator overrides for an offline client).
 */
async function ensureClientSupportsRuntimeProvider(
  db: SelectDbLike,
  clientId: string | null,
  runtimeProvider: RuntimeProvider,
  options: { force?: boolean } = {},
): Promise<void> {
  if (clientId === null) return;
  if (options.force) return;

  const [client] = await db
    .select({ metadata: clients.metadata })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) return; // resolveAgentClient validates existence elsewhere

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
    .select({ id: clients.id, userId: clients.userId })
    .from(clients)
    .where(eq(clients.id, data.clientId))
    .limit(1);
  if (!client) {
    throw new BadRequestError(`Client "${data.clientId}" not found`);
  }

  if (!client.userId) {
    throw new BadRequestError(
      `Client "${data.clientId}" has not been claimed by a user yet. Have the operator run ` +
        `\`${getServerCliBinding().binName} login <token>\` on that machine before pinning an agent to it.`,
    );
  }
  if (client.userId !== manager.userId) {
    throw new ForbiddenError(
      `Client "${data.clientId}" is not owned by the manager's user — pick a client belonging to that user.`,
    );
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
 * autonomous-agent-self-mention path that resolveAudience would then fan
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
  options: { force?: boolean } = {},
) {
  const uuid = uuidv7();
  const name = data.name ?? null;
  const runtimeProvider: RuntimeProvider = data.runtimeProvider ?? DEFAULT_RUNTIME_PROVIDER;
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

  // Check organization-level agent quota.
  // NOTE: TOCTOU race — concurrent requests may both pass the check. Acceptable for Phase 1;
  // enforce with a DB-level CHECK constraint or SELECT ... FOR UPDATE in Phase 2 if needed.
  const [org] = await db
    .select({ maxAgents: organizations.maxAgents })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (org && org.maxAgents > 0) {
    const rows = await db
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

      const initialPayload = defaultRuntimeConfigPayload(runtimeProvider);
      await tx
        .insert(agentConfigs)
        .values({
          agentId: row.uuid,
          version: 1,
          payload: initialPayload,
          updatedBy: "system",
        })
        .onConflictDoNothing();

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

export async function updateAgent(db: Database, uuid: string, data: UpdateAgent) {
  const agent = await getAgent(db, uuid);

  // `clientId` is one-shot via this entry: NULL → ID is allowed (admin
  // claiming an unbound agent for a known client). Once bound, an agent's
  // client is immutable — there is no move/re-bind path. ID → null and
  // ID → another ID are both rejected.
  if (data.clientId !== undefined) {
    if (data.clientId === null) {
      throw new BadRequestError("clientId cannot be cleared — once bound, an agent stays bound to its client");
    }
    if (agent.clientId !== null && agent.clientId !== data.clientId) {
      throw new BadRequestError(
        "clientId is immutable once set — an agent cannot be moved to another client. " +
          "Provision a new agent on the target client instead.",
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
  if (data.metadata !== undefined) updates.metadata = data.metadata;
  // Explicit null clears the override (renderer falls back to djb2 hash).
  // Omitting the field leaves the column untouched.
  if (data.avatarColorToken !== undefined) updates.avatarColorToken = data.avatarColorToken;

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
  }

  // First-set clientId (NULL → ID): validate ownership against the agent's
  // current manager. Reuses the resolveAgentClient ownership check so the
  // semantics match agent creation.
  if (data.clientId !== undefined && data.clientId !== null && agent.clientId === null) {
    const resolvedClientId = await resolveAgentClient(db, {
      clientId: data.clientId,
      managerId: updates.managerId ?? agent.managerId,
      type: agent.type,
    });
    if (resolvedClientId !== null) {
      updates.clientId = resolvedClientId;
    }
  }

  const [updated] = await db.update(agents).set(updates).where(eq(agents.uuid, agent.uuid)).returning();

  if (!updated) throw new Error("Unexpected: UPDATE RETURNING produced no row");
  // If the manager was reassigned, watcher rows anchored on the old
  // manager need to drop and the new manager's rows need to appear.
  // Recompute is keyed by agent (not chat) since this single agent may
  // participate in many chats.
  if (data.managerId !== undefined && data.managerId !== agent.managerId) {
    await recomputeWatchersForAgent(db, agent.uuid);
  }
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
    .select({ uuid: agents.uuid, status: agents.status, type: agents.type })
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
