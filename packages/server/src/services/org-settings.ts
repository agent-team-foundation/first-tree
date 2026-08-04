import {
  AGENT_VISIBILITY,
  type ContextTreeActiveBinding,
  type ContextTreeProvider,
  type ContextTreeSettingState,
  canonicalGitRepoIdentity,
  classifyContextTreeSetting,
  contextTreeActiveBindingSchema,
  contextTreeBranchSchema,
  isOrgSettingNamespace,
  ORG_SETTINGS_NAMESPACES,
  type OrgContextTreeFeaturesInput,
  type OrgContextTreeStorage,
  type OrgSettingInput,
  type OrgSettingNamespace,
  type OrgSettingOutput,
  type OrgSettingStorage,
  resolveContextTreeProvider,
  resolveGitLabRepositoryWebIdentity,
} from "@first-tree/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { pickDefaultMembership } from "./auth.js";

/**
 * Per-organization settings, keyed by `(organizationId, namespace)`. The
 * registry of valid namespaces and their storage / input / output schemas
 * lives in `@first-tree/shared`.
 *
 * Read path:  storage row → output (mask)
 * Write path: input → validate → merge with current storage → upsert (in tx)
 *
 * The generic getter returns the masked output. Per-namespace plaintext
 * accessors live alongside this module when a secret needs to leave the
 * encrypted-at-rest boundary (none today).
 */

function assertNamespace(ns: string): asserts ns is OrgSettingNamespace {
  if (!isOrgSettingNamespace(ns)) {
    throw new BadRequestError(`Unknown organization-settings namespace: "${ns}"`);
  }
}

async function fetchStorageRow<K extends OrgSettingNamespace>(
  db: Database,
  orgId: string,
  namespace: K,
): Promise<OrgSettingStorage<K> | null> {
  const [row] = await db
    .select({ value: organizationSettings.value })
    .from(organizationSettings)
    .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, namespace)))
    .limit(1);
  if (!row) return null;
  const schema = ORG_SETTINGS_NAMESPACES[namespace].storage;
  return schema.parse(row.value) as OrgSettingStorage<K>;
}

export async function getRawOrgContextTreeSetting(db: Database, orgId: string): Promise<unknown> {
  const [row] = await db
    .select({ value: organizationSettings.value })
    .from(organizationSettings)
    .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, "context_tree")))
    .limit(1);
  return row ? row.value : { branch: "main" };
}

async function lockOrganizationForSettingsMutation(db: Database, orgId: string): Promise<void> {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .for("update")
    .limit(1);
  if (!org) {
    throw new NotFoundError(`Organization "${orgId}" not found`);
  }
}

function emptyStorage<K extends OrgSettingNamespace>(namespace: K): OrgSettingStorage<K> {
  // The storage schema's `.parse({})` fills in any defaults (e.g. context_tree.branch="main").
  const schema = ORG_SETTINGS_NAMESPACES[namespace].storage;
  return schema.parse({}) as OrgSettingStorage<K>;
}

function isCompleteContextTreeReplacement(input: OrgSettingInput<"context_tree">): boolean {
  return input.repo !== undefined && input.branch !== undefined;
}

/**
 * Merge a validated input into the current storage row for a namespace.
 *
 * Input semantics per nullish field:
 *   `undefined` → unchanged
 *   `null`      → cleared
 *   value       → set / replace (already validated as non-empty by the input schema)
 */
function applyInputDelta<K extends OrgSettingNamespace>(
  namespace: K,
  current: OrgSettingStorage<K>,
  input: OrgSettingInput<K>,
): OrgSettingStorage<K> {
  if (namespace === "context_tree") {
    const cur = current as OrgSettingStorage<"context_tree">;
    const inp = input as OrgSettingInput<"context_tree">;
    const next: OrgSettingStorage<"context_tree"> = {
      provider: inp.provider === undefined ? cur.provider : (inp.provider ?? undefined),
      repo: inp.repo === undefined ? cur.repo : (inp.repo ?? undefined),
      branch: inp.branch === undefined ? cur.branch : (inp.branch ?? "main"),
    };
    return next as OrgSettingStorage<K>;
  }
  if (namespace === "source_repos") {
    const cur = current as OrgSettingStorage<"source_repos">;
    const inp = input as OrgSettingInput<"source_repos">;
    const next: OrgSettingStorage<"source_repos"> = {
      repos: inp.repos === undefined ? cur.repos : inp.repos,
    };
    return next as OrgSettingStorage<K>;
  }
  if (namespace === "context_tree_features") {
    const cur = current as OrgSettingStorage<"context_tree_features">;
    const inp = input as OrgSettingInput<"context_tree_features">;
    const agentUuid = inp.contextReviewer.enabled
      ? inp.contextReviewer.agentUuid
      : (inp.contextReviewer.agentUuid ?? cur.contextReviewer.agentUuid);
    const next: OrgSettingStorage<"context_tree_features"> = {
      contextReviewer: {
        enabled: inp.contextReviewer.enabled,
        agentUuid,
      },
    };
    return next as OrgSettingStorage<K>;
  }
  if (namespace === "github_features") {
    const inp = input as OrgSettingInput<"github_features">;
    const next: OrgSettingStorage<"github_features"> = {
      teamAgent: {
        agentUuid: inp.teamAgent.agentUuid,
      },
    };
    return next as OrgSettingStorage<K>;
  }
  // Exhaustiveness — adding a new namespace forces a compile error here.
  const _exhaustive: never = namespace;
  return _exhaustive;
}

