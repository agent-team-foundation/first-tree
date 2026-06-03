import {
  AGENT_VISIBILITY,
  type AgentVisibility,
  canonicalizeResourceRepoUrl,
  DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
  PROMPT_APPEND_MAX_LENGTH,
} from "@first-tree/shared";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { resources } from "../db/schema/resources.js";
import { createAgent } from "../services/agent.js";
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
