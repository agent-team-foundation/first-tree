import {
  AGENT_BRIEFING_GENERATED_MARKER,
  AGENT_VISIBILITY,
  type AgentVisibility,
  canonicalizeResourceRepoUrl,
  DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
  PROMPT_APPEND_MAX_LENGTH,
} from "@first-tree/shared";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { resources } from "../db/schema/resources.js";
import { createAgent } from "../services/agent.js";
import { LANDING_CAMPAIGN_TRIAL_PROMPT } from "../services/landing-campaigns/trial-prompt.js";
import { createOrganization } from "../services/organization.js";
import { backfillResourcesPhase1 } from "../services/resources-migration.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type OrgUser = {
  accessToken: string;
  userId: string;
  organizationId: string;
  memberId: string;
  clientId: string;
  humanAgentUuid: string;
};

describe("Resources Phase 1", () => {
  const getApp = useTestApp();

  it("does not leak a private agent-scoped repo through the Class C resource route", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const viewer = await createOrgUser(app, "member", owner.organizationId);
    const agent = await createRuntimeAgent(app, owner, { visibility: AGENT_VISIBILITY.PRIVATE });

    await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: 1,
        bindings: [
          {
            type: "repo",
            mode: "include",
            agentExtraRepo: { url: "https://github.com/acme/private-repo.git" },
          },
        ],
      },
      owner.memberId,
    );

    const [agentRepo] = await app.db
      .select()
      .from(resources)
      .where(and(eq(resources.ownerAgentId, agent.uuid), eq(resources.scope, "agent"), eq(resources.type, "repo")))
      .limit(1);
    expect(agentRepo).toBeDefined();

    const denied = await inject(app, viewer.accessToken, "GET", `/api/v1/resources/${agentRepo?.id}`);
    expect(denied.statusCode).toBe(404);

    const allowed = await inject(app, owner.accessToken, "GET", `/api/v1/resources/${agentRepo?.id}`);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ id: agentRepo?.id, scope: "agent", ownerAgentId: agent.uuid });
  });

  it("round-trips a legacy agent-scoped skill binding through replaceAgentResources", async () => {
    // The producer (ensureAndBindCampaignScanSkill) is gone, but trial agents
    // provisioned before the 2026-07 migration still carry an agent-scoped
    // `skill` resource + binding until a re-kickoff purges them. The web
    // resource editors re-submit the FULL binding array on every save, so
    // replaceAgentResources MUST keep admitting an owned agent-scoped skill
    // (the surviving carve-out in validateBindingReferences) — otherwise every
    // save on an un-migrated trial agent 400s. Seed such a row directly since
    // nothing produces it anymore.
    const app = getApp();
    const owner = await createOrgUser(app, "member");
    const agent = await createRuntimeAgent(app, owner);

    const legacyResourceId = uuidv7();
    await app.db.insert(resources).values({
      id: legacyResourceId,
      organizationId: owner.organizationId,
      type: "skill",
      scope: "agent",
      ownerAgentId: agent.uuid,
      name: "production-scan",
      repoCanonicalKey: null,
      defaultEnabled: null,
      status: "active",
      payload: { name: "production-scan", description: "legacy", body: "LEGACY BODY", metadata: {} },
      createdBy: owner.memberId,
      updatedBy: owner.memberId,
    });
    await app.db.insert(agentResourceBindings).values({
      id: uuidv7(),
      organizationId: owner.organizationId,
      agentId: agent.uuid,
      type: "skill",
      mode: "include",
      resourceId: legacyResourceId,
      replacesResourceId: null,
      inlinePromptBody: null,
      repoRef: null,
      repoLocalPath: null,
      order: 0,
      createdBy: owner.memberId,
      updatedBy: owner.memberId,
    });

    const current = await app.resourcesService.getAgentResources(agent.uuid);
    expect(current.bindings.some((b) => b.type === "skill" && b.resourceId === legacyResourceId)).toBe(true);
    // Re-submitting the full binding array must not reject the agent-scoped skill.
    await app.resourcesService.replaceAgentResources(
      agent.uuid,
      { expectedVersion: current.version, bindings: current.bindings },
      owner.memberId,
    );

    const bindings = await app.db
      .select()
      .from(agentResourceBindings)
      .where(and(eq(agentResourceBindings.agentId, agent.uuid), eq(agentResourceBindings.type, "skill")));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.resourceId).toBe(legacyResourceId);
  });

  it("resolves inline prompt replace as resourceId=null plus replacesResourceId", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const teamPrompt = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "prompt",
        name: "Team prompt",
        defaultEnabled: "available",
        payload: { body: "Use the team baseline." },
      },
      owner.memberId,
    );

    const updated = await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: 1,
        bindings: [
          {
            type: "prompt",
            mode: "replace",
            resourceId: null,
            replacesResourceId: teamPrompt.id,
            inlinePromptBody: "Use the agent-local replacement.",
          },
        ],
      },
      owner.memberId,
    );

    expect(updated.bindings).toHaveLength(1);
    expect(updated.bindings[0]).toMatchObject({
      type: "prompt",
      mode: "replace",
      resourceId: null,
      replacesResourceId: teamPrompt.id,
      inlinePromptBody: "Use the agent-local replacement.",
    });
    expect(updated.effective.prompts.some((row) => row.mode === "replaced" && row.resourceId === teamPrompt.id)).toBe(
      true,
    );

    const baseConfig = await app.configService.get(agent.uuid);
    const resolved = await app.resourcesService.resolveRuntimeConfig(baseConfig);
    expect(resolved.payload.prompt.append).toContain("Use the agent-local replacement.");
    expect(resolved.payload.prompt.append).not.toContain("Use the team baseline.");
  });

  it("projects the effective prompt stack into structured prompt.sections with provenance scopes", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const teamPrompt = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "prompt",
        name: "Review rules",
        defaultEnabled: "available",
        payload: { body: "Always review twice." },
      },
      owner.memberId,
    );

    const replacedPrompt = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "prompt",
        name: "Tone guide",
        defaultEnabled: "available",
        payload: { body: "Original team tone guide." },
      },
      owner.memberId,
    );

    await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: 1,
        bindings: [
          { type: "prompt", mode: "include", resourceId: teamPrompt.id },
          { type: "prompt", mode: "include", resourceId: null, inlinePromptBody: "Prefer terse replies." },
          {
            type: "prompt",
            mode: "replace",
            resourceId: null,
            replacesResourceId: replacedPrompt.id,
            inlinePromptBody: "Agent-specific tone override.",
          },
        ],
      },
      owner.memberId,
    );

    const baseConfig = await app.configService.get(agent.uuid);
    const resolved = await app.resourcesService.resolveRuntimeConfig(baseConfig);

    // Structured projection: provenance scope per row. Only the standalone
    // inline fragment is `editable` — the one row `prompt set` owns. The
    // inline *replacement* is agent-scope but managed via resource bindings,
    // and keeps the replaced team prompt's name so readers know which team
    // slot the agent-specific body stands in for.
    expect(resolved.payload.prompt.sections).toEqual([
      { scope: "team", name: "Review rules", body: "Always review twice.", editable: false },
      { scope: "agent", name: "", body: "Prefer terse replies.", editable: true },
      { scope: "agent", name: "Tone guide", body: "Agent-specific tone override.", editable: false },
    ]);

    // Legacy merged blob stays populated for older clients, with the
    // provenance-honest heading labels (the old `## Agent-Specific Prompt`
    // nesting is what trained agents to copy team content into their own
    // fragment).
    expect(resolved.payload.prompt.append).toContain("## Team Prompt: Review rules");
    expect(resolved.payload.prompt.append).toContain("## Agent Prompt (this agent only)");
    expect(resolved.payload.prompt.append).toContain("Always review twice.");
    expect(resolved.payload.prompt.append).toContain("Prefer terse replies.");
    // The replacement body is effective; the replaced team body is not.
    expect(resolved.payload.prompt.append).toContain("Agent-specific tone override.");
    expect(resolved.payload.prompt.append).not.toContain("Original team tone guide.");
  });

  it("rejects an inline prompt body carrying the generated-briefing marker, but lets bare briefing headings through", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);

    // Conclusive tier: the marker only exists in the generated AGENTS.md
    // banner, so its presence means the caller pasted the assembled file.
    await expect(
      app.resourcesService.replaceAgentResources(
        agent.uuid,
        {
          expectedVersion: 1,
          bindings: [
            {
              type: "prompt",
              mode: "include",
              resourceId: null,
              inlinePromptBody: `<!-- ${AGENT_BRIEFING_GENERATED_MARKER} — rebuilt every session -->\n# Identity\n\nYou are…`,
            },
          ],
        },
        owner.memberId,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      attrs: { code: "assembled_briefing_in_prompt" },
    });

    // Heuristic tier stays CLI-side (where --force can override): a body
    // that merely contains a briefing-shaped heading must pass the server.
    const accepted = await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: 1,
        bindings: [
          {
            type: "prompt",
            mode: "include",
            resourceId: null,
            inlinePromptBody: "# Working in First Tree\n\nA legitimate quote of the heading.",
          },
        ],
      },
      owner.memberId,
    );
    expect(accepted.version).toBe(2);
  });

  it("rejects concurrent agent resource writes with the same expected version", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);

    const results = await Promise.allSettled([
      app.resourcesService.replaceAgentResources(
        agent.uuid,
        {
          expectedVersion: 1,
          bindings: [{ type: "prompt", mode: "include", resourceId: null, inlinePromptBody: "First write." }],
        },
        owner.memberId,
      ),
      app.resourcesService.replaceAgentResources(
        agent.uuid,
        {
          expectedVersion: 1,
          bindings: [{ type: "prompt", mode: "include", resourceId: null, inlinePromptBody: "Second write." }],
        },
        owner.memberId,
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });

    const [config] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid))
      .limit(1);
    expect(config?.version).toBe(2);
    const bindings = await app.db
      .select()
      .from(agentResourceBindings)
      .where(eq(agentResourceBindings.agentId, agent.uuid));
    expect(bindings).toHaveLength(1);
  });

  it("does not backfill canonical-equivalent HTTPS, ssh, and scp-like GitHub repos as duplicates", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const canonical = canonicalizeResourceRepoUrl("https://github.com/acme/web.git");

    await app.db.insert(organizationSettings).values({
      organizationId: owner.organizationId,
      namespace: "source_repos",
      value: { repos: [{ url: "https://github.com/acme/web.git", defaultBranch: "main" }] },
      version: 1,
      updatedBy: owner.userId,
    });
    await app.db
      .update(agentConfigs)
      .set({
        payload: {
          ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
          gitRepos: [{ url: "git@github.com:Acme/Web.git" }],
          resourceSkills: [],
        },
      })
      .where(eq(agentConfigs.agentId, agent.uuid));

    const result = await backfillResourcesPhase1(app.db);
    expect(result.warnings).toEqual([]);

    const rows = await app.db
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, owner.organizationId),
          eq(resources.type, "repo"),
          eq(resources.repoCanonicalKey, canonical),
          ne(resources.status, "retired"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "team", defaultEnabled: "recommended" });
  });

  it("records warnings for invalid legacy resource backfill inputs", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const malformedConfigAgent = await createRuntimeAgent(app, owner);
    const invalidRepoAgent = await createRuntimeAgent(app, owner);

    await app.db.insert(organizationSettings).values({
      organizationId: owner.organizationId,
      namespace: "source_repos",
      value: { repos: "not-array" },
      version: 1,
      updatedBy: owner.userId,
    });
    await app.db
      .update(agentConfigs)
      .set({
        // Seed malformed persisted JSON directly; the typed write API would reject
        // the legacy shape that the backfill must tolerate.
        payload: {
          ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
          gitRepos: "not-array",
          resourceSkills: [],
        } as unknown as typeof DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
      })
      .where(eq(agentConfigs.agentId, malformedConfigAgent.uuid));
    await app.db
      .update(agentConfigs)
      .set({
        payload: {
          ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
          gitRepos: [{ url: "not a url" }],
          resourceSkills: [],
        },
      })
      .where(eq(agentConfigs.agentId, invalidRepoAgent.uuid));

    const result = await backfillResourcesPhase1(app.db);

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        `source_repos parse failed for org ${owner.organizationId}`,
        `agent config parse failed for ${malformedConfigAgent.uuid}`,
        expect.stringMatching(new RegExp(`agent gitRepo skipped for ${invalidRepoAgent.uuid}: Invalid URL`)),
      ]),
    );
    expect(result.teamReposCreated).toBe(0);
    expect(result.agentReposCreated).toBe(0);
    expect(result.bindingsCreated).toBe(0);
  });

  it("backfills explicit team repo refs while ignoring duplicate legacy bindings", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const newBindingAgent = await createRuntimeAgent(app, owner);
    const duplicateBindingAgent = await createRuntimeAgent(app, owner);
    const teamRepo = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "repo",
        name: "Shared repo",
        defaultEnabled: "recommended",
        payload: { url: "https://github.com/acme/shared.git", defaultBranch: "main" },
      },
      owner.memberId,
    );

    await app.db
      .update(agentConfigs)
      .set({
        payload: {
          ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
          gitRepos: [{ url: "git@github.com:Acme/Shared.git", ref: "feature-a", localPath: "shared-a" }],
          prompt: { append: "" },
          resourceSkills: [],
        },
      })
      .where(eq(agentConfigs.agentId, newBindingAgent.uuid));
    await app.db
      .update(agentConfigs)
      .set({
        payload: {
          ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
          gitRepos: [{ url: "https://github.com/acme/shared.git", ref: "feature-b", localPath: "shared-b" }],
          prompt: { append: "Existing prompt append." },
          resourceSkills: [],
        },
      })
      .where(eq(agentConfigs.agentId, duplicateBindingAgent.uuid));
    await app.db.insert(agentResourceBindings).values([
      {
        id: uuidv7(),
        organizationId: owner.organizationId,
        agentId: duplicateBindingAgent.uuid,
        type: "repo",
        mode: "include",
        resourceId: teamRepo.id,
        replacesResourceId: null,
        inlinePromptBody: null,
        repoRef: "feature-b",
        repoLocalPath: "shared-b",
        order: 1,
        createdBy: owner.memberId,
        updatedBy: owner.memberId,
      },
      {
        id: uuidv7(),
        organizationId: owner.organizationId,
        agentId: duplicateBindingAgent.uuid,
        type: "prompt",
        mode: "include",
        resourceId: null,
        replacesResourceId: null,
        inlinePromptBody: "Existing prompt append.",
        repoRef: null,
        repoLocalPath: null,
        order: 2,
        createdBy: owner.memberId,
        updatedBy: owner.memberId,
      },
    ]);

    const result = await backfillResourcesPhase1(app.db);

    expect(result.warnings).toEqual([]);
    expect(result.teamReposCreated).toBe(0);
    expect(result.agentReposCreated).toBe(0);
    expect(result.bindingsCreated).toBe(1);
    expect(result.agentVersionsBumped).toBe(1);

    const newBindings = await app.db
      .select()
      .from(agentResourceBindings)
      .where(eq(agentResourceBindings.agentId, newBindingAgent.uuid));
    expect(newBindings).toHaveLength(1);
    expect(newBindings[0]).toMatchObject({
      type: "repo",
      resourceId: teamRepo.id,
      repoRef: "feature-a",
      repoLocalPath: "shared-a",
      order: 1,
    });

    const duplicateBindings = await app.db
      .select()
      .from(agentResourceBindings)
      .where(eq(agentResourceBindings.agentId, duplicateBindingAgent.uuid));
    expect(duplicateBindings).toHaveLength(2);
  });

  it("lets an explicit repo binding override a recommended team repo without duplicating it", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const teamRepo = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "repo",
        name: "Web",
        defaultEnabled: "recommended",
        payload: { url: "https://github.com/acme/web.git", defaultBranch: "main" },
      },
      owner.memberId,
    );
    const current = await app.resourcesService.getAgentResources(agent.uuid);

    const updated = await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: current.version,
        bindings: [
          {
            type: "repo",
            mode: "include",
            resourceId: teamRepo.id,
            repoRef: "feature",
            repoLocalPath: "custom-web",
          },
        ],
      },
      owner.memberId,
    );

    const enabledRows = updated.effective.repos.filter(
      (row) => row.mode === "enabled" && row.resourceId === teamRepo.id,
    );
    expect(enabledRows).toHaveLength(1);
    expect(enabledRows[0]?.repo).toEqual({
      url: "https://github.com/acme/web.git",
      ref: "feature",
      localPath: "custom-web",
    });

    const baseConfig = await app.configService.get(agent.uuid);
    const resolved = await app.resourcesService.resolveRuntimeConfig(baseConfig);
    expect(resolved.payload.gitRepos).toEqual([
      { url: "https://github.com/acme/web.git", ref: "feature", localPath: "custom-web" },
    ]);
  });

  it("normalizes a legacy nested repo_local_path on the resource-binding read path", async () => {
    // PR #1048 — the binding-input schema transforms/validates repoLocalPath on
    // WRITE, but a row persisted before that narrowing reaches the read path raw.
    // `repoRuntimeRow` must normalize it the same way, or the client sees a raw
    // nested name that the briefing re-normalizes while the workspace.json
    // manifest drops it — three different names for one binding.
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const teamRepo = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "repo",
        name: "Web",
        defaultEnabled: "recommended",
        payload: { url: "https://github.com/acme/web.git", defaultBranch: "main" },
      },
      owner.memberId,
    );
    const current = await app.resourcesService.getAgentResources(agent.uuid);
    await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: current.version,
        bindings: [{ type: "repo", mode: "include", resourceId: teamRepo.id, repoLocalPath: "custom-web" }],
      },
      owner.memberId,
    );

    // Simulate a pre-narrowing row: write a nested value straight to the column,
    // bypassing the input schema (which would reject it on write today).
    await app.db
      .update(agentResourceBindings)
      .set({ repoLocalPath: "services/api" })
      .where(and(eq(agentResourceBindings.agentId, agent.uuid), eq(agentResourceBindings.resourceId, teamRepo.id)));

    const baseConfig = await app.configService.get(agent.uuid);
    const resolved = await app.resourcesService.resolveRuntimeConfig(baseConfig);
    expect(resolved.payload.gitRepos).toEqual([
      { url: "https://github.com/acme/web.git", ref: "main", localPath: "services-api" },
    ]);
  });

  it("dedups two repo bindings that collide only after localPath normalization", async () => {
    // baixiaohang's concern: a legacy nested `services/api` and a single-segment
    // `services-api` both resolve to the same workspace dir. Once the read path
    // normalizes, resource dedup must catch the collision gracefully (mark the
    // later repo unavailable) rather than letting both target the same dir.
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const repoA = await app.resourcesService.createTeamResource(
      owner.organizationId,
      { type: "repo", name: "A", defaultEnabled: "recommended", payload: { url: "https://github.com/acme/a.git" } },
      owner.memberId,
    );
    const repoB = await app.resourcesService.createTeamResource(
      owner.organizationId,
      { type: "repo", name: "B", defaultEnabled: "recommended", payload: { url: "https://github.com/acme/b.git" } },
      owner.memberId,
    );
    const current = await app.resourcesService.getAgentResources(agent.uuid);
    await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: current.version,
        bindings: [
          { type: "repo", mode: "include", resourceId: repoA.id, repoLocalPath: "services-api", order: 0 },
          { type: "repo", mode: "include", resourceId: repoB.id, repoLocalPath: "placeholder", order: 1 },
        ],
      },
      owner.memberId,
    );
    // Make repoB's binding a legacy nested value that normalizes to repoA's name.
    await app.db
      .update(agentResourceBindings)
      .set({ repoLocalPath: "services/api" })
      .where(and(eq(agentResourceBindings.agentId, agent.uuid), eq(agentResourceBindings.resourceId, repoB.id)));

    const agentResources = await app.resourcesService.getAgentResources(agent.uuid);
    const repoRows = agentResources.effective.repos.filter(
      (row) => row.resourceId === repoA.id || row.resourceId === repoB.id,
    );
    const enabled = repoRows.filter((row) => row.mode === "enabled");
    const unavailable = repoRows.filter((row) => row.mode === "unavailable");
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.resourceId).toBe(repoA.id);
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toMatchObject({ resourceId: repoB.id, unavailableReason: "duplicate_local_path" });
  });

  it("runs legacy backfill once, bumps affected agent versions, and does not resurrect retired or removed resources", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);

    await app.db.insert(organizationSettings).values({
      organizationId: owner.organizationId,
      namespace: "source_repos",
      value: { repos: [{ url: "https://github.com/acme/legacy-web.git", defaultBranch: "main" }] },
      version: 1,
      updatedBy: owner.userId,
    });
    await app.db
      .update(agentConfigs)
      .set({
        payload: {
          ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
          gitRepos: [{ url: "https://github.com/acme/agent-extra.git", localPath: "agent-extra" }],
          prompt: { append: "Legacy prompt append." },
          resourceSkills: [],
        },
      })
      .where(eq(agentConfigs.agentId, agent.uuid));

    const first = await backfillResourcesPhase1(app.db);
    expect(first.teamReposCreated).toBe(1);
    expect(first.agentReposCreated).toBe(1);
    expect(first.bindingsCreated).toBe(2);
    expect(first.agentVersionsBumped).toBe(1);

    const [afterFirst] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid))
      .limit(1);
    expect(afterFirst?.version).toBe(2);

    const [teamRepo] = await app.db
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, owner.organizationId),
          eq(resources.type, "repo"),
          eq(resources.scope, "team"),
          eq(resources.repoCanonicalKey, canonicalizeResourceRepoUrl("https://github.com/acme/legacy-web.git")),
        ),
      )
      .limit(1);
    expect(teamRepo).toBeDefined();
    await app.resourcesService.retireResource(teamRepo?.id ?? "", owner.memberId);

    const currentResources = await app.resourcesService.getAgentResources(agent.uuid);
    await app.resourcesService.replaceAgentResources(
      agent.uuid,
      { expectedVersion: currentResources.version, bindings: [] },
      owner.memberId,
    );
    const [beforeSecond] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid))
      .limit(1);

    const second = await backfillResourcesPhase1(app.db);
    expect(second.teamReposCreated).toBe(0);
    expect(second.agentReposCreated).toBe(0);
    expect(second.bindingsCreated).toBe(0);
    expect(second.agentVersionsBumped).toBe(0);

    const activeLegacyTeamRepos = await app.db
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, owner.organizationId),
          eq(resources.type, "repo"),
          eq(resources.scope, "team"),
          eq(resources.repoCanonicalKey, canonicalizeResourceRepoUrl("https://github.com/acme/legacy-web.git")),
          inArray(resources.status, ["active", "stale"]),
        ),
      );
    expect(activeLegacyTeamRepos).toEqual([]);
    const bindings = await app.db
      .select()
      .from(agentResourceBindings)
      .where(eq(agentResourceBindings.agentId, agent.uuid));
    expect(bindings).toEqual([]);
    const [afterSecond] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid))
      .limit(1);
    expect(afterSecond?.version).toBe(beforeSecond?.version);
  });

  it("promotes an agent-scoped repo atomically and bumps the agent config version", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);

    const withAgentRepo = await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: 1,
        bindings: [
          {
            type: "repo",
            mode: "include",
            agentExtraRepo: { url: "https://github.com/acme/promote-me.git", defaultBranch: "main" },
            repoLocalPath: "promote-me",
          },
        ],
      },
      owner.memberId,
    );
    expect(withAgentRepo.version).toBe(2);

    const [agentRepo] = await app.db
      .select()
      .from(resources)
      .where(and(eq(resources.ownerAgentId, agent.uuid), eq(resources.scope, "agent"), eq(resources.type, "repo")))
      .limit(1);
    expect(agentRepo).toBeDefined();

    const promoted = await inject(app, owner.accessToken, "POST", `/api/v1/resources/${agentRepo?.id}/promote`);
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ scope: "team", type: "repo" });
    const teamResourceId = promoted.json<{ id: string }>().id;

    const [retiredAgentRepo] = await app.db
      .select()
      .from(resources)
      .where(eq(resources.id, agentRepo?.id ?? ""));
    expect(retiredAgentRepo?.status).toBe("retired");
    const [binding] = await app.db
      .select()
      .from(agentResourceBindings)
      .where(eq(agentResourceBindings.agentId, agent.uuid))
      .limit(1);
    expect(binding).toMatchObject({ resourceId: teamResourceId, repoLocalPath: "promote-me" });

    const [config] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid))
      .limit(1);
    expect(config?.version).toBe(3);

    const activeAgentScoped = await app.db
      .select({ id: resources.id })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, owner.organizationId),
          eq(resources.scope, "agent"),
          eq(resources.type, "repo"),
          inArray(resources.status, ["active", "stale"]),
        ),
      );
    expect(activeAgentScoped).toEqual([]);
  });

  it("keeps effective prompt append within the 32,000 character runtime budget", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const hugePrompt = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "prompt",
        name: "Huge prompt",
        defaultEnabled: "available",
        payload: { body: "x".repeat(PROMPT_APPEND_MAX_LENGTH) },
      },
      owner.memberId,
    );

    await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: 1,
        bindings: [{ type: "prompt", mode: "include", resourceId: hugePrompt.id }],
      },
      owner.memberId,
    );

    const effective = await app.resourcesService.resolveEffectiveResources(agent.uuid);
    expect(effective.unavailable).toContainEqual({
      type: "prompt",
      id: hugePrompt.id,
      reason: "prompt_budget_exceeded",
    });

    const baseConfig = await app.configService.get(agent.uuid);
    const resolved = await app.resourcesService.resolveRuntimeConfig(baseConfig);
    expect(resolved.payload.prompt.append.length).toBeLessThanOrEqual(PROMPT_APPEND_MAX_LENGTH);
  });

  it("preserves legacy stored MCP servers until Team MCP resources take over", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const legacyMcp = { name: "legacy-tools", transport: "stdio" as const, command: "node", args: ["legacy.js"] };
    await app.db
      .update(agentConfigs)
      .set({
        payload: {
          ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
          mcpServers: [legacyMcp],
          resourceSkills: [],
        },
      })
      .where(eq(agentConfigs.agentId, agent.uuid));

    const legacyBaseConfig = await app.configService.get(agent.uuid);
    const legacyResolved = await app.resourcesService.resolveRuntimeConfig(legacyBaseConfig);
    expect(legacyResolved.payload.mcpServers).toEqual([legacyMcp]);

    const teamMcp = { name: "team-tools", transport: "stdio" as const, command: "node", args: ["team.js"] };
    await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "mcp",
        name: "Team tools",
        defaultEnabled: "recommended",
        payload: teamMcp,
      },
      owner.memberId,
    );

    const teamBaseConfig = await app.configService.get(agent.uuid);
    const teamResolved = await app.resourcesService.resolveRuntimeConfig(teamBaseConfig);
    expect(teamResolved.payload.mcpServers).toEqual([teamMcp]);
  });

  it("projects disabled recommended prompts and inline replacements into effective resources", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const recommended = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "prompt",
        name: "Recommended prompt",
        defaultEnabled: "recommended",
        payload: { body: "Recommended baseline." },
      },
      owner.memberId,
    );
    const replaceable = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "prompt",
        name: "Replaceable prompt",
        defaultEnabled: "available",
        payload: { body: "Replaceable baseline." },
      },
      owner.memberId,
    );
    const current = await app.resourcesService.getAgentResources(agent.uuid);

    const updated = await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: current.version,
        bindings: [
          { type: "prompt", mode: "disable", resourceId: recommended.id },
          {
            type: "prompt",
            mode: "replace",
            resourceId: null,
            replacesResourceId: replaceable.id,
            inlinePromptBody: "Agent replacement.",
          },
        ],
      },
      owner.memberId,
    );

    expect(updated.effective.prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: recommended.id,
          mode: "disabled",
          source: "team_recommended",
          promptBody: null,
        }),
        expect.objectContaining({
          resourceId: replaceable.id,
          mode: "replaced",
          replacesResourceId: replaceable.id,
          source: "team_available",
          promptBody: null,
        }),
        expect.objectContaining({
          resourceId: null,
          mode: "enabled",
          replacesResourceId: replaceable.id,
          source: "inline_prompt",
          promptBody: "Agent replacement.",
        }),
      ]),
    );
  });

  it("marks malformed skill and MCP resources unavailable at projection time", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const skillId = uuidv7();
    const mcpId = uuidv7();
    await app.db.insert(resources).values([
      {
        id: skillId,
        organizationId: owner.organizationId,
        type: "skill",
        scope: "team",
        ownerAgentId: null,
        name: "Broken skill",
        repoCanonicalKey: null,
        defaultEnabled: "recommended",
        status: "active",
        payload: { description: "missing name and body" } as (typeof resources.$inferInsert)["payload"],
        createdBy: owner.memberId,
        updatedBy: owner.memberId,
      },
      {
        id: mcpId,
        organizationId: owner.organizationId,
        type: "mcp",
        scope: "team",
        ownerAgentId: null,
        name: "Broken MCP",
        repoCanonicalKey: null,
        defaultEnabled: "recommended",
        status: "active",
        payload: { name: "broken-mcp", transport: "http" } as (typeof resources.$inferInsert)["payload"],
        createdBy: owner.memberId,
        updatedBy: owner.memberId,
      },
    ]);

    const effective = await app.resourcesService.resolveEffectiveResources(agent.uuid);

    expect(effective.skills).toContainEqual(
      expect.objectContaining({
        resourceId: skillId,
        mode: "unavailable",
        unavailableReason: "invalid_skill_payload",
      }),
    );
    expect(effective.mcp).toContainEqual(
      expect.objectContaining({
        resourceId: mcpId,
        mode: "unavailable",
        unavailableReason: "invalid_mcp_payload",
      }),
    );
    expect(effective.unavailable).toEqual(
      expect.arrayContaining([
        { type: "skill", id: skillId, reason: "invalid_skill_payload" },
        { type: "mcp", id: mcpId, reason: "invalid_mcp_payload" },
      ]),
    );
  });

  it("projects team skill resources into runtime config skills", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const skill = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "skill",
        name: "Reviewer skill",
        defaultEnabled: "recommended",
        payload: {
          name: "reviewer",
          description: "Review changes.",
          body: "# Reviewer\n\nCheck edge cases.",
          metadata: { source: "team" },
        },
      },
      owner.memberId,
    );

    const baseConfig = await app.configService.get(agent.uuid);
    const resolved = await app.resourcesService.resolveRuntimeConfig(baseConfig);

    expect(resolved.payload.resourceSkills).toEqual([
      {
        resourceId: skill.id,
        name: "reviewer",
        description: "Review changes.",
        body: "# Reviewer\n\nCheck edge cases.",
        metadata: { source: "team" },
      },
    ]);
  });

  it("validates resource create/update edge paths and bumps recommended updates", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const prompt = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "prompt",
        name: "Available prompt",
        defaultEnabled: "available",
        payload: { body: "Available." },
      },
      owner.memberId,
    );

    const before = await app.configService.get(agent.uuid);
    const updated = await app.resourcesService.updateResource(
      prompt.id,
      {
        name: "Recommended prompt",
        defaultEnabled: "recommended",
        payload: { body: "Recommended." },
      },
      owner.memberId,
    );
    const after = await app.configService.get(agent.uuid);
    expect(updated).toMatchObject({
      id: prompt.id,
      name: "Recommended prompt",
      defaultEnabled: "recommended",
      payload: { body: "Recommended." },
    });
    expect(after.version).toBe(before.version + 1);

    await expect(
      app.resourcesService.updateResource(prompt.id, { status: "retired" }, owner.memberId),
    ).rejects.toMatchObject({ statusCode: 400 });

    await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "repo",
        name: "Web",
        defaultEnabled: "available",
        payload: { url: "https://github.com/acme/web.git" },
      },
      owner.memberId,
    );
    await expect(
      app.resourcesService.createTeamResource(
        owner.organizationId,
        {
          type: "repo",
          name: "Duplicate web",
          defaultEnabled: "available",
          payload: { url: "git@github.com:Acme/Web.git" },
        },
        owner.memberId,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: after.version,
        bindings: [
          {
            type: "repo",
            mode: "include",
            agentExtraRepo: { url: "https://github.com/acme/agent-only.git" },
          },
        ],
      },
      owner.memberId,
    );
    const [agentRepo] = await app.db
      .select()
      .from(resources)
      .where(and(eq(resources.ownerAgentId, agent.uuid), eq(resources.scope, "agent"), eq(resources.type, "repo")))
      .limit(1);
    await expect(
      app.resourcesService.updateResource(agentRepo?.id ?? "", { name: "Renamed" }, owner.memberId),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("promotes an agent-scoped repo into an existing canonical team repo", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const existingTeamRepo = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "repo",
        name: "Shared promote target",
        defaultEnabled: "available",
        payload: { url: "https://github.com/acme/promote-existing.git" },
      },
      owner.memberId,
    );
    await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: 1,
        bindings: [
          {
            type: "repo",
            mode: "include",
            agentExtraRepo: { url: "git@github.com:Acme/Promote-Existing.git" },
            repoLocalPath: "agent-promote-existing",
          },
        ],
      },
      owner.memberId,
    );
    const [agentRepo] = await app.db
      .select()
      .from(resources)
      .where(and(eq(resources.ownerAgentId, agent.uuid), eq(resources.scope, "agent"), eq(resources.type, "repo")))
      .limit(1);

    const promoted = await app.resourcesService.promoteResource(agentRepo?.id ?? "", owner.memberId);

    expect(promoted.id).toBe(existingTeamRepo.id);
    const [binding] = await app.db
      .select()
      .from(agentResourceBindings)
      .where(eq(agentResourceBindings.agentId, agent.uuid))
      .limit(1);
    expect(binding).toMatchObject({
      resourceId: existingTeamRepo.id,
      repoLocalPath: "agent-promote-existing",
    });
    const [retired] = await app.db
      .select()
      .from(resources)
      .where(eq(resources.id, agentRepo?.id ?? ""))
      .limit(1);
    expect(retired?.status).toBe("retired");
  });

  it("rejects promoting resources that are not active agent-scoped repos", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const teamPrompt = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "prompt",
        name: "Not promotable",
        defaultEnabled: "available",
        payload: { body: "Prompt" },
      },
      owner.memberId,
    );

    await expect(app.resourcesService.promoteResource(teamPrompt.id, owner.memberId)).rejects.toThrow(
      /agent-scoped repo resources/,
    );
  });

  it("previews organization impact defaults without a simulated payload", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);

    await expect(app.resourcesService.previewOrgImpact(owner.organizationId, {})).resolves.toEqual({
      affectedAgentCount: 0,
      promptOverflowAgentCount: 0,
      agents: [],
    });

    const recommended = await app.resourcesService.previewOrgImpact(owner.organizationId, {
      defaultEnabled: "recommended",
    });
    expect(recommended).toMatchObject({
      affectedAgentCount: 1,
      promptOverflowAgentCount: 0,
    });
    expect(recommended.agents).toEqual([expect.objectContaining({ uuid: agent.uuid })]);
  });

  it("previews prompt overflow using create and update candidate payloads", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    await createRuntimeAgent(app, owner);

    const createPreview = await inject(
      app,
      owner.accessToken,
      "POST",
      `/api/v1/orgs/${owner.organizationId}/resources/impact-preview`,
      {
        type: "prompt",
        defaultEnabled: "recommended",
        payload: { body: "x".repeat(PROMPT_APPEND_MAX_LENGTH + 1) },
      },
    );
    expect(createPreview.statusCode).toBe(200);
    expect(createPreview.json()).toMatchObject({ affectedAgentCount: 1, promptOverflowAgentCount: 1 });

    const prompt = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "prompt",
        name: "Preview prompt",
        defaultEnabled: "recommended",
        payload: { body: "short" },
      },
      owner.memberId,
    );
    const updatePreview = await inject(
      app,
      owner.accessToken,
      "POST",
      `/api/v1/resources/${prompt.id}/impact-preview`,
      {
        defaultEnabled: "recommended",
        payload: { body: "y".repeat(PROMPT_APPEND_MAX_LENGTH + 1) },
      },
    );
    expect(updatePreview.statusCode).toBe(200);
    expect(updatePreview.json()).toMatchObject({ affectedAgentCount: 1, promptOverflowAgentCount: 1 });
  });

  it("returns 409 when updating a team repo resource to a duplicate canonical URL", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "repo",
        name: "Web",
        defaultEnabled: "available",
        payload: { url: "https://github.com/acme/web.git" },
      },
      owner.memberId,
    );
    const api = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "repo",
        name: "API",
        defaultEnabled: "available",
        payload: { url: "https://github.com/acme/api.git" },
      },
      owner.memberId,
    );

    const duplicate = await inject(app, owner.accessToken, "PATCH", `/api/v1/resources/${api.id}`, {
      payload: { url: "git@github.com:Acme/Web.git" },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it("uses Class C paths for team resource detail and usage routes", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const resource = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "skill",
        name: "Review skill",
        defaultEnabled: "available",
        payload: {
          name: "review",
          description: "Review code carefully.",
          body: "# Review\n\nCheck risks first.",
          metadata: {},
        },
      },
      owner.memberId,
    );

    const detail = await inject(app, owner.accessToken, "GET", `/api/v1/resources/${resource.id}`);
    expect(detail.statusCode).toBe(200);
    const usage = await inject(app, owner.accessToken, "GET", `/api/v1/resources/${resource.id}/usage`);
    expect(usage.statusCode).toBe(200);

    const classBDetail = await inject(
      app,
      owner.accessToken,
      "GET",
      `/api/v1/orgs/${owner.organizationId}/resources/${resource.id}`,
    );
    expect(classBDetail.statusCode).toBe(404);
  });

  it("lists active and stale team resources only", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const prompt = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "prompt",
        name: "Alpha prompt",
        defaultEnabled: "available",
        payload: { body: "Alpha" },
      },
      owner.memberId,
    );
    const skill = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "skill",
        name: "Beta skill",
        defaultEnabled: "available",
        payload: {
          name: "beta",
          description: "Beta skill",
          body: "Use beta.",
          metadata: {},
        },
      },
      owner.memberId,
    );
    const retired = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "repo",
        name: "Retired repo",
        defaultEnabled: "available",
        payload: { url: "https://github.com/acme/retired.git" },
      },
      owner.memberId,
    );
    await app.resourcesService.retireResource(retired.id, owner.memberId);

    const rows = await app.resourcesService.listTeamResources(owner.organizationId);

    expect(rows.map((row) => row.id)).toEqual([prompt.id, skill.id]);
    expect(rows[0]).toMatchObject({
      id: prompt.id,
      organizationId: owner.organizationId,
      scope: "team",
      status: "active",
      payload: { body: "Alpha" },
    });
  });

  it("rejects invalid agent resource binding references", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const otherAgent = await createRuntimeAgent(app, owner);
    const teamPrompt = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "prompt",
        name: "Team prompt",
        defaultEnabled: "available",
        payload: { body: "Prompt" },
      },
      owner.memberId,
    );

    const expectRejectedBinding = async (
      binding: Parameters<typeof app.resourcesService.replaceAgentResources>[1]["bindings"][number],
      message: string,
    ) => {
      const current = await app.resourcesService.getAgentResources(agent.uuid);
      await expect(
        app.resourcesService.replaceAgentResources(
          agent.uuid,
          { expectedVersion: current.version, bindings: [binding] },
          owner.memberId,
        ),
      ).rejects.toThrow(message);
    };

    await expectRejectedBinding(
      { type: "repo", mode: "include", resourceId: crypto.randomUUID() },
      "is not available to this agent",
    );
    await expectRejectedBinding(
      { type: "repo", mode: "include", resourceId: teamPrompt.id },
      'has type "prompt", expected "repo"',
    );

    const ownedAgentRepoId = uuidv7();
    await app.db.insert(resources).values({
      id: ownedAgentRepoId,
      organizationId: owner.organizationId,
      type: "repo",
      scope: "agent",
      ownerAgentId: agent.uuid,
      name: "Owned repo",
      repoCanonicalKey: canonicalizeResourceRepoUrl("https://github.com/acme/owned.git"),
      defaultEnabled: null,
      status: "active",
      payload: { url: "https://github.com/acme/owned.git" },
      createdBy: owner.memberId,
      updatedBy: owner.memberId,
    });
    await expectRejectedBinding(
      { type: "repo", mode: "disable", resourceId: ownedAgentRepoId },
      "is not a Team resource",
    );

    const otherAgentRepoId = uuidv7();
    await app.db.insert(resources).values({
      id: otherAgentRepoId,
      organizationId: owner.organizationId,
      type: "repo",
      scope: "agent",
      ownerAgentId: otherAgent.uuid,
      name: "Other repo",
      repoCanonicalKey: canonicalizeResourceRepoUrl("https://github.com/acme/other.git"),
      defaultEnabled: null,
      status: "active",
      payload: { url: "https://github.com/acme/other.git" },
      createdBy: owner.memberId,
      updatedBy: owner.memberId,
    });
    await expectRejectedBinding(
      { type: "repo", mode: "include", resourceId: otherAgentRepoId },
      "is not owned by this agent",
    );

    const agentMcpId = uuidv7();
    await app.db.insert(resources).values({
      id: agentMcpId,
      organizationId: owner.organizationId,
      type: "mcp",
      scope: "agent",
      ownerAgentId: agent.uuid,
      name: "Agent MCP",
      repoCanonicalKey: null,
      defaultEnabled: null,
      status: "active",
      payload: { name: "agent-mcp", transport: "stdio", command: "agent-mcp" },
      createdBy: owner.memberId,
      updatedBy: owner.memberId,
    });
    await expectRejectedBinding(
      { type: "mcp", mode: "include", resourceId: agentMcpId },
      "Only repo and skill resources may be agent-scoped",
    );
  });

  it("covers agent resource projection fallbacks for legacy malformed rows", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);

    const malformedRepoId = uuidv7();
    const malformedPromptId = uuidv7();
    const retiredRepoId = uuidv7();
    const retiredPromptId = uuidv7();
    await app.db.insert(resources).values([
      {
        id: malformedRepoId,
        organizationId: owner.organizationId,
        type: "repo",
        scope: "team",
        ownerAgentId: null,
        name: "Malformed repo",
        repoCanonicalKey: null,
        defaultEnabled: "recommended",
        status: "active",
        payload: { defaultBranch: "main" } as (typeof resources.$inferInsert)["payload"],
        createdBy: owner.memberId,
        updatedBy: owner.memberId,
      },
      {
        id: malformedPromptId,
        organizationId: owner.organizationId,
        type: "prompt",
        scope: "team",
        ownerAgentId: null,
        name: "Malformed prompt",
        repoCanonicalKey: null,
        defaultEnabled: "recommended",
        status: "active",
        payload: { text: "missing body" } as unknown as (typeof resources.$inferInsert)["payload"],
        createdBy: owner.memberId,
        updatedBy: owner.memberId,
      },
      {
        id: retiredRepoId,
        organizationId: owner.organizationId,
        type: "repo",
        scope: "team",
        ownerAgentId: null,
        name: "Retired repo",
        repoCanonicalKey: canonicalizeResourceRepoUrl("https://github.com/acme/retired-fallback.git"),
        defaultEnabled: "available",
        status: "retired",
        payload: { url: "https://github.com/acme/retired-fallback.git" },
        createdBy: owner.memberId,
        updatedBy: owner.memberId,
      },
      {
        id: retiredPromptId,
        organizationId: owner.organizationId,
        type: "prompt",
        scope: "team",
        ownerAgentId: null,
        name: "Retired prompt",
        repoCanonicalKey: null,
        defaultEnabled: "available",
        status: "retired",
        payload: { body: "Retired prompt" },
        createdBy: owner.memberId,
        updatedBy: owner.memberId,
      },
    ]);
    await app.db.insert(agentResourceBindings).values([
      {
        id: uuidv7(),
        organizationId: owner.organizationId,
        agentId: agent.uuid,
        type: "repo",
        mode: "disable",
        resourceId: retiredRepoId,
        replacesResourceId: null,
        inlinePromptBody: null,
        repoRef: null,
        repoLocalPath: null,
        order: 1,
        createdBy: owner.memberId,
        updatedBy: owner.memberId,
      },
      {
        id: uuidv7(),
        organizationId: owner.organizationId,
        agentId: agent.uuid,
        type: "prompt",
        mode: "include",
        resourceId: retiredPromptId,
        replacesResourceId: null,
        inlinePromptBody: null,
        repoRef: null,
        repoLocalPath: null,
        order: 2,
        createdBy: owner.memberId,
        updatedBy: owner.memberId,
      },
    ]);

    const effective = await app.resourcesService.resolveEffectiveResources(agent.uuid);

    expect(effective.repos).toContainEqual(
      expect.objectContaining({
        resourceId: malformedRepoId,
        mode: "enabled",
        repo: null,
      }),
    );
    expect(effective.prompts).toContainEqual(
      expect.objectContaining({
        resourceId: malformedPromptId,
        mode: "enabled",
        promptBody: null,
      }),
    );
  });

  it("reuses agent extra repos and preserves explicit resource names", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);

    const first = await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: 1,
        bindings: [
          {
            type: "repo",
            mode: "include",
            agentExtraRepo: {
              name: "Named extra repo",
              url: "https://github.com/acme/named-extra.git",
              defaultBranch: "main",
            },
          },
        ],
      },
      owner.memberId,
    );
    const second = await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: first.version,
        bindings: [
          {
            type: "repo",
            mode: "include",
            agentExtraRepo: {
              name: "Ignored second name",
              url: "git@github.com:Acme/Named-Extra.git",
              defaultBranch: "main",
            },
          },
        ],
      },
      owner.memberId,
    );

    expect(second.effective.repos).toHaveLength(1);
    expect(second.effective.repos[0]).toMatchObject({ name: "Named extra repo", source: "agent_extra" });
    const agentRepos = await app.db
      .select()
      .from(resources)
      .where(and(eq(resources.ownerAgentId, agent.uuid), eq(resources.scope, "agent"), eq(resources.type, "repo")));
    expect(agentRepos).toHaveLength(1);
    expect(agentRepos[0]).toMatchObject({ name: "Named extra repo" });
  });

  it("rejects duplicate input local paths", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);

    const current = await app.resourcesService.getAgentResources(agent.uuid);
    await expect(
      app.resourcesService.replaceAgentResources(
        agent.uuid,
        {
          expectedVersion: current.version,
          bindings: [
            {
              type: "repo",
              mode: "include",
              agentExtraRepo: { url: "https://github.com/acme/a.git" },
              repoLocalPath: "same",
            },
            {
              type: "repo",
              mode: "include",
              agentExtraRepo: { url: "https://github.com/acme/b.git" },
              repoLocalPath: "same",
            },
          ],
        },
        owner.memberId,
      ),
    ).rejects.toThrow('Duplicate repo localPath "same"');
  });

  it("covers resource service not-found and update default branches", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);

    await expect(app.resourcesService.getResource(crypto.randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    await expect(app.resourcesService.getAgentResources(crypto.randomUUID())).rejects.toMatchObject({ statusCode: 404 });

    await app.db.delete(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
    await expect(app.resourcesService.resolveEffectiveResources(agent.uuid)).rejects.toMatchObject({ statusCode: 404 });

    const prompt = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "prompt",
        name: "Patch without payload",
        defaultEnabled: "available",
        payload: { body: "Original" },
      },
      owner.memberId,
    );
    const updated = await app.resourcesService.updateResource(prompt.id, { name: "Renamed only" }, owner.memberId);
    expect(updated).toMatchObject({ name: "Renamed only", payload: { body: "Original" } });
  });

  it("marks oversized inline prompts unavailable with binding id fallback", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);

    await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: 1,
        bindings: [
          {
            type: "prompt",
            mode: "include",
            resourceId: null,
            inlinePromptBody: "x".repeat(PROMPT_APPEND_MAX_LENGTH + 1),
          },
        ],
      },
      owner.memberId,
    );

    const [binding] = await app.db
      .select({ id: agentResourceBindings.id })
      .from(agentResourceBindings)
      .where(eq(agentResourceBindings.agentId, agent.uuid))
      .limit(1);
    const effective = await app.resourcesService.resolveEffectiveResources(agent.uuid);

    expect(effective.unavailable).toContainEqual({
      type: "prompt",
      id: binding?.id,
      reason: "prompt_budget_exceeded",
    });
  });

  it("refreshes landing campaign trial prompt content and removes stale inline guardrails", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);

    await app.resourcesService.ensureAndBindLandingCampaignTrialPrompt(agent.uuid, owner.memberId);
    const [promptResource] = await app.db
      .select()
      .from(resources)
      .where(and(eq(resources.ownerAgentId, agent.uuid), eq(resources.type, "prompt"), eq(resources.scope, "agent")))
      .limit(1);
    expect(promptResource).toBeDefined();
    await app.db
      .update(resources)
      .set({ payload: { body: "stale", description: "stale" } })
      .where(eq(resources.id, promptResource?.id ?? ""));
    await app.db.insert(agentResourceBindings).values({
      id: uuidv7(),
      organizationId: owner.organizationId,
      agentId: agent.uuid,
      type: "prompt",
      mode: "include",
      resourceId: null,
      replacesResourceId: null,
      inlinePromptBody: LANDING_CAMPAIGN_TRIAL_PROMPT,
      repoRef: null,
      repoLocalPath: null,
      order: 99,
      createdBy: owner.memberId,
      updatedBy: owner.memberId,
    });
    const before = await app.configService.get(agent.uuid);

    await app.resourcesService.ensureAndBindLandingCampaignTrialPrompt(agent.uuid, owner.memberId);

    const [refreshed] = await app.db
      .select({ payload: resources.payload })
      .from(resources)
      .where(eq(resources.id, promptResource?.id ?? ""));
    expect(refreshed?.payload).toMatchObject({ body: LANDING_CAMPAIGN_TRIAL_PROMPT });
    const staleInlineRows = await app.db
      .select({ id: agentResourceBindings.id })
      .from(agentResourceBindings)
      .where(
        and(
          eq(agentResourceBindings.agentId, agent.uuid),
          isNull(agentResourceBindings.resourceId),
          eq(agentResourceBindings.inlinePromptBody, LANDING_CAMPAIGN_TRIAL_PROMPT),
        ),
      );
    expect(staleInlineRows).toHaveLength(0);
    const after = await app.configService.get(agent.uuid);
    expect(after.version).toBe(before.version + 1);
  });

  it("covers resource impact and projection edge fallbacks", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const other = await createOrgUser(app, "admin");
    const otherAgent = await createRuntimeAgent(app, other);

    const orphanAgentResourceId = uuidv7();
    await app.db.insert(resources).values({
      id: orphanAgentResourceId,
      organizationId: owner.organizationId,
      type: "prompt",
      scope: "agent",
      ownerAgentId: null,
      name: "Orphan agent prompt",
      repoCanonicalKey: null,
      defaultEnabled: null,
      status: "active",
      payload: { body: "orphan" },
      createdBy: owner.memberId,
      updatedBy: owner.memberId,
    });
    await expect(app.resourcesService.getUsage(orphanAgentResourceId)).resolves.toEqual({
      resourceId: orphanAgentResourceId,
      agentCount: 0,
      agents: [],
    });

    const repo = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "repo",
        name: "Unsafe local path repo",
        defaultEnabled: "available",
        payload: { url: "https://github.com/acme/unsafe-local.git", defaultBranch: "main" },
      },
      owner.memberId,
    );
    await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: 1,
        bindings: [{ type: "repo", mode: "include", resourceId: repo.id, repoLocalPath: "safe-local" }],
      },
      owner.memberId,
    );
    await app.db
      .update(agentResourceBindings)
      .set({ repoLocalPath: ".." })
      .where(and(eq(agentResourceBindings.agentId, agent.uuid), eq(agentResourceBindings.resourceId, repo.id)));
    const resolved = await app.resourcesService.resolveRuntimeConfig(await app.configService.get(agent.uuid));
    expect(resolved.payload.gitRepos).toEqual([{ url: "https://github.com/acme/unsafe-local.git", ref: "main" }]);

    const [storedRepo] = await app.db.select().from(resources).where(eq(resources.id, repo.id)).limit(1);
    expect(storedRepo).toBeDefined();
    if (!storedRepo) throw new Error("Expected stored repo fixture");
    type ResolveWithSimulation = (
      agentId: string,
      simulation: { resources: (typeof resources.$inferSelect)[] },
    ) => ReturnType<typeof app.resourcesService.resolveEffectiveResources>;
    const resolveWithSimulation = app.resourcesService.resolveEffectiveResources as ResolveWithSimulation;
    const simulated = await resolveWithSimulation(agent.uuid, {
      resources: [
        { ...storedRepo, id: uuidv7(), organizationId: other.organizationId },
        { ...storedRepo, id: uuidv7(), status: "retired" },
        { ...storedRepo, id: uuidv7(), scope: "agent", ownerAgentId: otherAgent.uuid },
        { ...storedRepo, id: uuidv7(), scope: "agent", ownerAgentId: agent.uuid, defaultEnabled: null },
      ],
    });
    expect(simulated.repos.some((row) => row.resourceId === repo.id)).toBe(true);

    await app.db.insert(agentResourceBindings).values({
      id: uuidv7(),
      organizationId: owner.organizationId,
      agentId: agent.uuid,
      type: "repo",
      mode: "disable",
      resourceId: null,
      replacesResourceId: null,
      inlinePromptBody: null,
      repoRef: null,
      repoLocalPath: null,
      order: 99,
      createdBy: owner.memberId,
      updatedBy: owner.memberId,
    });
    await expect(app.resourcesService.resolveEffectiveResources(agent.uuid)).resolves.toMatchObject({
      version: expect.any(Number),
    });
  });

  it("covers disabled skill and mcp validation skips plus preview fallback inputs", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const skill = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "skill",
        name: "Disable skill",
        defaultEnabled: "recommended",
        payload: { name: "disable-skill", description: "Disabled", body: "Disabled", metadata: {} },
      },
      owner.memberId,
    );
    const mcp = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "mcp",
        name: "Disable MCP",
        defaultEnabled: "recommended",
        payload: { name: "disable-mcp", transport: "stdio", command: "disable-mcp" },
      },
      owner.memberId,
    );
    const prompt = await app.resourcesService.createTeamResource(
      owner.organizationId,
      {
        type: "prompt",
        name: "Preview fallback prompt",
        defaultEnabled: "available",
        payload: { body: "Preview fallback." },
      },
      owner.memberId,
    );

    const current = await app.resourcesService.getAgentResources(agent.uuid);
    const updated = await app.resourcesService.replaceAgentResources(
      agent.uuid,
      {
        expectedVersion: current.version,
        bindings: [
          { type: "skill", mode: "disable", resourceId: skill.id },
          { type: "mcp", mode: "disable", resourceId: mcp.id },
        ],
      },
      owner.memberId,
    );
    expect(updated.effective.skills).toContainEqual(
      expect.objectContaining({ resourceId: skill.id, mode: "disabled" }),
    );
    expect(updated.effective.mcp).toContainEqual(expect.objectContaining({ resourceId: mcp.id, mode: "disabled" }));

    const preview = await app.resourcesService.previewResourceImpact(prompt.id, {});
    expect(preview).toMatchObject({ affectedAgentCount: 0, promptOverflowAgentCount: 0, agents: [] });

    const stale = await app.resourcesService.updateResource(prompt.id, { status: "stale" }, owner.memberId);
    expect(stale.status).toBe("stale");
  });

  it("covers missing config and trial resource authorization branches", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    const intruder = await createOrgUser(app, "member");

    await app.db.delete(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
    await expect(
      app.resourcesService.replaceAgentResources(agent.uuid, { expectedVersion: 1, bindings: [] }, owner.memberId),
    ).rejects.toThrow(/got missing/);

    const blockedAgent = await createRuntimeAgent(app, owner);
    await expect(
      app.resourcesService.ensureAndBindLandingCampaignTrialPrompt(blockedAgent.uuid, intruder.memberId),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      app.resourcesService.unbindLegacyCampaignScanSkill(blockedAgent.uuid, "production-scan", intruder.memberId),
    ).rejects.toMatchObject({ statusCode: 404 });

    await app.db.update(agents).set({ status: "deleted" }).where(eq(agents.uuid, blockedAgent.uuid));
    await expect(
      app.resourcesService.ensureAndBindLandingCampaignTrialPrompt(blockedAgent.uuid, owner.memberId),
    ).resolves.toBeUndefined();
    await expect(
      app.resourcesService.unbindLegacyCampaignScanSkill(blockedAgent.uuid, "production-scan", owner.memberId),
    ).resolves.toBeUndefined();
  });

  it("unbinds legacy campaign scan skills and leaves missing legacy rows unchanged", async () => {
    const app = getApp();
    const owner = await createOrgUser(app, "admin");
    const agent = await createRuntimeAgent(app, owner);
    await app.resourcesService.unbindLegacyCampaignScanSkill(agent.uuid, "production-scan", owner.memberId);

    const skillId = uuidv7();
    await app.db.insert(resources).values({
      id: skillId,
      organizationId: owner.organizationId,
      type: "skill",
      scope: "agent",
      ownerAgentId: agent.uuid,
      name: "production-scan",
      repoCanonicalKey: null,
      defaultEnabled: null,
      status: "active",
      payload: { name: "production-scan", description: "legacy", body: "legacy", metadata: {} },
      createdBy: owner.memberId,
      updatedBy: owner.memberId,
    });
    await app.db.insert(agentResourceBindings).values({
      id: uuidv7(),
      organizationId: owner.organizationId,
      agentId: agent.uuid,
      type: "skill",
      mode: "include",
      resourceId: skillId,
      replacesResourceId: null,
      inlinePromptBody: null,
      repoRef: null,
      repoLocalPath: null,
      order: 1,
      createdBy: owner.memberId,
      updatedBy: owner.memberId,
    });
    const before = await app.configService.get(agent.uuid);

    await app.resourcesService.unbindLegacyCampaignScanSkill(agent.uuid, "production-scan", owner.memberId);

    const [after] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid))
      .limit(1);
    expect(after?.version).toBe(before.version + 1);
    await expect(app.db.select().from(resources).where(eq(resources.id, skillId))).resolves.toHaveLength(0);
    await expect(
      app.db.select().from(agentResourceBindings).where(eq(agentResourceBindings.resourceId, skillId)),
    ).resolves.toHaveLength(0);
  });
});