/**
 * Project the storage row into the API output for a namespace, masking
 * any secret fields.
 */
async function toOutput<K extends OrgSettingNamespace>(
  db: Database,
  orgId: string,
  namespace: K,
  storage: OrgSettingStorage<K>,
): Promise<OrgSettingOutput<K>> {
  if (namespace === "context_tree") {
    const s = storage as OrgSettingStorage<"context_tree">;
    const out: OrgSettingOutput<"context_tree"> = {
      provider: s.provider,
      repo: s.repo,
      branch: s.branch,
    };
    return out as OrgSettingOutput<K>;
  }
  if (namespace === "source_repos") {
    const s = storage as OrgSettingStorage<"source_repos">;
    const out: OrgSettingOutput<"source_repos"> = {
      repos: s.repos,
    };
    return out as OrgSettingOutput<K>;
  }
  if (namespace === "context_tree_features") {
    const s = storage as OrgSettingStorage<"context_tree_features">;
    const reviewerAgent = await resolveContextReviewerAgentSummary(db, orgId, s.contextReviewer.agentUuid);
    const out: OrgSettingOutput<"context_tree_features"> = {
      contextReviewer: {
        enabled: s.contextReviewer.enabled,
        // This namespace is member-readable. A private, deleted, or foreign
        // historical selection stays in storage for replacement, but its
        // opaque identity is not a Team-wide fact.
        agentUuid: reviewerAgent?.uuid ?? null,
        reviewerAgent,
      },
    };
    return out as OrgSettingOutput<K>;
  }
  if (namespace === "github_features") {
    const s = storage as OrgSettingStorage<"github_features">;
    const agent = await resolveOrgVisibleAgentSummary(db, orgId, s.teamAgent.agentUuid);
    const out: OrgSettingOutput<"github_features"> = {
      teamAgent: {
        agentUuid: agent?.uuid ?? null,
        agent,
      },
    };
    return out as OrgSettingOutput<K>;
  }
  const _exhaustive: never = namespace;
  return _exhaustive;
}

/**
 * Read a setting masked for the API. Missing rows → namespace defaults
 * (parse `{}` against the storage schema).
 */
export async function getOrgSetting<K extends OrgSettingNamespace>(
  db: Database,
  orgId: string,
  namespace: K,
): Promise<OrgSettingOutput<K>> {
  assertNamespace(namespace);
  const storage = (await fetchStorageRow(db, orgId, namespace)) ?? emptyStorage(namespace);
  return toOutput(db, orgId, namespace, storage);
}

/**
 * Read a runtime-safe Context Tree binding for server-internal consumers.
 *
 * The admin-only `/context_tree/raw` settings read preserves loose historical
 * values for repair. Runtime consumers must fail closed: an incomplete or
 * invalid historical row is not an active binding.
 */
export async function getOrgContextTreeBinding(db: Database, orgId: string): Promise<ContextTreeActiveBinding | null> {
  const state = await getOrgContextTreeSettingState(db, orgId);
  return state.kind === "bound" ? state.binding : null;
}

/**
 * Read the live Context Tree binding and raw Reviewer assignment in one
 * database statement. Server-internal review mutations use this tuple so they
 * never combine a binding from one settings snapshot with an assignment from
 * another. Member- or Agent-readable surfaces must use the Team-safe
 * projection below.
 */
