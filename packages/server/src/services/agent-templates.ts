import { isDeepStrictEqual } from "node:util";
import {
  type AgentTemplateAdoptionSummary,
  type AgentTemplateComponent,
  type AgentTemplateComponentInput,
  type AgentTemplateDetail,
  type AgentTemplateDetailList,
  type AgentTemplatePayload,
  type AgentTemplatePublicList,
  type AgentTemplatePublicTemplate,
  type AgentTemplateReplacementSummary,
  agentTemplateAdoptionSummarySchema,
  agentTemplateDetailSchema,
  agentTemplateMcpComponentSchema,
  agentTemplatePayloadSchema,
  agentTemplatePromptComponentSchema,
  agentTemplatePublicTemplateSchema,
  agentTemplateReplacementSummarySchema,
  agentTemplateSkillComponentSchema,
  type CreateAgentTemplate,
  type PublishAgentTemplate,
  type RetireAgentTemplate,
  type UpdateAgentTemplate,
} from "@first-tree/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Database } from "../db/connection.js";
import { agentTemplates } from "../db/schema/agent-templates.js";
import { attachments } from "../db/schema/attachments.js";
import { members } from "../db/schema/members.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { createLogger } from "../observability/index.js";
import { uuidv7 } from "../uuid.js";
import { deleteAttachmentIfUnreferenced, loadAttachmentMeta } from "./attachment.js";
import type { AttachmentBlobStore } from "./attachment-blob-store.js";
import { validateSkillBundle } from "./skill-bundle.js";

const log = createLogger("agent-templates");

/**
 * Official Agent Template catalog governance.
 *
 * Publisher authorization is a deployment-configured Team: only current
 * active admins of `config.agentTemplates.publisherOrgId` may maintain the
 * global catalog, and every official Skill bundle must be an attachment
 * owned by that Team. The check reads the membership row on every request —
 * JWTs carry only `userId`, so a revoked admin loses access immediately.
 *
 * This service deliberately never touches `agent_configs`, `resources`, or
 * `agent_resource_bindings`: adopting a Template (Team Resource import) is a
 * later task, and Template updates/retirement must not scan or rewrite any
 * customer Team state.
 */

export type AgentTemplatePublisherScope = {
  organizationId: string;
  memberId: string;
};

/** Require current active admin membership in the configured publisher Team. */
export async function requireAgentTemplatePublisher(
  db: Database,
  config: Config,
  userId: string,
): Promise<AgentTemplatePublisherScope> {
  const publisherOrgId = config.agentTemplates?.publisherOrgId;
  if (!publisherOrgId) {
    throw new ForbiddenError("Agent Template publishing is not configured on this deployment.");
  }
  const [row] = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.userId, userId),
        eq(members.organizationId, publisherOrgId),
        eq(members.status, "active"),
        eq(members.role, "admin"),
      ),
    )
    .limit(1);
  if (!row) {
    throw new ForbiddenError("Agent Template publishing requires active admin membership in the publisher Team.");
  }
  return { organizationId: publisherOrgId, memberId: row.id };
}

/**
 * Timestamps are serialized with full PostgreSQL precision so clients can
 * pass `updatedAt` back verbatim as the `expectedUpdatedAt`
 * compare-and-set token. The comparison runs in JS against the row read
 * under `SELECT ... FOR UPDATE`, and every successful mutation advances the
 * stored value to `GREATEST(now(), previous + 1µs)` — so a token never
 * repeats, even when the application or database clock stalls between two
 * rapid writes.
 */
const TIMESTAMP_TEXT_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

function templateDetailSelection() {
  return {
    id: agentTemplates.id,
    slug: agentTemplates.slug,
    name: agentTemplates.name,
    status: agentTemplates.status,
    payload: agentTemplates.payload,
    replacementTemplateId: agentTemplates.replacementTemplateId,
    createdBy: agentTemplates.createdBy,
    updatedBy: agentTemplates.updatedBy,
    createdAt: sql<string>`to_char(${agentTemplates.createdAt} AT TIME ZONE 'UTC', '${sql.raw(TIMESTAMP_TEXT_FORMAT)}')`,
    updatedAt: sql<string>`to_char(${agentTemplates.updatedAt} AT TIME ZONE 'UTC', '${sql.raw(TIMESTAMP_TEXT_FORMAT)}')`,
  };
}

