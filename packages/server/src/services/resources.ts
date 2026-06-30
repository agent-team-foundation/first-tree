import type { AgentRuntimeConfig } from "@first-tree/shared";
import {
  type AgentResourceBindingInput,
  type AgentResourcesOutput,
  type CreateTeamResource,
  canonicalizeResourceRepoUrl,
  deriveRepoLocalPath,
  type EffectiveAgentResources,
  type EffectiveResourceRow,
  findAssembledBriefingFingerprint,
  type GitRepo,
  getRepoLocalPathSafetyError,
  type NoSecretMcpServer,
  normalizeRepoLocalPath,
  noSecretMcpServerSchema,
  PROMPT_APPEND_MAX_LENGTH,
  type PromptSection,
  promptResourcePayloadSchema,
  type RepoResourcePayload,
  type ResourceImpactPreview,
  type ResourceImpactPreviewOutput,
  type ResourcePayload,
  type ResourceRow,
  type ResourceType,
  type ResourceUsageOutput,
  type RuntimeResourceSkill,
  repoResourcePayloadSchema,
  skillResourcePayloadSchema,
  type UpdateAgentResources,
  type UpdateTeamResource,
} from "@first-tree/shared";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { agents } from "../db/schema/agents.js";
import { members } from "../db/schema/members.js";
import { resources } from "../db/schema/resources.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import { getCampaignScanSkill } from "./campaign-scan-skill.js";
import type { Notifier } from "./notifier.js";

type ResourceDbRow = typeof resources.$inferSelect;
type BindingDbRow = typeof agentResourceBindings.$inferSelect;
type AgentSummary = { uuid: string; name: string | null; displayName: string };
type ResourceSimulation = { resources?: ResourceDbRow[] };

export type ResourcesService = {
  listTeamResources(organizationId: string): Promise<ResourceRow[]>;
  createTeamResource(organizationId: string, input: CreateTeamResource, actorId: string): Promise<ResourceRow>;
  getResource(resourceId: string): Promise<ResourceRow>;
  updateResource(resourceId: string, input: UpdateTeamResource, actorId: string): Promise<ResourceRow>;
  retireResource(resourceId: string, actorId: string): Promise<ResourceImpactPreviewOutput>;
  promoteResource(resourceId: string, actorId: string): Promise<ResourceRow>;
  getUsage(resourceId: string): Promise<ResourceUsageOutput>;
  previewOrgImpact(organizationId: string, input: ResourceImpactPreview): Promise<ResourceImpactPreviewOutput>;
  previewResourceImpact(resourceId: string, input: ResourceImpactPreview): Promise<ResourceImpactPreviewOutput>;
  getAgentResources(agentId: string): Promise<AgentResourcesOutput>;
  replaceAgentResources(agentId: string, input: UpdateAgentResources, actorId: string): Promise<AgentResourcesOutput>;
  /**
   * Idempotently provision a campaign's managed scan skill (server-owned
   * content) into the agent's org and bind it to the agent. Server-side so it
   * works for non-admin quickstart actors (the team-resource HTTP route is
   * admin-only); no-op for an unknown campaign slug.
   */
  ensureAndBindCampaignScanSkill(agentId: string, campaign: string, actorId: string): Promise<void>;
  resolveRuntimeConfig(config: AgentRuntimeConfig): Promise<AgentRuntimeConfig>;
  resolveEffectiveResources(agentId: string): Promise<EffectiveAgentResources>;
};

export type ResourcesServiceOptions = {
  db: Database;
  notifier: Notifier;
};