export async function getOrgContextReviewRuntime(db: Database, orgId: string): Promise<OrgContextReviewRuntime> {
  const rows = await db
    .select({
      namespace: organizationSettings.namespace,
      value: organizationSettings.value,
      gitlabConnectionId: gitlabConnections.id,
      gitlabInstanceOrigin: gitlabConnections.instanceOrigin,
      gitlabEndpointFirstSeenAt: gitlabConnections.endpointFirstSeenAt,
      gitlabLastValidInboundAt: gitlabConnections.lastValidInboundAt,
    })
    .from(organizations)
    .leftJoin(
      organizationSettings,
      and(
        eq(organizationSettings.organizationId, organizations.id),
        inArray(organizationSettings.namespace, ["context_tree", "context_tree_features"]),
      ),
    )
    .leftJoin(gitlabConnections, eq(gitlabConnections.organizationId, organizations.id))
    .where(eq(organizations.id, orgId));
  const values = new Map(rows.flatMap((row) => (row.namespace === null ? [] : [[row.namespace, row.value] as const])));
  const connectionRow = rows.find((row) => row.gitlabConnectionId !== null);
  const gitlabConnection =
    connectionRow?.gitlabConnectionId && connectionRow.gitlabInstanceOrigin
      ? {
          id: connectionRow.gitlabConnectionId,
          instanceOrigin: connectionRow.gitlabInstanceOrigin,
          endpointFirstSeenAt: connectionRow.gitlabEndpointFirstSeenAt,
          lastValidInboundAt: connectionRow.gitlabLastValidInboundAt,
        }
      : null;
  const tree = classifyContextTreeSetting(values.has("context_tree") ? values.get("context_tree") : {});
  const features = ORG_SETTINGS_NAMESPACES.context_tree_features.storage.parse(
    values.get("context_tree_features") ?? {},
  );
  const repo = tree.kind === "bound" ? tree.binding.repo : null;
  const resolution =
    tree.kind === "bound"
      ? resolveContextTreeProvider({
          repo,
          declaredProvider: tree.binding.provider,
          gitlabInstanceOrigin: gitlabConnection?.instanceOrigin,
        })
      : resolveContextTreeProvider({ repo: null });
  const gitlabIdentity =
    resolution.provider === "gitlab" && gitlabConnection
      ? resolveGitLabRepositoryWebIdentity(repo, gitlabConnection.instanceOrigin)
      : null;
  const providerMatchesRepository =
    tree.kind !== "invalid" &&
    resolution.provider !== null &&
    resolution.declaredProviderMatches &&
    (resolution.provider !== "gitlab" || gitlabIdentity?.originMatchesConnection === true);

  return {
    bindingState: tree.kind,
    provider: resolution.provider,
    repo,
    branch: tree.kind === "bound" ? tree.binding.branch : tree.kind === "unbound" ? tree.branch : null,
    providerSource: resolution.source,
    providerMatchesRepository,
    gitlabConnection: gitlabConnection
      ? {
          id: gitlabConnection.id,
          instanceOrigin: gitlabConnection.instanceOrigin,
          endpointSeen: gitlabConnection.endpointFirstSeenAt !== null,
          lastValidInboundAt: gitlabConnection.lastValidInboundAt,
        }
      : null,
    contextReviewer: {
      enabled: features.contextReviewer.enabled,
      agentUuid: features.contextReviewer.agentUuid,
      managerHumanAgentId: null,
      managerActiveAdmin: false,
    },
  };
}

/**
 * Apply the same Team-safe Reviewer identity projection as `getOrgSetting`.
 * Invalid historical private, deleted, or foreign selections remain stored
 * for admin replacement without exposing their opaque UUID to Team runtimes.
 */
export async function getTeamSafeOrgContextReviewRuntime(
  db: Database,
  orgId: string,
): Promise<OrgContextReviewRuntime> {
  const runtime = await getOrgContextReviewRuntime(db, orgId);
  const reviewerAgent = await resolveContextReviewerAgentSummary(db, orgId, runtime.contextReviewer.agentUuid);
  return {
    ...runtime,
    contextReviewer: {
      enabled: runtime.contextReviewer.enabled,
      agentUuid: reviewerAgent?.uuid ?? null,
      managerHumanAgentId: reviewerAgent?.managerHumanAgentId ?? null,
      managerActiveAdmin: reviewerAgent?.managerActiveAdmin ?? false,
    },
  };
}

export type OrgContextReviewRuntime = {
  bindingState: "bound" | "unbound" | "invalid";
  provider: ContextTreeProvider | null;
  repo: string | null;
  branch: string | null;
  providerSource: "declared" | "github_host" | "gitlab_connection" | "unknown";
  providerMatchesRepository: boolean;
  gitlabConnection: {
    id: string;
    instanceOrigin: string;
    endpointSeen: boolean;
    lastValidInboundAt: Date | null;
  } | null;
  contextReviewer: {
    enabled: boolean;
    agentUuid: string | null;
    managerHumanAgentId: string | null;
    managerActiveAdmin: boolean;
  };
};

/**
 * Project the joined Context Review runtime into the only member-safe Context
 * Tree setting shape. Persisted providerless bindings gain a provider only
 * when the current runtime can resolve it against the repository authority.
 */