/** Strictly-advancing timestamp for the next mutation of the locked row. */
function nextMutationTimestamp() {
  return sql`GREATEST(now(), ${agentTemplates.updatedAt} + interval '1 microsecond')`;
}

type TemplateDetailRow = {
  id: string;
  slug: string;
  name: string;
  status: "draft" | "active" | "retired";
  payload: AgentTemplatePayload;
  replacementTemplateId: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

function toTemplateDetail(row: TemplateDetailRow): AgentTemplateDetail {
  return agentTemplateDetailSchema.parse({
    ...row,
    payload: agentTemplatePayloadSchema.parse(row.payload),
  });
}

function assertFresh(row: TemplateDetailRow, expectedUpdatedAt: string): void {
  if (row.updatedAt !== expectedUpdatedAt) {
    throw new ConflictError("Agent Template was modified concurrently; reload it and retry.", {
      code: "stale_agent_template",
    });
  }
}

function postgresErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof cause === "string" ? cause : null;
}

/**
 * Lock every referenced bundle attachment row in a stable id order. Called
 * inside the surrounding write transaction so the ready/ownership re-check
 * below cannot race the orphan sweep or a replacement between validation
 * and persistence.
 */
async function lockBundleAttachments(db: Database, bundleIds: readonly string[]): Promise<void> {
  const uniqueIds = [...new Set(bundleIds)].sort();
  if (uniqueIds.length === 0) return;
  await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(inArray(attachments.id, uniqueIds))
    .orderBy(asc(attachments.id))
    .for("update");
}

function skillBundleIds(components: readonly AgentTemplateComponent[]): string[] {
  return components.flatMap((component) => (component.type === "skill" ? [component.bundle.attachmentId] : []));
}

/**
 * Best-effort post-commit GC for released bundles. Cleanup runs only after a
 * successful commit and must never change the committed mutation's success
 * semantics: each id is collected through the authoritative lifecycle,
 * failures are logged and skipped, and one failing id never blocks the
 * others. Bundles still referenced by another Template or Resource are kept
 * by `isAttachmentReferenced`.
 */
export async function releaseTemplateBundles(
  db: Database,
  blobStore: AttachmentBlobStore,
  attachmentIds: readonly string[],
): Promise<void> {
  for (const attachmentId of attachmentIds) {
    try {
      await deleteAttachmentIfUnreferenced(db, blobStore, attachmentId);
    } catch (error) {
      log.warn(
        { err: error, attachmentId },
        "released Agent Template bundle could not be collected; the orphan sweep will retry",
      );
    }
  }
}

/**
 * Compile write-source components into the canonical persisted shape.
 * Prompt and MCP inputs are already canonical; Skill inputs carry only
 * `key + bundleAttachmentId` and every other field — display name, derived
 * payload, and the bundle descriptor with the server-measured size — is
 * derived from the real ZIP so callers cannot make the persisted summary
 * drift from its bytes.
 */
async function compileTemplateComponents(
  db: Database,
  blobStore: AttachmentBlobStore,
  publisherOrgId: string,
  inputs: readonly AgentTemplateComponentInput[],
): Promise<AgentTemplateComponent[]> {
  await lockBundleAttachments(
    db,
    inputs.flatMap((input) => (input.type === "skill" ? [input.bundleAttachmentId] : [])),
  );
  const compiled: AgentTemplateComponent[] = [];
  for (const input of inputs) {
    if (input.type === "prompt") {
      compiled.push(agentTemplatePromptComponentSchema.parse(input));
      continue;
    }
    if (input.type === "mcp") {
      compiled.push(agentTemplateMcpComponentSchema.parse(input));
      continue;
    }
    const meta = await loadAttachmentMeta(db, input.bundleAttachmentId);
    if (!meta || meta.organizationId !== publisherOrgId) {
      throw new BadRequestError(
        "Skill bundle attachment must be a ready attachment owned by the publisher organization.",
      );
    }
    const validated = await validateSkillBundle(db, blobStore, publisherOrgId, input.bundleAttachmentId);
    compiled.push(
      agentTemplateSkillComponentSchema.parse({
        key: input.key,
        type: "skill",
        name: validated.name,
        payload: validated.payload,
        bundle: { attachmentId: input.bundleAttachmentId, format: "zip", sizeBytes: meta.sizeBytes },
      }),
    );
  }
  return compiled;
}