export function createResourcesService(opts: ResourcesServiceOptions): ResourcesService {
  const { db, notifier } = opts;

  async function notifyAgents(agentIds: Iterable<string>): Promise<void> {
    await Promise.allSettled(Array.from(new Set(agentIds)).map((id) => notifier.notifyConfigChange(`agent:${id}`)));
  }

  async function bumpAgentConfigVersions(
    targetDb: Database,
    agentIds: Iterable<string>,
    actorId: string,
  ): Promise<void> {
    const ids = Array.from(new Set(agentIds));
    if (ids.length === 0) return;
    await targetDb
      .update(agentConfigs)
      .set({
        version: sql`${agentConfigs.version} + 1`,
        updatedAt: new Date(),
        updatedBy: actorId,
      })
      .where(inArray(agentConfigs.agentId, ids));
  }

  async function listRuntimeAgentIds(organizationId: string): Promise<string[]> {
    const rows = await db
      .select({ uuid: agents.uuid })
      .from(agents)
      .where(and(eq(agents.organizationId, organizationId), ne(agents.status, "deleted"), ne(agents.type, "human")));
    return rows.map((r) => r.uuid);
  }

  async function listAgentsReferencingResource(resourceId: string): Promise<string[]> {
    const rows = await db
      .select({ agentId: agentResourceBindings.agentId })
      .from(agentResourceBindings)
      .where(
        or(eq(agentResourceBindings.resourceId, resourceId), eq(agentResourceBindings.replacesResourceId, resourceId)),
      );
    return rows.map((r) => r.agentId);
  }

  async function impactForResource(row: ResourceDbRow): Promise<string[]> {
    if (row.scope === "agent") return row.ownerAgentId ? [row.ownerAgentId] : [];
    if (row.defaultEnabled === "recommended") return listRuntimeAgentIds(row.organizationId);
    return listAgentsReferencingResource(row.id);
  }

  async function summarizeAgents(agentIds: Iterable<string>): Promise<AgentSummary[]> {
    const ids = Array.from(new Set(agentIds));
    if (ids.length === 0) return [];
    return db
      .select({ uuid: agents.uuid, name: agents.name, displayName: agents.displayName })
      .from(agents)
      .where(inArray(agents.uuid, ids));
  }

  async function buildImpactOutput(
    agentIds: Iterable<string>,
    simulation?: ResourceSimulation,
  ): Promise<ResourceImpactPreviewOutput> {
    const summaries = await summarizeAgents(agentIds);
    let overflow = 0;
    for (const agent of summaries) {
      const effective = await resolveEffectiveResources(agent.uuid, simulation);
      if (effective.unavailable.some((u) => u.reason === "prompt_budget_exceeded")) overflow++;
    }
    return {
      affectedAgentCount: summaries.length,
      promptOverflowAgentCount: overflow,
      agents: summaries,
    };
  }

  function rowToResource(row: ResourceDbRow): ResourceRow {
    return {
      id: row.id,
      organizationId: row.organizationId,
      type: row.type,
      scope: row.scope,
      ownerAgentId: row.ownerAgentId,
      name: row.name,
      repoCanonicalKey: row.repoCanonicalKey,
      defaultEnabled: row.defaultEnabled,
      status: row.status,
      payload: row.payload,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  function parsePayload(type: ResourceType, payload: unknown): ResourcePayload {
    if (type === "repo") return repoResourcePayloadSchema.parse(payload);
    if (type === "prompt") return promptResourcePayloadSchema.parse(payload);
    if (type === "skill") return skillResourcePayloadSchema.parse(payload);
    return noSecretMcpServerSchema.parse(payload);
  }

  function canonicalKeyFor(type: ResourceType, payload: ResourcePayload): string | null {
    if (type !== "repo") return null;
    const repoPayload = repoResourcePayloadSchema.parse(payload);
    return canonicalizeResourceRepoUrl(repoPayload.url);
  }

  function makePreviewTeamResource(args: {
    organizationId: string;
    id: string;
    type: ResourceType;
    name: string;
    scope?: "team" | "agent";
    ownerAgentId?: string | null;
    defaultEnabled: "available" | "recommended" | null;
    payload: ResourcePayload;
  }): ResourceDbRow {
    const now = new Date();
    return {
      id: args.id,
      organizationId: args.organizationId,
      type: args.type,
      scope: args.scope ?? "team",
      ownerAgentId: args.ownerAgentId ?? null,
      name: args.name,
      repoCanonicalKey: canonicalKeyFor(args.type, args.payload),
      defaultEnabled: args.defaultEnabled,
      status: "active",
      payload: args.payload,
      createdBy: "preview",
      updatedBy: "preview",
      createdAt: now,
      updatedAt: now,
    };
  }

  function defaultResourceName(input: AgentResourceBindingInput): string {
    if (input.agentExtraRepo?.name) return input.agentExtraRepo.name;
    if (input.agentExtraRepo?.url) return deriveRepoLocalPath(input.agentExtraRepo.url) || input.agentExtraRepo.url;
    return "Agent repo";
  }

  async function loadResource(resourceId: string): Promise<ResourceDbRow> {
    const [row] = await db.select().from(resources).where(eq(resources.id, resourceId)).limit(1);
    if (!row) throw new NotFoundError(`Resource "${resourceId}" not found`);
    return row;
  }

  async function loadAgent(agentId: string): Promise<{ uuid: string; organizationId: string; status: string }> {
    const [row] = await db
      .select({ uuid: agents.uuid, organizationId: agents.organizationId, status: agents.status })
      .from(agents)
      .where(eq(agents.uuid, agentId))
      .limit(1);
    if (!row || row.status === "deleted") throw new NotFoundError(`Agent "${agentId}" not found`);
    return row;
  }

  async function getConfigVersion(agentId: string): Promise<number> {
    const [row] = await db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agentId))
      .limit(1);
    if (!row) throw new NotFoundError(`Agent config "${agentId}" not found`);
    return row.version;
  }

  async function findOrCreateAgentRepoResource(
    targetDb: Database,
    agentId: string,
    organizationId: string,
    input: AgentResourceBindingInput,
    actorId: string,
  ): Promise<string> {
    const repo = input.agentExtraRepo;
    if (!repo) throw new BadRequestError("Missing agent extra repo input");
    const payload: RepoResourcePayload = {
      url: repo.url,
      ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch } : {}),
    };
    const canonical = canonicalizeResourceRepoUrl(repo.url);
    const [existing] = await targetDb
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          eq(resources.scope, "agent"),
          eq(resources.type, "repo"),
          eq(resources.ownerAgentId, agentId),
          eq(resources.repoCanonicalKey, canonical),
          inArray(resources.status, ["active", "stale"]),
        ),
      )
      .limit(1);
    if (existing) return existing.id;
    const id = uuidv7();
    await targetDb.insert(resources).values({
      id,
      organizationId,
      type: "repo",
      scope: "agent",
      ownerAgentId: agentId,
      name: defaultResourceName(input),
      repoCanonicalKey: canonical,
      defaultEnabled: null,
      status: "active",
      payload,
      createdBy: actorId,
      updatedBy: actorId,
    });
    return id;
  }

  async function validateBindingReference(
    targetDb: Database,
    agentId: string,
    organizationId: string,
    input: AgentResourceBindingInput,
  ): Promise<void> {
    const ids = [input.resourceId, input.replacesResourceId].filter((id): id is string => !!id);
    if (ids.length === 0) return;
    const rows = await targetDb.select().from(resources).where(inArray(resources.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const resource = byId.get(id);
      if (!resource || resource.organizationId !== organizationId || resource.status === "retired") {
        throw new BadRequestError(`Resource "${id}" is not available to this agent`);
      }
      if (resource.type !== input.type) {
        throw new BadRequestError(`Resource "${id}" has type "${resource.type}", expected "${input.type}"`);
      }
      if ((input.mode === "disable" || input.replacesResourceId === id) && resource.scope !== "team") {
        throw new BadRequestError(`Resource "${id}" is not a Team resource`);
      }
      if (resource.scope === "agent" && resource.ownerAgentId !== agentId) {
        throw new BadRequestError(`Agent-scoped resource "${id}" is not owned by this agent`);
      }
      if (resource.scope === "agent" && resource.type !== "repo") {
        throw new BadRequestError("Only repo resources may be agent-scoped in Phase 1");
      }
    }
  }

  function bindingToInput(row: BindingDbRow): AgentResourceBindingInput {
    return {
      id: row.id,
      type: row.type,
      mode: row.mode,
      resourceId: row.resourceId,
      replacesResourceId: row.replacesResourceId,
      inlinePromptBody: row.inlinePromptBody,
      repoRef: row.repoRef,
      repoLocalPath: row.repoLocalPath,
      order: row.order,
    };
  }

  function resourceSource(row: ResourceDbRow | null, inline: boolean): EffectiveResourceRow["source"] {
    if (inline) return "inline_prompt";
    if (!row) return "team_available";
    if (row.scope === "agent") return "agent_extra";
    return row.defaultEnabled === "recommended" ? "team_recommended" : "team_available";
  }

  function emptyRow(args: {
    id: string;
    bindingId: string | null;
    resource: ResourceDbRow | null;
    type: ResourceType;
    name: string;
    source: EffectiveResourceRow["source"];
    mode: EffectiveResourceRow["mode"];
    order: number;
    replacesResourceId?: string | null;
    promptBody?: string | null;
    repo?: GitRepo | null;
    unavailableReason?: string | null;
  }): EffectiveResourceRow {
    return {
      id: args.id,
      bindingId: args.bindingId,
      resourceId: args.resource?.id ?? null,
      replacesResourceId: args.replacesResourceId ?? null,
      type: args.type,
      name: args.name,
      scope: args.resource?.scope ?? null,
      source: args.source,
      mode: args.mode,
      defaultEnabled: args.resource?.defaultEnabled ?? null,
      payload: args.resource?.payload ?? null,
      repo: args.repo ?? null,
      promptBody: args.promptBody ?? null,
      unavailableReason: args.unavailableReason ?? null,
      order: args.order,
    };
  }

  function repoRuntimeRow(resource: ResourceDbRow, binding: BindingDbRow | null): GitRepo | null {
    const payload = repoResourcePayloadSchema.safeParse(resource.payload);
    if (!payload.success) return null;
    const localPath = normalizedBindingLocalPath(binding?.repoLocalPath);
    return {
      url: payload.data.url,
      ...(binding?.repoRef
        ? { ref: binding.repoRef }
        : payload.data.defaultBranch
          ? { ref: payload.data.defaultBranch }
          : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  /**
   * Normalize a persisted `agent_resource_bindings.repo_local_path` the SAME
   * way the binding-input schema does on write
   * (`@first-tree/shared` `normalizeRepoLocalPath` + safety check), so the
   * runtime `GitRepo` carries a single workspace-immediate segment regardless
   * of when the row was written.
   *
   * The binding-input schema transforms+validates on WRITE, but a row persisted
   * before that narrowing (e.g. a legacy nested `services/api`) reaches this
   * read path raw. Without this, the client receives the raw value while the
   * briefing's `resolveGitRepoTargetPath` re-normalizes it — leaving briefing,
   * `workspace.json` manifest, and `applyRepoLocalPathDedup` disagreeing on the
   * name for one binding (PR #1048 reviewer blocker).
   *
   * A value that does not reduce to a SAFE single segment is treated as "no
   * usable override" → dropped, so the repo falls back to the URL-derived name
   * (`deriveRepoLocalPath`) everywhere. Graceful: a malformed legacy row never
   * throws on read.
   */
  function normalizedBindingLocalPath(raw: string | null | undefined): string | undefined {
    if (!raw) return undefined;
    const normalized = normalizeRepoLocalPath(raw);
    return getRepoLocalPathSafetyError(normalized) ? undefined : normalized;
  }

  function promptBody(resource: ResourceDbRow): string | null {
    const parsed = promptResourcePayloadSchema.safeParse(resource.payload);
    return parsed.success ? parsed.data.body : null;
  }

  async function resolveEffectiveResources(
    agentId: string,
    simulation?: ResourceSimulation,
  ): Promise<EffectiveAgentResources> {
    const agent = await loadAgent(agentId);
    const version = await getConfigVersion(agentId);
    let resourceRows = await db
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, agent.organizationId),
          inArray(resources.status, ["active", "stale"]),
          or(eq(resources.scope, "team"), eq(resources.ownerAgentId, agentId)),
        ),
      );
    if (simulation?.resources?.length) {
      const simulatedById = new Map(resourceRows.map((row) => [row.id, row]));
      for (const resource of simulation.resources) {
        if (resource.organizationId !== agent.organizationId) continue;
        if (resource.status === "retired") {
          simulatedById.delete(resource.id);
          continue;
        }
        if (resource.scope === "team" || resource.ownerAgentId === agentId) {
          simulatedById.set(resource.id, resource);
        }
      }
      resourceRows = Array.from(simulatedById.values());
    }
    const bindings = await db
      .select()
      .from(agentResourceBindings)
      .where(eq(agentResourceBindings.agentId, agentId))
      .orderBy(agentResourceBindings.order, agentResourceBindings.createdAt);

    const byId = new Map(resourceRows.map((r) => [r.id, r]));
    const disabled = new Set<string>();
    const replaced = new Set<string>();
    const explicitlyBound = new Set<string>();
    for (const binding of bindings) {
      if (binding.mode === "disable" && binding.resourceId) disabled.add(binding.resourceId);
      if (binding.mode === "replace" && binding.replacesResourceId) replaced.add(binding.replacesResourceId);
      if (binding.mode !== "disable" && binding.resourceId) explicitlyBound.add(binding.resourceId);
    }

    const repos: EffectiveResourceRow[] = [];
    const prompts: EffectiveResourceRow[] = [];
    const skills: EffectiveResourceRow[] = [];
    const mcp: EffectiveResourceRow[] = [];

    function bucket(type: ResourceType): EffectiveResourceRow[] {
      if (type === "repo") return repos;
      if (type === "prompt") return prompts;
      if (type === "skill") return skills;
      return mcp;
    }

    for (const resource of resourceRows) {
      if (resource.scope !== "team" || resource.defaultEnabled !== "recommended") continue;
      if (disabled.has(resource.id) || replaced.has(resource.id) || explicitlyBound.has(resource.id)) continue;
      const runtimeRepo = resource.type === "repo" ? repoRuntimeRow(resource, null) : null;
      bucket(resource.type).push(
        emptyRow({
          id: `resource:${resource.id}`,
          bindingId: null,
          resource,
          type: resource.type,
          name: resource.name,
          source: "team_recommended",
          mode: "enabled",
          order: 0,
          repo: runtimeRepo,
          promptBody: resource.type === "prompt" ? promptBody(resource) : null,
        }),
      );
    }

    for (const binding of bindings) {
      if (binding.mode === "disable") {
        const resource = binding.resourceId ? byId.get(binding.resourceId) : null;
        if (!resource) continue;
        bucket(binding.type).push(
          emptyRow({
            id: `binding:${binding.id}:disabled`,
            bindingId: binding.id,
            resource,
            type: binding.type,
            name: resource.name,
            source: resourceSource(resource, false),
            mode: "disabled",
            order: binding.order,
          }),
        );
        continue;
      }

      const replacedResource = binding.replacesResourceId ? byId.get(binding.replacesResourceId) : null;
      if (binding.mode === "replace") {
        if (replacedResource) {
          bucket(binding.type).push(
            emptyRow({
              id: `binding:${binding.id}:replaced`,
              bindingId: binding.id,
              resource: replacedResource,
              type: binding.type,
              name: replacedResource.name,
              source: resourceSource(replacedResource, false),
              mode: "replaced",
              order: binding.order,
              replacesResourceId: binding.replacesResourceId,
            }),
          );
        }
      }

      const resource = binding.resourceId ? byId.get(binding.resourceId) : null;
      const inlinePrompt = binding.type === "prompt" && binding.inlinePromptBody ? binding.inlinePromptBody : null;
      if (!resource && !inlinePrompt) continue;
      const row = emptyRow({
        id: `binding:${binding.id}:enabled`,
        bindingId: binding.id,
        resource: resource ?? null,
        type: binding.type,
        // An inline *replacement* keeps the replaced team prompt's name so
        // downstream consumers (sections projection, CLI) can say which team
        // slot the agent-specific body stands in for.
        name: resource?.name ?? replacedResource?.name ?? "Inline prompt",
        source: resourceSource(resource ?? null, !!inlinePrompt),
        mode: "enabled",
        order: binding.order,
        replacesResourceId: binding.replacesResourceId,
        repo: resource && binding.type === "repo" ? repoRuntimeRow(resource, binding) : null,
        promptBody: inlinePrompt ?? (resource && binding.type === "prompt" ? promptBody(resource) : null),
      });
      bucket(binding.type).push(row);
    }

    const unavailable: EffectiveAgentResources["unavailable"] = [];
    applyPromptBudget(prompts, unavailable);
    applyRepoLocalPathDedup(repos, unavailable);
    applyPayloadValidation(skills, mcp, unavailable);

    return {
      version,
      repos,
      prompts,
      skills,
      mcp,
      unavailable,
    };
  }

  function applyPromptBudget(rows: EffectiveResourceRow[], unavailable: EffectiveAgentResources["unavailable"]): void {
    let combined = "";
    let overflow = false;
    for (const row of rows.sort((a, b) => a.order - b.order)) {
      if (row.mode !== "enabled") continue;
      const body = row.promptBody ?? "";
      const rendered = renderPromptRow(row.name, row.source, body);
      if (overflow || combined.length + rendered.length > PROMPT_APPEND_MAX_LENGTH) {
        row.mode = "unavailable";
        row.unavailableReason = "prompt_budget_exceeded";
        unavailable.push({
          type: "prompt",
          id: row.resourceId ?? row.bindingId ?? row.id,
          reason: "prompt_budget_exceeded",
        });
        overflow = true;
        continue;
      }
      combined += rendered;
    }
  }

  function applyRepoLocalPathDedup(
    rows: EffectiveResourceRow[],
    unavailable: EffectiveAgentResources["unavailable"],
  ): void {
    const seen = new Set<string>();
    for (const row of rows.sort((a, b) => a.order - b.order)) {
      if (row.mode !== "enabled" || !row.repo) continue;
      const localPath = row.repo.localPath ?? deriveRepoLocalPath(row.repo.url);
      if (!localPath) continue;
      if (seen.has(localPath)) {
        row.mode = "unavailable";
        row.unavailableReason = "duplicate_local_path";
        unavailable.push({
          type: "repo",
          id: row.resourceId ?? row.bindingId ?? row.id,
          reason: "duplicate_local_path",
        });
      }
      seen.add(localPath);
    }
  }

  function applyPayloadValidation(
    skillRows: EffectiveResourceRow[],
    mcpRows: EffectiveResourceRow[],
    unavailable: EffectiveAgentResources["unavailable"],
  ): void {
    for (const row of skillRows) {
      if (row.mode !== "enabled") continue;
      const parsed = skillResourcePayloadSchema.safeParse(row.payload);
      if (parsed.success) continue;
      row.mode = "unavailable";
      row.unavailableReason = "invalid_skill_payload";
      unavailable.push({
        type: "skill",
        id: row.resourceId ?? row.bindingId ?? row.id,
        reason: "invalid_skill_payload",
      });
    }
    for (const row of mcpRows) {
      if (row.mode !== "enabled") continue;
      const parsed = noSecretMcpServerSchema.safeParse(row.payload);
      if (parsed.success) continue;
      row.mode = "unavailable";
      row.unavailableReason = "invalid_mcp_payload";
      unavailable.push({ type: "mcp", id: row.resourceId ?? row.bindingId ?? row.id, reason: "invalid_mcp_payload" });
    }
  }

  function renderPromptRow(name: string, source: EffectiveResourceRow["source"], body: string): string {
    const title = source === "inline_prompt" ? "Agent Prompt (this agent only)" : `Team Prompt: ${name}`;
    return `\n\n## ${title}\n\n${body.trim()}\n`;
  }

  function runtimePromptAppend(rows: EffectiveResourceRow[]): string {
    return rows
      .filter((row) => row.mode === "enabled" && row.promptBody)
      .sort((a, b) => a.order - b.order)
      .map((row) => renderPromptRow(row.name, row.source, row.promptBody ?? ""))
      .join("")
      .trim();
  }

  function promptSectionScope(source: EffectiveResourceRow["source"]): PromptSection["scope"] {
    return source === "inline_prompt" || source === "agent_extra" ? "agent" : "team";
  }

  /**
   * Structured projection of the effective prompt stack. `append` (above)
   * stays as the legacy merged string for older clients; new clients render
   * these sections under provenance-labelled briefing headings (`# Team
   * Prompt` / `# Agent Prompt`) so team-shared content is never presented
   * as part of the agent's own editable prompt.
   *
   * `editable` is true only for the standalone inline fragment — the one row
   * `agent config prompt set` owns. Inline *replacements* of team prompts
   * (and any agent-scoped prompt resources) are agent-specific but managed
   * via resource bindings; labelling them editable would instruct an agent
   * to use a flow that cannot touch them.
   */
  function runtimePromptSections(rows: EffectiveResourceRow[]): PromptSection[] {
    return rows
      .filter((row) => row.mode === "enabled" && row.promptBody)
      .sort((a, b) => a.order - b.order)
      .map((row) => {
        const editable = row.source === "inline_prompt" && !row.replacesResourceId;
        return {
          scope: promptSectionScope(row.source),
          name: editable ? "" : row.name,
          body: (row.promptBody ?? "").trim(),
          editable,
        };
      });
  }

  function runtimeSkills(rows: EffectiveResourceRow[]): RuntimeResourceSkill[] {
    return rows
      .filter((row) => row.mode === "enabled" && row.resourceId)
      .map((row) => {
        const payload = skillResourcePayloadSchema.parse(row.payload);
        return {
          resourceId: row.resourceId ?? "",
          name: payload.name,
          description: payload.description,
          body: payload.body,
          metadata: payload.metadata,
        };
      });
  }

  function runtimeMcp(rows: EffectiveResourceRow[]): NoSecretMcpServer[] {
    return rows.filter((row) => row.mode === "enabled").map((row) => noSecretMcpServerSchema.parse(row.payload));
  }

  async function resolveRuntimeConfig(config: AgentRuntimeConfig): Promise<AgentRuntimeConfig> {
    const effective = await resolveEffectiveResources(config.agentId);
    const resolvedPrompt = runtimePromptAppend(effective.prompts);
    const resolvedMcp = runtimeMcp(effective.mcp);
    return {
      ...config,
      version: effective.version,
      payload: {
        ...config.payload,
        gitRepos: effective.repos
          .filter((row) => row.mode === "enabled" && row.repo)
          .map((row) => row.repo)
          .filter((repo): repo is GitRepo => repo !== null),
        prompt: {
          ...config.payload.prompt,
          append: resolvedPrompt,
          sections: runtimePromptSections(effective.prompts),
        },
        mcpServers:
          effective.mcp.length === 0 && config.payload.mcpServers.length > 0 ? config.payload.mcpServers : resolvedMcp,
        resourceSkills: runtimeSkills(effective.skills),
      },
    };
  }

  /**
   * Reject inline prompt bodies that are copies of the generated agent
   * briefing (AGENTS.md). The briefing's banner carries the literal
   * `first-tree:generated` marker — its presence in a prompt write means the
   * caller pasted the assembled file (team-shared + runtime-injected
   * content) instead of the per-agent fragment. Only the conclusive marker
   * tier is enforced here; heading heuristics stay CLI-side where `--force`
   * can override them.
   */
  function validateInlinePromptBodies(bindings: readonly AgentResourceBindingInput[]): void {
    for (const binding of bindings) {
      if (binding.type !== "prompt" || !binding.inlinePromptBody) continue;
      const fingerprint = findAssembledBriefingFingerprint(binding.inlinePromptBody);
      if (fingerprint?.kind !== "generated-marker") continue;
      throw new BadRequestError(
        `Inline prompt body contains the generated-briefing marker "${fingerprint.match}" — ` +
          "this looks like a copy of the assembled AGENTS.md, which mixes team-shared and " +
          "runtime-injected content into the per-agent prompt. Fetch the editable fragment with " +
          "`agent config prompt show <agent> --raw`, edit that, and write it back with " +
          "`agent config prompt set <agent>`.",
        { code: "assembled_briefing_in_prompt" },
      );
    }
  }

  function validateInputRepoLocalPaths(bindings: readonly AgentResourceBindingInput[]): void {
    const seen = new Set<string>();
    for (const binding of bindings) {
      if (binding.type !== "repo" || binding.mode === "disable") continue;
      const localPath =
        binding.repoLocalPath ?? (binding.agentExtraRepo ? deriveRepoLocalPath(binding.agentExtraRepo.url) : "");
      if (!localPath) continue;
      if (seen.has(localPath)) throw new BadRequestError(`Duplicate repo localPath "${localPath}"`);
      seen.add(localPath);
    }
  }

  function postgresErrorCode(err: unknown): string {
    const direct = (err as { code?: unknown })?.code;
    if (typeof direct === "string") return direct;
    const cause = (err as { cause?: { code?: unknown } })?.cause?.code;
    return typeof cause === "string" ? cause : "";
  }

  return {
    async listTeamResources(organizationId) {
      const rows = await db
        .select()
        .from(resources)
        .where(
          and(
            eq(resources.organizationId, organizationId),
            eq(resources.scope, "team"),
            ne(resources.status, "retired"),
          ),
        )
        .orderBy(resources.type, resources.name);
      return rows.map(rowToResource);
    },

    async createTeamResource(organizationId, input, actorId) {
      const payload = parsePayload(input.type, input.payload);
      const repoCanonicalKey = canonicalKeyFor(input.type, payload);
      const id = uuidv7();
      let impacted: string[] = [];
      try {
        await db.transaction(async (tx) => {
          const targetDb = tx as unknown as Database;
          await targetDb.insert(resources).values({
            id,
            organizationId,
            type: input.type,
            scope: "team",
            ownerAgentId: null,
            name: input.name,
            repoCanonicalKey,
            defaultEnabled: input.defaultEnabled,
            status: "active",
            payload,
            createdBy: actorId,
            updatedBy: actorId,
          });
          if (input.defaultEnabled === "recommended") {
            impacted = await listRuntimeAgentIds(organizationId);
            await bumpAgentConfigVersions(targetDb, impacted, actorId);
          }
        });
      } catch (err) {
        if (postgresErrorCode(err) === "23505") throw new ConflictError("A matching resource already exists");
        throw err;
      }
      await notifyAgents(impacted);
      return rowToResource(await loadResource(id));
    },

    async getResource(resourceId) {
      return rowToResource(await loadResource(resourceId));
    },

    async updateResource(resourceId, input, actorId) {
      const current = await loadResource(resourceId);
      if (current.scope !== "team") {
        throw new BadRequestError("Agent-scoped resources can only be changed through Agent Resources");
      }
      if (input.status === "retired") {
        throw new BadRequestError("Use DELETE /api/v1/resources/:resourceId to retire resources");
      }
      const payload = input.payload === undefined ? current.payload : parsePayload(current.type, input.payload);
      const repoCanonicalKey = canonicalKeyFor(current.type, payload);
      const impactedSet = new Set(await impactForResource(current));
      if (input.defaultEnabled === "recommended") {
        for (const agentId of await listRuntimeAgentIds(current.organizationId)) impactedSet.add(agentId);
      }
      const impacted = Array.from(impactedSet);
      try {
        await db.transaction(async (tx) => {
          const targetDb = tx as unknown as Database;
          await targetDb
            .update(resources)
            .set({
              ...(input.name ? { name: input.name } : {}),
              ...(input.defaultEnabled ? { defaultEnabled: input.defaultEnabled } : {}),
              ...(input.status ? { status: input.status } : {}),
              payload,
              repoCanonicalKey,
              updatedBy: actorId,
              updatedAt: new Date(),
            })
            .where(eq(resources.id, resourceId));
          await bumpAgentConfigVersions(targetDb, impacted, actorId);
        });
      } catch (err) {
        if (postgresErrorCode(err) === "23505") throw new ConflictError("A matching resource already exists");
        throw err;
      }
      await notifyAgents(impacted);
      return rowToResource(await loadResource(resourceId));
    },

    async retireResource(resourceId, actorId) {
      const current = await loadResource(resourceId);
      const impacted = await impactForResource(current);
      await db.transaction(async (tx) => {
        const targetDb = tx as unknown as Database;
        await targetDb
          .update(resources)
          .set({ status: "retired", updatedBy: actorId, updatedAt: new Date() })
          .where(eq(resources.id, resourceId));
        await targetDb
          .delete(agentResourceBindings)
          .where(
            or(
              eq(agentResourceBindings.resourceId, resourceId),
              eq(agentResourceBindings.replacesResourceId, resourceId),
            ),
          );
        await bumpAgentConfigVersions(targetDb, impacted, actorId);
      });
      await notifyAgents(impacted);
      return buildImpactOutput(impacted);
    },

    async promoteResource(resourceId, actorId) {
      const current = await loadResource(resourceId);
      if (current.scope !== "agent" || current.type !== "repo" || !current.ownerAgentId || !current.repoCanonicalKey) {
        throw new BadRequestError("Only agent-scoped repo resources can be promoted");
      }
      const canonicalKey = current.repoCanonicalKey;
      let teamResourceId = "";
      let impacted: string[] = [];
      await db.transaction(async (tx) => {
        const targetDb = tx as unknown as Database;
        const [existingTeam] = await targetDb
          .select()
          .from(resources)
          .where(
            and(
              eq(resources.organizationId, current.organizationId),
              eq(resources.scope, "team"),
              eq(resources.type, "repo"),
              eq(resources.repoCanonicalKey, canonicalKey),
              inArray(resources.status, ["active", "stale"]),
            ),
          )
          .limit(1);
        if (existingTeam) {
          teamResourceId = existingTeam.id;
        } else {
          teamResourceId = uuidv7();
          await targetDb.insert(resources).values({
            id: teamResourceId,
            organizationId: current.organizationId,
            type: "repo",
            scope: "team",
            ownerAgentId: null,
            name: current.name,
            repoCanonicalKey: canonicalKey,
            defaultEnabled: "available",
            status: "active",
            payload: current.payload,
            createdBy: actorId,
            updatedBy: actorId,
          });
        }

        const agentScopedRows = await targetDb
          .select({ id: resources.id })
          .from(resources)
          .where(
            and(
              eq(resources.organizationId, current.organizationId),
              eq(resources.scope, "agent"),
              eq(resources.type, "repo"),
              eq(resources.repoCanonicalKey, canonicalKey),
              inArray(resources.status, ["active", "stale"]),
            ),
          );
        const agentResourceIds = agentScopedRows.map((r) => r.id);
        if (agentResourceIds.length > 0) {
          const bindingRows = await targetDb
            .select({ agentId: agentResourceBindings.agentId })
            .from(agentResourceBindings)
            .where(inArray(agentResourceBindings.resourceId, agentResourceIds));
          impacted = bindingRows.map((r) => r.agentId);
          await targetDb
            .update(agentResourceBindings)
            .set({ resourceId: teamResourceId, updatedBy: actorId, updatedAt: new Date() })
            .where(inArray(agentResourceBindings.resourceId, agentResourceIds));
          await targetDb
            .update(resources)
            .set({ status: "retired", updatedBy: actorId, updatedAt: new Date() })
            .where(inArray(resources.id, agentResourceIds));
        }
        await bumpAgentConfigVersions(targetDb, impacted, actorId);
      });
      await notifyAgents(impacted);
      return rowToResource(await loadResource(teamResourceId));
    },

    async getUsage(resourceId) {
      const current = await loadResource(resourceId);
      const agentIds = await impactForResource(current);
      const summaries = await summarizeAgents(agentIds);
      return { resourceId, agentCount: summaries.length, agents: summaries };
    },

    async previewOrgImpact(organizationId, input) {
      if (input.defaultEnabled === "recommended") {
        const simulation =
          input.type && input.payload !== undefined
            ? {
                resources: [
                  makePreviewTeamResource({
                    organizationId,
                    id: "preview:new-resource",
                    type: input.type,
                    name: "Preview resource",
                    defaultEnabled: "recommended",
                    payload: parsePayload(input.type, input.payload),
                  }),
                ],
              }
            : undefined;
        return buildImpactOutput(await listRuntimeAgentIds(organizationId), simulation);
      }
      return { affectedAgentCount: 0, promptOverflowAgentCount: 0, agents: [] };
    },

    async previewResourceImpact(resourceId, input) {
      const current = await loadResource(resourceId);
      const payload = input.payload === undefined ? current.payload : parsePayload(current.type, input.payload);
      const preview = makePreviewTeamResource({
        organizationId: current.organizationId,
        id: current.id,
        type: current.type,
        name: current.name,
        scope: current.scope,
        ownerAgentId: current.ownerAgentId,
        defaultEnabled: input.defaultEnabled ?? current.defaultEnabled,
        payload,
      });
      const impactedSet = new Set(await impactForResource(current));
      if (preview.defaultEnabled === "recommended") {
        for (const agentId of await listRuntimeAgentIds(current.organizationId)) impactedSet.add(agentId);
      }
      return buildImpactOutput(impactedSet, { resources: [preview] });
    },

    async getAgentResources(agentId) {
      const agent = await loadAgent(agentId);
      const effective = await resolveEffectiveResources(agentId);
      const bindingRows = await db
        .select()
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, agentId))
        .orderBy(agentResourceBindings.order, agentResourceBindings.createdAt);
      const availableTeamResources = await db
        .select()
        .from(resources)
        .where(
          and(
            eq(resources.organizationId, agent.organizationId),
            eq(resources.scope, "team"),
            inArray(resources.status, ["active", "stale"]),
          ),
        )
        .orderBy(resources.type, resources.name);
      return {
        version: effective.version,
        effective,
        bindings: bindingRows.map(bindingToInput),
        availableTeamResources: availableTeamResources.map(rowToResource),
      };
    },

    async replaceAgentResources(agentId, input, actorId) {
      const agent = await loadAgent(agentId);
      validateInputRepoLocalPaths(input.bindings);
      validateInlinePromptBodies(input.bindings);
      await db.transaction(async (tx) => {
        const targetDb = tx as unknown as Database;
        const [updatedConfig] = await targetDb
          .update(agentConfigs)
          .set({
            version: sql`${agentConfigs.version} + 1`,
            updatedAt: new Date(),
            updatedBy: actorId,
          })
          .where(and(eq(agentConfigs.agentId, agentId), eq(agentConfigs.version, input.expectedVersion)))
          .returning({ version: agentConfigs.version });
        if (!updatedConfig) {
          const [current] = await targetDb
            .select({ version: agentConfigs.version })
            .from(agentConfigs)
            .where(eq(agentConfigs.agentId, agentId))
            .limit(1);
          throw new ConflictError(
            `Agent resources "${agentId}" version mismatch: expected ${input.expectedVersion}, got ${current?.version ?? "missing"}`,
          );
        }
        await targetDb.delete(agentResourceBindings).where(eq(agentResourceBindings.agentId, agentId));
        for (let idx = 0; idx < input.bindings.length; idx++) {
          const binding = input.bindings[idx];
          if (!binding) continue;
          await validateBindingReference(targetDb, agentId, agent.organizationId, binding);
          const resourceId = binding.agentExtraRepo
            ? await findOrCreateAgentRepoResource(targetDb, agentId, agent.organizationId, binding, actorId)
            : (binding.resourceId ?? null);
          await targetDb.insert(agentResourceBindings).values({
            id: uuidv7(),
            organizationId: agent.organizationId,
            agentId,
            type: binding.type,
            mode: binding.mode,
            resourceId,
            replacesResourceId: binding.replacesResourceId ?? null,
            inlinePromptBody: binding.inlinePromptBody ?? null,
            repoRef: binding.repoRef ?? null,
            repoLocalPath: binding.repoLocalPath ?? null,
            order: binding.order ?? idx + 1,
            createdBy: actorId,
            updatedBy: actorId,
          });
        }
      });
      await notifyAgents([agentId]);
      const effective = await resolveEffectiveResources(agentId);
      const bindingRows = await db
        .select()
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, agentId))
        .orderBy(agentResourceBindings.order, agentResourceBindings.createdAt);
      const availableTeamResources = await db
        .select()
        .from(resources)
        .where(
          and(
            eq(resources.organizationId, agent.organizationId),
            eq(resources.scope, "team"),
            inArray(resources.status, ["active", "stale"]),
          ),
        )
        .orderBy(resources.type, resources.name);
      return {
        version: effective.version,
        effective,
        bindings: bindingRows.map(bindingToInput),
        availableTeamResources: availableTeamResources.map(rowToResource),
      };
    },

    async ensureAndBindCampaignScanSkill(agentId, campaign, actorId) {
      const skill = getCampaignScanSkill(campaign);
      if (!skill) return;
      const [agent] = await db
        .select({ organizationId: agents.organizationId, managerId: agents.managerId, status: agents.status })
        .from(agents)
        .where(eq(agents.uuid, agentId))
        .limit(1);
      if (!agent || agent.status === "deleted") return;
      const organizationId = agent.organizationId;

      // Ownership gate (IDOR defense). Only someone who may MANAGE this agent —
      // its manager, or an admin in the agent's org — may provision a skill onto
      // it. Mirrors `requireAgentAccess(…, "manage")`. The kickoff route already
      // runs this AFTER createChat validates the chat, but guarding here keeps
      // the mutation safe regardless of caller. A caller from another org (the
      // IDOR vector) is neither manager nor admin-in-that-org, so they're
      // rejected — 404 like the route, to avoid agent-id enumeration.
      const [actor] = await db
        .select({ organizationId: members.organizationId, role: members.role })
        .from(members)
        .where(eq(members.id, actorId))
        .limit(1);
      const isManager = agent.managerId === actorId;
      const isOrgAdmin = !!actor && actor.organizationId === organizationId && actor.role === "admin";
      if (!isManager && !isOrgAdmin) throw new NotFoundError(`Agent "${agentId}" not found`);

      const findSkillResourceId = async (): Promise<string | null> => {
        const [row] = await db
          .select({ id: resources.id })
          .from(resources)
          .where(
            and(
              eq(resources.organizationId, organizationId),
              eq(resources.type, "skill"),
              eq(resources.scope, "agent"),
              eq(resources.ownerAgentId, agentId),
              eq(resources.name, skill.name),
              inArray(resources.status, ["active", "stale"]),
            ),
          )
          .limit(1);
        return row?.id ?? null;
      };

      // 1. Ensure the managed scan skill exists as an AGENT-PRIVATE resource
      //    (scope=agent, owned by this agent) — not an org team resource, so it
      //    needs no org-admin and never lands in the org catalogue. Idempotent by
      //    (org, ownerAgent, name); the partial unique index makes a concurrent
      //    create race-safe — the loser sees 23505 and reads the winner.
      let resourceId = await findSkillResourceId();
      if (!resourceId) {
        const id = uuidv7();
        try {
          await db.insert(resources).values({
            id,
            organizationId,
            type: "skill",
            scope: "agent",
            ownerAgentId: agentId,
            name: skill.name,
            repoCanonicalKey: null,
            defaultEnabled: null,
            status: "active",
            payload: { name: skill.name, description: skill.description, body: skill.body, metadata: {} },
            createdBy: actorId,
            updatedBy: actorId,
          });
          resourceId = id;
        } catch (err) {
          if (postgresErrorCode(err) === "23505") resourceId = await findSkillResourceId();
          if (!resourceId) throw err;
        }
      }
      if (!resourceId) return;

      // 2. Bind it to the agent (mode "include") unless already bound. Do the
      //    check-and-insert under a row lock on the agent so concurrent kickoffs
      //    (two tabs / a retry) serialize: the second waits, re-reads, and skips
      //    — no duplicate binding (the resource index dedupes the resource; this
      //    dedupes the binding). Bump the config version + notify (mirroring
      //    replaceAgentResources) so the client re-fetches and materializes the
      //    skill before the kickoff chat dispatches.
      let didBind = false;
      await db.transaction(async (tx) => {
        const targetDb = tx as unknown as Database;
        await targetDb.select({ uuid: agents.uuid }).from(agents).where(eq(agents.uuid, agentId)).for("update");
        const [already] = await targetDb
          .select({ id: agentResourceBindings.id })
          .from(agentResourceBindings)
          .where(and(eq(agentResourceBindings.agentId, agentId), eq(agentResourceBindings.resourceId, resourceId)))
          .limit(1);
        if (already) return;
        const existing = await targetDb
          .select({ id: agentResourceBindings.id })
          .from(agentResourceBindings)
          .where(eq(agentResourceBindings.agentId, agentId));
        await targetDb
          .update(agentConfigs)
          .set({ version: sql`${agentConfigs.version} + 1`, updatedAt: new Date(), updatedBy: actorId })
          .where(eq(agentConfigs.agentId, agentId));
        await targetDb.insert(agentResourceBindings).values({
          id: uuidv7(),
          organizationId,
          agentId,
          type: "skill",
          mode: "include",
          resourceId,
          replacesResourceId: null,
          inlinePromptBody: null,
          repoRef: null,
          repoLocalPath: null,
          order: existing.length,
          createdBy: actorId,
          updatedBy: actorId,
        });
        didBind = true;
      });
      if (didBind) await notifyAgents([agentId]);
    },

    resolveRuntimeConfig,
    resolveEffectiveResources,
  };
}