export function projectOrgContextTreeSettingState(runtime: OrgContextReviewRuntime): ContextTreeSettingState {
  if (runtime.bindingState === "invalid") return { kind: "invalid" };

  if (runtime.bindingState === "unbound") {
    const state = classifyContextTreeSetting({ branch: runtime.branch });
    return state.kind === "unbound" ? state : { kind: "invalid" };
  }

  const state = classifyContextTreeSetting({
    repo: runtime.repo,
    branch: runtime.branch,
    ...(runtime.provider && runtime.providerMatchesRepository ? { provider: runtime.provider } : {}),
  });
  return state.kind === "bound" ? state : { kind: "invalid" };
}

function isSameOrgContextTreeBindingRuntime(
  current: OrgContextReviewRuntime,
  expected: OrgContextReviewRuntime,
): boolean {
  return (
    current.bindingState === expected.bindingState &&
    current.provider === expected.provider &&
    current.repo === expected.repo &&
    current.branch === expected.branch &&
    current.providerMatchesRepository === expected.providerMatchesRepository &&
    current.gitlabConnection?.id === expected.gitlabConnection?.id &&
    current.gitlabConnection?.instanceOrigin === expected.gitlabConnection?.instanceOrigin
  );
}

/**
 * Recheck only the Context Tree binding and provider route used by a snapshot.
 * Reviewer assignment and enablement are independent and must not invalidate
 * an in-flight Tree read.
 */
export async function isOrgContextTreeBindingRuntimeCurrent(
  db: Database,
  orgId: string,
  expected: OrgContextReviewRuntime,
): Promise<boolean> {
  const current = await getOrgContextReviewRuntime(db, orgId);
  return isSameOrgContextTreeBindingRuntime(current, expected);
}

/**
 * Recheck the complete review mutation tuple, including the selected Reviewer.
 */
export async function isOrgContextReviewRuntimeCurrent(
  db: Database,
  orgId: string,
  expected: OrgContextReviewRuntime,
): Promise<boolean> {
  const current = await getOrgContextReviewRuntime(db, orgId);
  return (
    isSameOrgContextTreeBindingRuntime(current, expected) &&
    current.contextReviewer.enabled === expected.contextReviewer.enabled &&
    current.contextReviewer.agentUuid === expected.contextReviewer.agentUuid
  );
}

/**
 * Classify the storage-compatible binding without resolving a provider.
 * Member-readable API surfaces must project `OrgContextReviewRuntime` through
 * `projectOrgContextTreeSettingState` instead.
 */
export async function getOrgContextTreeSettingState(db: Database, orgId: string): Promise<ContextTreeSettingState> {
  const [row] = await db
    .select({ value: organizationSettings.value })
    .from(organizationSettings)
    .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, "context_tree")))
    .limit(1);
  return classifyContextTreeSetting(row ? row.value : {});
}

/**
 * Find another organization already bound to `repoUrl`, if any.
 *
 * A Context Tree repo belongs to exactly one team. Provisioning derives a repo
 * name and adopts an existing repo when GitHub reports the name is taken, so
 * "the name matches" is only ever a guess about ownership — this is the fact.
 * Without it, two teams whose names derive the same repo name end up sharing
 * one tree, and the second team silently reads and writes the first team's
 * decisions.
 *
 * Comparison is on repository identity, never on URL text. The binding contract
 * accepts HTTPS, `ssh://`, and scp-like SSH spellings with an optional `.git`,
 * so a team bound through one transport must still be found when the lookup
 * arrives through another — a text comparison would report no conflict and hand
 * over a repository that is already someone's tree.
 *
 * Each side is resolved through its own team's GitLab connection, so an SSH
 * reference and an HTTPS reference to one self-managed repository reduce to the
 * same web identity. Resolution happens in application code rather than SQL
 * because the identity rule is the shared cross-package one; the scan is
 * bounded by teams that have a tree bound at all, and this runs once per write.
 */
export async function findOrgBoundToContextTreeRepo(
  db: Database,
  excludeOrgId: string,
  repoUrl: string,
): Promise<string | null> {
  const [callerConnection] = await db
    .select({ instanceOrigin: gitlabConnections.instanceOrigin })
    .from(gitlabConnections)
    .where(eq(gitlabConnections.organizationId, excludeOrgId))
    .limit(1);
  const target = contextTreeRepoOwnershipIdentity(repoUrl, callerConnection?.instanceOrigin);
  if (!target) return null;

  const rows = await db
    .select({
      organizationId: organizationSettings.organizationId,
      repo: sql<string | null>`${organizationSettings.value}->>'repo'`,
      instanceOrigin: gitlabConnections.instanceOrigin,
    })
    .from(organizationSettings)
    .leftJoin(gitlabConnections, eq(gitlabConnections.organizationId, organizationSettings.organizationId))
    .where(
      and(
        eq(organizationSettings.namespace, "context_tree"),
        ne(organizationSettings.organizationId, excludeOrgId),
        sql`${organizationSettings.value}->>'repo' IS NOT NULL`,
      ),
    );

  return (
    rows.find((row) => contextTreeRepoOwnershipIdentity(row.repo, row.instanceOrigin) === target)?.organizationId ??
    null
  );
}