/**
 * Prove one stored Skill component still matches its real bundle: the ZIP
 * validates, and the derived name, payload, and server-measured size equal
 * the persisted projection. Fails closed on any drift — a schema-valid row
 * whose summary no longer matches its bytes must never become adoptable.
 */
export async function assertSkillComponentMatchesBundle(
  db: Database,
  blobStore: AttachmentBlobStore,
  publisherOrgId: string,
  component: Extract<AgentTemplateComponent, { type: "skill" }>,
): Promise<void> {
  const meta = await loadAttachmentMeta(db, component.bundle.attachmentId);
  if (!meta || meta.organizationId !== publisherOrgId) {
    throw new ConflictError(
      "A Skill bundle referenced by this Agent Template is no longer available to the publisher organization.",
    );
  }
  const validated = await validateSkillBundle(db, blobStore, publisherOrgId, component.bundle.attachmentId);
  const drift =
    component.name !== validated.name ||
    !isDeepStrictEqual(component.payload, validated.payload) ||
    component.bundle.sizeBytes !== meta.sizeBytes;
  if (drift) {
    throw new ConflictError("A stored Skill projection no longer matches its bundle; repair the Template draft.");
  }
}

export async function createAgentTemplate(
  db: Database,
  blobStore: AttachmentBlobStore,
  scope: AgentTemplatePublisherScope,
  input: CreateAgentTemplate,
): Promise<AgentTemplateDetail> {
  return db.transaction(async (tx) => {
    const targetDb = tx as unknown as Database;
    const components = await compileTemplateComponents(targetDb, blobStore, scope.organizationId, input.components);
    const payload = agentTemplatePayloadSchema.parse({ schemaVersion: 1, public: input.public, components });
    try {
      const [row] = await targetDb
        .insert(agentTemplates)
        .values({
          id: uuidv7(),
          slug: input.slug,
          name: input.name,
          status: "draft",
          payload,
          createdBy: scope.memberId,
          updatedBy: scope.memberId,
        })
        .returning(templateDetailSelection());
      if (!row) throw new Error("Agent Template insert returned no row");
      return toTemplateDetail(row);
    } catch (error) {
      if (postgresErrorCode(error) === "23505") {
        throw new ConflictError(`An Agent Template with slug "${input.slug}" already exists.`);
      }
      throw error;
    }
  });
}

export async function updateAgentTemplate(
  db: Database,
  blobStore: AttachmentBlobStore,
  scope: AgentTemplatePublisherScope,
  templateId: string,
  input: UpdateAgentTemplate,
): Promise<AgentTemplateDetail> {
  const releasedBundleIds: string[] = [];
  const detail = await db.transaction(async (tx) => {
    const targetDb = tx as unknown as Database;
    const [row] = await targetDb
      .select(templateDetailSelection())
      .from(agentTemplates)
      .where(eq(agentTemplates.id, templateId))
      .for("update")
      .limit(1);
    if (!row) throw new NotFoundError(`Agent Template "${templateId}" not found`);
    assertFresh(row, input.expectedUpdatedAt);
    if (row.status === "retired") {
      throw new ConflictError("A retired Agent Template cannot be updated.");
    }
    if (input.slug !== undefined && input.slug !== row.slug && row.status !== "draft") {
      throw new ConflictError("Agent Template slugs are immutable after first publish.");
    }

    const previousPayload = agentTemplatePayloadSchema.parse(row.payload);
    let payload = previousPayload;
    if (input.public !== undefined || input.components !== undefined) {
      const components = input.components
        ? await compileTemplateComponents(targetDb, blobStore, scope.organizationId, input.components)
        : previousPayload.components;
      payload = agentTemplatePayloadSchema.parse({
        schemaVersion: 1,
        public: input.public ?? previousPayload.public,
        components,
      });
    }

    try {
      const [updated] = await targetDb
        .update(agentTemplates)
        .set({
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          payload,
          updatedBy: scope.memberId,
          updatedAt: nextMutationTimestamp(),
        })
        .where(eq(agentTemplates.id, templateId))
        .returning(templateDetailSelection());
      if (!updated) throw new Error("Agent Template update returned no row");

      if (input.components !== undefined) {
        const kept = new Set(skillBundleIds(payload.components));
        for (const component of previousPayload.components) {
          if (component.type === "skill" && !kept.has(component.bundle.attachmentId)) {
            releasedBundleIds.push(component.bundle.attachmentId);
          }
        }
      }
      return toTemplateDetail(updated);
    } catch (error) {
      if (postgresErrorCode(error) === "23505") {
        throw new ConflictError(`An Agent Template with slug "${input.slug ?? ""}" already exists.`);
      }
      throw error;
    }
  });
  // GC only after a successful commit; cleanup failures must not turn the
  // committed update into an error response (see releaseTemplateBundles).
  await releaseTemplateBundles(db, blobStore, releasedBundleIds);
  return detail;
}