async function createOrgUser(
  app: FastifyInstance,
  role: "admin" | "member",
  organizationId?: string,
): Promise<OrgUser> {
  const base = await createTestAdmin(app, { username: `res-${role}-${crypto.randomUUID().slice(0, 8)}` });
  const orgId =
    organizationId ??
    (
      await createOrganization(app.db, {
        name: `res-${crypto.randomUUID().slice(0, 12)}`,
        displayName: "Resources Test",
      })
    ).id;
  const memberId = uuidv7();
  const humanAgent = await app.db.transaction(async (tx) => {
    const created = await createAgent(
      tx as unknown as typeof app.db,
      {
        name: `human-${crypto.randomUUID().slice(0, 8)}`,
        type: "human",
        displayName: "Resource Tester",
        managerId: memberId,
        organizationId: orgId,
      },
      { force: true },
    );
    await tx.insert(members).values({
      id: memberId,
      userId: base.userId,
      organizationId: orgId,
      agentId: created.uuid,
      role,
    });
    return created;
  });
  const clientId = `cli-res-${crypto.randomUUID().slice(0, 8)}`;
  await app.db.insert(clients).values({
    id: clientId,
    userId: base.userId,
    organizationId: orgId,
    status: "connected",
  });
  return {
    accessToken: base.accessToken,
    userId: base.userId,
    organizationId: orgId,
    memberId,
    clientId,
    humanAgentUuid: humanAgent.uuid,
  };
}

async function createRuntimeAgent(app: FastifyInstance, owner: OrgUser, opts: { visibility?: AgentVisibility } = {}) {
  return createAgent(
    app.db,
    {
      name: `agent-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Runtime Agent",
      managerId: owner.memberId,
      organizationId: owner.organizationId,
      clientId: owner.clientId,
      visibility: opts.visibility,
    },
    { force: true },
  );
}

function inject(app: FastifyInstance, accessToken: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as "GET" | "POST" | "PATCH" | "DELETE",
    url,
    headers: { authorization: `Bearer ${accessToken}` },
    ...(payload ? { payload } : {}),
  });
}