/**
 * Read the Context Tree binding plus row freshness. Onboarding recovery uses
 * `updatedAt` to distinguish a tree binding created after the user completed
 * the value-first work chat from an older, already-adopted team tree.
 */
export async function getOrgContextTreeWithMeta(
  db: Database,
  orgId: string,
): Promise<{ binding: ContextTreeActiveBinding | null; updatedAt: Date | null }> {
  const [row] = await db
    .select({ value: organizationSettings.value, updatedAt: organizationSettings.updatedAt })
    .from(organizationSettings)
    .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, "context_tree")))
    .limit(1);
  if (!row) return { binding: null, updatedAt: null };
  const state = classifyContextTreeSetting(row.value);
  return { binding: state.kind === "bound" ? state.binding : null, updatedAt: row.updatedAt };
}

/**
 * Upsert a setting. Returns the masked output of the resulting row.
 *
 * The transaction locks the stable organization parent row before reading the
 * current JSON value. This also serializes writes when the namespace row does
 * not exist yet, so partial updates cannot lose each other's fields.
 */
export async function putOrgSetting<K extends OrgSettingNamespace>(
  db: Database,
  orgId: string,
  namespace: K,
  rawInput: unknown,
  options: {
    updatedBy: string;
    memberId?: string;
  },
): Promise<OrgSettingOutput<K>> {
  assertNamespace(namespace);

  const inputSchema = ORG_SETTINGS_NAMESPACES[namespace].input;
  const input = inputSchema.parse(rawInput) as OrgSettingInput<K>;

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockOrganizationForSettingsMutation(txDb, orgId);

    let current: OrgSettingStorage<K>;
    if (namespace === "context_tree") {
      const rawCurrent = await getRawOrgContextTreeSetting(txDb, orgId);
      const parsedCurrent = ORG_SETTINGS_NAMESPACES.context_tree.storage.safeParse(rawCurrent);
      const contextTreeInput = input as OrgSettingInput<"context_tree">;
      if (!parsedCurrent.success && !isCompleteContextTreeReplacement(contextTreeInput)) {
        // A partial update cannot safely preserve fields from malformed JSON.
        // Re-throw the storage error without changing the historical row.
        throw parsedCurrent.error;
      }
      current = (parsedCurrent.success ? parsedCurrent.data : emptyStorage("context_tree")) as OrgSettingStorage<K>;
    } else {
      current = (await fetchStorageRow(txDb, orgId, namespace)) ?? emptyStorage(namespace);
    }
    let merged = applyInputDelta(namespace, current, input);
    if (namespace === "context_tree") {
      const contextTreeInput = input as OrgSettingInput<"context_tree">;
      const contextTree = merged as OrgSettingStorage<"context_tree">;
      merged = (await resolveStoredContextTreeProvider(
        txDb,
        orgId,
        contextTree,
        contextTreeInput,
      )) as OrgSettingStorage<K>;
      await assertContextTreeBindingTargetAuthorized(txDb, orgId, merged as OrgSettingStorage<"context_tree">);
    }
    if (namespace === "context_tree_features") {
      await assertContextReviewerAgentAllowed(txDb, orgId, input as OrgContextTreeFeaturesInput, options.memberId);
    }

    // Final shape check (defensive — should always pass after applyInputDelta).
    const storageSchema = ORG_SETTINGS_NAMESPACES[namespace].storage;
    const validated = storageSchema.parse(merged) as OrgSettingStorage<K>;
    if (namespace === "context_tree") {
      const contextTree = validated as OrgContextTreeStorage;
      if (contextTree.repo === undefined) {
        contextTreeBranchSchema.parse(contextTree.branch);
      } else {
        contextTreeActiveBindingSchema.parse(contextTree);
      }
    }

    await tx
      .insert(organizationSettings)
      .values({
        organizationId: orgId,
        namespace,
        value: validated as Record<string, unknown>,
        version: 1,
        updatedBy: options.updatedBy,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [organizationSettings.organizationId, organizationSettings.namespace],
        set: {
          value: validated as Record<string, unknown>,
          version: sql`${organizationSettings.version} + 1`,
          updatedBy: options.updatedBy,
          updatedAt: new Date(),
        },
      });

    return toOutput(txDb, orgId, namespace, validated);
  });
}