export async function publishAgentTemplate(
  db: Database,
  blobStore: AttachmentBlobStore,
  scope: AgentTemplatePublisherScope,
  templateId: string,
  input: PublishAgentTemplate,
): Promise<AgentTemplateDetail> {
  return db.transaction(async (tx) => {
    const targetDb = tx as unknown as Database;
    const [row] = await targetDb
      .select(templateDetailSelection())
      .from(agentTemplates)
      .where(eq(agentTemplates.id, templateId))
      .for("update")
      .limit(1);
    if (!row) throw new NotFoundError(`Agent Template "${templateId}" not found`);
    assertFresh(row, input.expectedUpdatedAt);
    if (row.status !== "draft") {
      throw new ConflictError("Only a draft Agent Template can be published.");
    }

    // Re-validate the full stored payload, then prove every stored Skill
    // projection still matches its real bundle before the Template becomes
    // adoptable.
    const payload = agentTemplatePayloadSchema.parse(row.payload);
    // A component-less draft is legal while drafting but can never be
    // adopted, so publish rejects it here instead of letting it reach the
    // public catalog and fail in adoption (see lockAndVerifyTemplate).
    if (payload.components.length === 0) {
      throw new ConflictError(`Agent Template "${templateId}" has no components and cannot be published.`);
    }
    await lockBundleAttachments(targetDb, skillBundleIds(payload.components));
    for (const component of payload.components) {
      if (component.type !== "skill") continue;
      await assertSkillComponentMatchesBundle(targetDb, blobStore, scope.organizationId, component);
    }

    const [updated] = await targetDb
      .update(agentTemplates)
      .set({ status: "active", updatedBy: scope.memberId, updatedAt: nextMutationTimestamp() })
      .where(eq(agentTemplates.id, templateId))
      .returning(templateDetailSelection());
    if (!updated) throw new Error("Agent Template publish returned no row");
    return toTemplateDetail(updated);
  });
}

export async function retireAgentTemplate(
  db: Database,
  scope: AgentTemplatePublisherScope,
  templateId: string,
  input: RetireAgentTemplate,
): Promise<AgentTemplateDetail> {
  return db.transaction(async (tx) => {
    const targetDb = tx as unknown as Database;
    if (input.replacementTemplateId === templateId) {
      throw new BadRequestError("An Agent Template cannot be its own replacement.");
    }
    // Lock the target and the replacement in a stable id order.
    const lockIds = [templateId, ...(input.replacementTemplateId ? [input.replacementTemplateId] : [])].sort();
    const locked = await targetDb
      .select(templateDetailSelection())
      .from(agentTemplates)
      .where(inArray(agentTemplates.id, lockIds))
      .orderBy(asc(agentTemplates.id))
      .for("update");
    const row = locked.find((candidate) => candidate.id === templateId);
    if (!row) throw new NotFoundError(`Agent Template "${templateId}" not found`);
    assertFresh(row, input.expectedUpdatedAt);
    if (row.status !== "active") {
      throw new ConflictError("Only an active Agent Template can be retired.");
    }
    if (input.replacementTemplateId) {
      const replacement = locked.find((candidate) => candidate.id === input.replacementTemplateId);
      if (!replacement || replacement.status !== "active") {
        throw new BadRequestError("The replacement must be another active Agent Template.");
      }
    }

    const [updated] = await targetDb
      .update(agentTemplates)
      .set({
        status: "retired",
        replacementTemplateId: input.replacementTemplateId ?? null,
        updatedBy: scope.memberId,
        updatedAt: nextMutationTimestamp(),
      })
      .where(eq(agentTemplates.id, templateId))
      .returning(templateDetailSelection());
    if (!updated) throw new Error("Agent Template retire returned no row");
    return toTemplateDetail(updated);
  });
}