/**
 * Persist an initialized Context Tree binding only while the exact unbound
 * branch observed by the caller is still current. Callers can perform external
 * work between observation and finalization, so this conditional write is the
 * authoritative concurrency guard.
 *
 * Every regular settings mutation takes the same organization-row lock. The
 * `setWhere` predicate also protects against a writer that bypasses this
 * service: PostgreSQL returns no row when a concurrent value gains a repo or
 * changes the unbound branch observed by the early route check.
 */
export async function putInitializedOrgContextTreeBinding(
  db: Database,
  orgId: string,
  rawInput: unknown,
  options: {
    updatedBy: string;
    expectedUnboundBranch: string;
  },
): Promise<ContextTreeActiveBinding> {
  const binding = contextTreeActiveBindingSchema.parse(rawInput);
  const expectedUnboundBranch = contextTreeBranchSchema.parse(options.expectedUnboundBranch);
  const value: Record<string, unknown> = {
    provider: binding.provider,
    repo: binding.repo,
    branch: binding.branch,
  };

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockOrganizationForSettingsMutation(txDb, orgId);
    const current = await getOrgContextTreeSettingState(txDb, orgId);
    if (current.kind !== "unbound" || current.branch !== expectedUnboundBranch) {
      throw new ConflictError("Context Tree setting changed after tree initialization began");
    }
    await assertContextTreeBindingTargetAuthorized(txDb, orgId, binding);
    const now = new Date();

    const [row] = await tx
      .insert(organizationSettings)
      .values({
        organizationId: orgId,
        namespace: "context_tree",
        value,
        version: 1,
        updatedBy: options.updatedBy,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [organizationSettings.organizationId, organizationSettings.namespace],
        set: {
          value,
          version: sql`${organizationSettings.version} + 1`,
          updatedBy: options.updatedBy,
          updatedAt: now,
        },
        setWhere: sql`
          jsonb_typeof(${organizationSettings.value}) = 'object'
          AND NOT (${organizationSettings.value} ? 'repo')
          AND (
            (
              jsonb_typeof(${organizationSettings.value} -> 'branch') = 'string'
              AND ${organizationSettings.value} ->> 'branch' = ${expectedUnboundBranch}
            )
            OR (
              NOT (${organizationSettings.value} ? 'branch')
              AND ${expectedUnboundBranch} = 'main'
            )
          )
        `,
      })
      .returning({ value: organizationSettings.value });

    if (!row) {
      throw new ConflictError("Context Tree setting changed after tree initialization began");
    }
    return contextTreeActiveBindingSchema.parse(row.value);
  });
}

async function resolveContextReviewerAgentSummary(
  db: Database,
  orgId: string,
  agentUuid: string | null,
): Promise<{
  uuid: string;
  name: string | null;
  displayName: string;
  managerHumanAgentId: string | null;
  managerActiveAdmin: boolean;
} | null> {
  if (!agentUuid) return null;
  const [agent] = await db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      displayName: agents.displayName,
      managerHumanAgentId: members.agentId,
      managerOrganizationId: members.organizationId,
      managerStatus: members.status,
      managerRole: members.role,
    })
    .from(agents)
    .leftJoin(members, eq(members.id, agents.managerId))
    .where(
      and(
        eq(agents.uuid, agentUuid),
        eq(agents.organizationId, orgId),
        eq(agents.visibility, AGENT_VISIBILITY.ORGANIZATION),
        ne(agents.status, "deleted"),
      ),
    )
    .limit(1);
  if (!agent) return null;
  return {
    uuid: agent.uuid,
    name: agent.name,
    displayName: agent.displayName,
    managerHumanAgentId: agent.managerHumanAgentId,
    managerActiveAdmin:
      agent.managerOrganizationId === orgId && agent.managerStatus === "active" && agent.managerRole === "admin",
  };
}

async function resolveOrgVisibleAgentSummary(
  db: Database,
  orgId: string,
  agentUuid: string | null,
): Promise<{ uuid: string; name: string | null; displayName: string } | null> {
  if (!agentUuid) return null;
  const [agent] = await db
    .select({ uuid: agents.uuid, name: agents.name, displayName: agents.displayName })
    .from(agents)
    .where(
      and(
        eq(agents.uuid, agentUuid),
        eq(agents.organizationId, orgId),
        eq(agents.visibility, AGENT_VISIBILITY.ORGANIZATION),
        ne(agents.status, "deleted"),
      ),
    )
    .limit(1);
  return agent ?? null;
}