export async function listAgentTemplates(db: Database): Promise<AgentTemplateDetailList> {
  const rows = await db
    .select(templateDetailSelection())
    .from(agentTemplates)
    .orderBy(asc(agentTemplates.name), asc(agentTemplates.slug));
  return { templates: rows.map(toTemplateDetail) };
}

export async function getAgentTemplate(db: Database, templateId: string): Promise<AgentTemplateDetail> {
  const [row] = await db
    .select(templateDetailSelection())
    .from(agentTemplates)
    .where(eq(agentTemplates.id, templateId))
    .limit(1);
  if (!row) throw new NotFoundError(`Agent Template "${templateId}" not found`);
  return toTemplateDetail(row);
}

/**
 * An active Template is adoptable only while every Skill bundle it
 * references is still a ready attachment with bytes — and, when the
 * publisher Team is configured, still owned by that Team. Anything else
 * fails closed out of the public discovery surface.
 */
async function templateBundlesAvailable(
  db: Database,
  payload: AgentTemplatePayload,
  publisherOrgId: string | undefined,
): Promise<boolean> {
  for (const attachmentId of skillBundleIds(payload.components)) {
    const meta = await loadAttachmentMeta(db, attachmentId);
    if (!meta) return false;
    if (publisherOrgId && meta.organizationId !== publisherOrgId) return false;
  }
  return true;
}

function toPublicTemplate(
  row: TemplateDetailRow,
  payload: AgentTemplatePayload,
  replacement: AgentTemplateReplacementSummary | null,
): AgentTemplatePublicTemplate | null {
  // The full public DTO is validated, not just the payload: a raw row whose
  // outer slug/name violates the public contract must fail closed the same
  // way a malformed payload does.
  const projected = agentTemplatePublicTemplateSchema.safeParse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status === "retired" ? "retired" : "active",
    public: payload.public,
    updatedAt: row.updatedAt,
    replacement,
  });
  return projected.success ? projected.data : null;
}

export async function listPublicAgentTemplates(
  db: Database,
  publisherOrgId: string | undefined,
): Promise<AgentTemplatePublicList> {
  const rows = await db
    .select(templateDetailSelection())
    .from(agentTemplates)
    .where(eq(agentTemplates.status, "active"))
    .orderBy(asc(agentTemplates.name), asc(agentTemplates.slug));
  const templates: AgentTemplatePublicTemplate[] = [];
  for (const row of rows) {
    // Fail closed: a malformed or unavailable active row must not leak raw
    // payload data into the public surface.
    const parsed = agentTemplatePayloadSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    if (!(await templateBundlesAvailable(db, parsed.data, publisherOrgId))) continue;
    const projected = toPublicTemplate(row, parsed.data, null);
    if (projected) templates.push(projected);
  }
  return { templates };
}

export async function getPublicAgentTemplate(
  db: Database,
  slug: string,
  publisherOrgId: string | undefined,
): Promise<AgentTemplatePublicTemplate> {
  const [row] = await db
    .select(templateDetailSelection())
    .from(agentTemplates)
    .where(eq(agentTemplates.slug, slug))
    .limit(1);
  if (!row || row.status === "draft") throw new NotFoundError("Agent Template not found");
  const parsed = agentTemplatePayloadSchema.safeParse(row.payload);
  if (!parsed.success) throw new NotFoundError("Agent Template not found");
  if (row.status === "active" && !(await templateBundlesAvailable(db, parsed.data, publisherOrgId))) {
    throw new NotFoundError("Agent Template not found");
  }
  const replacement =
    row.status === "retired" && row.replacementTemplateId
      ? await resolvePublicReplacement(db, row.replacementTemplateId, publisherOrgId)
      : null;
  const projected = toPublicTemplate(row, parsed.data, replacement);
  if (!projected) throw new NotFoundError("Agent Template not found");
  return projected;
}