async function assertContextReviewerAgentAllowed(
  db: Database,
  orgId: string,
  input: OrgContextTreeFeaturesInput,
  memberId: string | undefined,
): Promise<void> {
  if (!input.contextReviewer.enabled) return;
  if (!memberId) {
    throw new ForbiddenError("Context Reviewer can only be assigned by an active member of this organization");
  }
  const agentUuid = input.contextReviewer.agentUuid;
  if (!agentUuid) {
    throw new BadRequestError("agentUuid is required when Context Reviewer is enabled");
  }

  const [agent] = await db
    .select({
      uuid: agents.uuid,
      type: agents.type,
      status: agents.status,
      organizationId: agents.organizationId,
      managerId: agents.managerId,
    })
    .from(agents)
    .where(eq(agents.uuid, agentUuid))
    .limit(1);

  if (!agent || agent.organizationId !== orgId || agent.type === "human" || agent.status !== "active") {
    throw new BadRequestError("Context Reviewer agent must be an active non-human agent in this organization");
  }
  const [manager] = await db
    .select({ organizationId: members.organizationId, status: members.status, role: members.role })
    .from(members)
    .where(eq(members.id, agent.managerId))
    .limit(1);
  if (!manager || manager.organizationId !== orgId || manager.status !== "active" || manager.role !== "admin") {
    throw new BadRequestError("Context Reviewer agent must be managed by an active Team Admin");
  }
  const runtime = await getOrgContextReviewRuntime(db, orgId);
  if (
    runtime.bindingState !== "bound" ||
    !runtime.provider ||
    !runtime.providerMatchesRepository ||
    !runtime.repo ||
    !runtime.branch
  ) {
    throw new BadRequestError(
      "Context Reviewer requires a valid Context Tree binding with a resolved GitHub or GitLab provider",
    );
  }
  if (runtime.provider === "gitlab") {
    if (
      !runtime.providerMatchesRepository ||
      !runtime.gitlabConnection ||
      !resolveContextTreeProvider({
        repo: runtime.repo,
        declaredProvider: "gitlab",
        gitlabInstanceOrigin: runtime.gitlabConnection.instanceOrigin,
      }).gitlabConnectionMatches
    ) {
      throw new BadRequestError(
        "Context Reviewer for GitLab requires the current GitLab connection origin to match the Context Tree repository",
      );
    }
    return;
  }
  if (runtime.provider !== "github") {
    throw new BadRequestError("Context Reviewer requires a supported Context Tree provider");
  }
  const [installation] = await db
    .select({ permissions: githubAppInstallations.permissions, suspendedAt: githubAppInstallations.suspendedAt })
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.hubOrganizationId, orgId))
    .limit(1);
  if (!installation || installation.suspendedAt || installation.permissions.pull_requests !== "write") {
    throw new BadRequestError(
      "Context Reviewer requires an active GitHub App installation with Pull requests: write permission accepted",
    );
  }
}

async function resolveStoredContextTreeProvider(
  db: Database,
  orgId: string,
  storage: OrgSettingStorage<"context_tree">,
  input: OrgSettingInput<"context_tree">,
): Promise<OrgSettingStorage<"context_tree">> {
  if (!storage.repo) return { ...storage, provider: undefined };
  if (input.repo === undefined && input.provider === undefined) return storage;

  const [connection] = await db
    .select({ instanceOrigin: gitlabConnections.instanceOrigin })
    .from(gitlabConnections)
    .where(eq(gitlabConnections.organizationId, orgId))
    .limit(1);
  const directlyResolved = resolveContextTreeProvider({
    repo: storage.repo,
    declaredProvider: input.provider ?? undefined,
    gitlabInstanceOrigin: connection?.instanceOrigin,
  });
  if (directlyResolved.provider) return { ...storage, provider: directlyResolved.provider };

  return { ...storage, provider: undefined };
}

/**
 * Identity two Context Tree bindings are compared on to decide whether they
 * name the same repository.
 *
 * The identity is the repository's web origin and path. Where that origin comes
 * from depends on the reference, because the binding contract accepts HTTPS,
 * `ssh://`, and scp-like SSH spellings:
 *
 * - GitHub states it implicitly — one fixed origin, no port — so every
 *   spelling already agrees under the shared canonical form.
 * - An HTTP(S) reference states it outright, port included, and needs nothing
 *   else. Asking for a connection here would discard the identity of a binding
 *   whose team later deletes its connection, and that binding still owns its
 *   repository.
 * - An SSH or scp-like reference states no origin at all, and its transport
 *   port is never the forge's, so only the owning team's GitLab connection can
 *   supply one.
 *
 * All three land on the same string for one repository, so a team on HTTPS and
 * a team on SSH are seen to hold the same tree. Two self-managed instances on
 * one host stay distinct, because a non-default web port is part of which
 * forge it is.
 *
 * An SSH reference whose team has no connection, or whose host does not match
 * it, has no establishable origin and returns null. That fails open on the safe
 * side: a conflict goes unnoticed rather than a legitimate binding being
 * refused on a guess.
 */
export function contextTreeRepoOwnershipIdentity(
  repo: string | null | undefined,
  gitlabInstanceOrigin: string | null | undefined,
): string | null {
  const identity = canonicalGitRepoIdentity(repo);
  if (!identity || !repo) return null;

  // GitHub has one fixed origin and no port, so every spelling already agrees.
  if (identity.host === "github.com") return identity.canonical;

  // An HTTP(S) reference states its own web origin, port included. Requiring a
  // connection to read it would drop the identity of a binding whose team later
  // deletes its connection — and that binding still owns its repository.
  try {
    const url = new URL(repo.trim());
    if (url.protocol === "https:" || url.protocol === "http:") {
      return `${url.origin.toLowerCase()}/${identity.path}`;
    }
  } catch {
    // Not a URL — scp-like SSH, handled below.
  }

  // SSH and scp-like references carry no web origin, and their transport port
  // is never the forge's, so only the owning team's connection can supply one.
  const web = resolveGitLabRepositoryWebIdentity(repo, gitlabInstanceOrigin);
  return web?.originMatchesConnection ? `${web.origin}/${web.path}` : null;
}

/**
 * Refuse a binding that would point this team at another team's Context Tree.
 *
 * A Context Tree repository backs one team: sharing one merges two teams'
 * decisions, constraints, and ownership into a single tree. This runs on every
 * binding write — Cloud provisioning, manual Settings binding, and the
 * `tree init` callback alike — because the repository is the thing being
 * claimed regardless of which surface names it.
 *
 * Two organizations binding the same repository at the same instant can still
 * both pass this check: the caller holds its own organization row, which does
 * not serialize a different organization's write. That window is left open
 * rather than closed with a lock on the repository identity.
 */
async function assertContextTreeRepoNotHeldByAnotherOrg(
  db: Database,
  orgId: string,
  binding: OrgSettingStorage<"context_tree">,
): Promise<void> {
  if (!binding.repo) return;

  const holder = await findOrgBoundToContextTreeRepo(db, orgId, binding.repo);
  if (holder) {
    throw new ConflictError("That repository is already another team's Context Tree");
  }
}

export async function assertContextTreeBindingTargetAuthorized(
  db: Database,
  orgId: string,
  binding: OrgSettingStorage<"context_tree">,
): Promise<void> {
  await assertContextTreeRepoNotHeldByAnotherOrg(db, orgId, binding);
  if (!binding.provider || !binding.repo) return;
  const resolution = resolveContextTreeProvider({
    repo: binding.repo,
    declaredProvider: binding.provider,
  });
  if (!resolution.declaredProviderMatches) {
    throw new BadRequestError("Context Tree provider does not match the repository origin");
  }
  if (binding.provider !== "gitlab") return;
  const [connection] = await db
    .select({ instanceOrigin: gitlabConnections.instanceOrigin })
    .from(gitlabConnections)
    .where(eq(gitlabConnections.organizationId, orgId))
    .limit(1);
  if (!connection) {
    throw new BadRequestError("GitLab Context Tree repository requires a current GitLab connection");
  }
  const identity = resolveGitLabRepositoryWebIdentity(binding.repo, connection.instanceOrigin);
  if (!identity?.originMatchesConnection) {
    throw new BadRequestError("GitLab Context Tree repository origin must match the current GitLab connection origin");
  }
}

/**
 * Delete a namespace row; subsequent GETs return defaults.
 */
export async function deleteOrgSetting(db: Database, orgId: string, namespace: string): Promise<void> {
  assertNamespace(namespace);
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockOrganizationForSettingsMutation(txDb, orgId);
    await tx
      .delete(organizationSettings)
      .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, namespace)));
  });
}

/**
 * Resolve the caller's "primary org" for user-scoped routes that
 * historically didn't take an `:orgId` (e.g. `/context-tree/info`,
 * `/context-tree/snapshot`).
 *
 * Uses the same `pickDefaultMembership` helper that `/me` uses to compute
 * `defaultOrganizationId` (most-recently-active membership, id desc tie-break).
 * That guarantees the org `/me` reports as the default is the same org these
 * server-internal lookups read from — earlier the two sides used opposite
 * orderings (`/me` desc, this fn asc), so multi-org users saw `/info`
 * resolve to a different (often unconfigured) org than the one Team Settings
 * was edited for.
 *
 * Returns `null` for users with no active membership.
 */
export async function resolveUserPrimaryOrgId(db: Database, userId: string): Promise<string | null> {
  const rows = await db
    .select({
      id: members.id,
      organizationId: members.organizationId,
      createdAt: members.createdAt,
    })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.status, "active")));
  return pickDefaultMembership(rows)?.organizationId ?? null;
}