/**
 * A retired Template publicly points at its replacement only while that
 * replacement is currently active and safe to adopt. The pointer degrades to
 * `null` when the replacement retired, turned malformed, or lost a bundle —
 * but the retired Template's own detail stays visible either way.
 */
async function resolvePublicReplacement(
  db: Database,
  replacementTemplateId: string,
  publisherOrgId: string | undefined,
): Promise<AgentTemplateReplacementSummary | null> {
  const [replacement] = await db
    .select({
      slug: agentTemplates.slug,
      name: agentTemplates.name,
      status: agentTemplates.status,
      payload: agentTemplates.payload,
    })
    .from(agentTemplates)
    .where(eq(agentTemplates.id, replacementTemplateId))
    .limit(1);
  if (!replacement || replacement.status !== "active") return null;
  const parsed = agentTemplatePayloadSchema.safeParse(replacement.payload);
  if (!parsed.success) return null;
  if (!(await templateBundlesAvailable(db, parsed.data, publisherOrgId))) return null;
  const summary = agentTemplateReplacementSummarySchema.safeParse({ slug: replacement.slug, name: replacement.name });
  return summary.success ? summary.data : null;
}

/**
 * Same-order public-safe summaries for an Agent's adopted Templates, for the
 * Agent Detail control plane. Deleted/draft/projection-invalid rows degrade
 * to `missing`; the read never reaches into the runtime config path.
 */
export async function buildAdoptedTemplateSummaries(
  db: Database,
  publisherOrgId: string | undefined,
  templateIds: readonly string[],
): Promise<AgentTemplateAdoptionSummary[]> {
  if (templateIds.length === 0) return [];
  // Without a configured Publisher Team the summaries cannot be proven
  // public-safe; degrade every entry to `missing` (same order) while the
  // resources/runtime read itself keeps working.
  if (!publisherOrgId) {
    return templateIds.map((id) => ({
      id,
      status: "missing",
      slug: null,
      name: null,
      public: null,
      replacement: null,
    }));
  }
  const rows = await db
    .select({
      id: agentTemplates.id,
      slug: agentTemplates.slug,
      name: agentTemplates.name,
      status: agentTemplates.status,
      payload: agentTemplates.payload,
      replacementTemplateId: agentTemplates.replacementTemplateId,
    })
    .from(agentTemplates)
    .where(inArray(agentTemplates.id, [...templateIds]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const summaries: AgentTemplateAdoptionSummary[] = [];
  for (const id of templateIds) {
    const row = byId.get(id);
    if (!row || row.status === "draft") {
      summaries.push({ id, status: "missing", slug: null, name: null, public: null, replacement: null });
      continue;
    }
    const parsed = agentTemplatePayloadSchema.safeParse(row.payload);
    if (!parsed.success) {
      summaries.push({ id, status: "missing", slug: null, name: null, public: null, replacement: null });
      continue;
    }
    const replacement =
      row.status === "retired" && row.replacementTemplateId
        ? await resolvePublicReplacement(db, row.replacementTemplateId, publisherOrgId)
        : null;
    // The whole public-safe projection must validate — a damaged outer
    // slug/name degrades to `missing` instead of leaking an off-contract
    // summary into Agent Detail.
    const candidate: AgentTemplateAdoptionSummary =
      row.status === "retired"
        ? { id, status: "retired", slug: row.slug, name: row.name, public: parsed.data.public, replacement }
        : { id, status: "active", slug: row.slug, name: row.name, public: parsed.data.public, replacement: null };
    const checked = agentTemplateAdoptionSummarySchema.safeParse(candidate);
    if (!checked.success) {
      summaries.push({ id, status: "missing", slug: null, name: null, public: null, replacement: null });
      continue;
    }
    summaries.push(checked.data);
  }
  return summaries;
}
