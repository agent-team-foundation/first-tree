import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { connectDatabase, sslOptions } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { createAgent } from "../services/agent.js";
import {
  listContextReviewerCandidates,
  readContextReviewerAgentReadiness,
} from "../services/context-reviewer-readiness.js";
import { putContextReviewerAssignment, putContextReviewerEnablement } from "../services/context-reviewer-settings.js";
import { upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import { createGitlabConnection } from "../services/gitlab-connections.js";
import { getOrgSetting } from "../services/org-settings.js";
import { getTeamSetupCapabilities } from "../services/setup-capabilities.js";
import { createAdminContext, createTestAdmin, seedClient, seedHealthyAgentRuntime, useTestApp } from "./helpers.js";

type AdminContext = Awaited<ReturnType<typeof createAdminContext>>;

const observedAt = new Date("2026-07-23T08:00:00.000Z");

function databaseUrlWithApplicationName(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

async function waitForPostgresLockWait(observer: ReturnType<typeof postgres>, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ wait_event_type: string | null }[]>`
      SELECT wait_event_type
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${applicationName}
    `;
    if (rows.some((row) => row.wait_event_type === "Lock")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for PostgreSQL lock: ${applicationName}`);
}

async function createReviewer(
  app: FastifyInstance,
  admin: AdminContext,
  options: {
    clientId?: string | null;
    displayName?: string;
    visibility?: "private" | "organization";
  } = {},
) {
  return createAgent(app.db, {
    name: `reviewer-${randomUUID().slice(0, 8)}`,
    type: "agent",
    displayName: options.displayName ?? "Context Reviewer",
    managerId: admin.memberId,
    organizationId: admin.organizationId,
    visibility: options.visibility ?? "organization",
    ...(options.clientId === null ? {} : { clientId: options.clientId ?? admin.clientId }),
  });
}

async function seedContextTreeBinding(
  app: FastifyInstance,
  admin: AdminContext,
  input: { provider: "github" | "gitlab"; repo: string },
): Promise<void> {
  await app.db.insert(organizationSettings).values({
    organizationId: admin.organizationId,
    namespace: "context_tree",
    value: {
      provider: input.provider,
      repo: input.repo,
      branch: "main",
    },
    version: 1,
    updatedBy: admin.userId,
  });
}

async function seedGithubPrerequisites(app: FastifyInstance, admin: AdminContext): Promise<void> {
  await seedContextTreeBinding(app, admin, {
    provider: "github",
    repo: "https://github.com/acme/context-tree.git",
  });
  const installationId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 10), 16);
  await upsertInstallationFromMetadata(app.db, {
    installation: {
      id: installationId,
      accountType: "Organization",
      accountLogin: "acme",
      accountGithubId: installationId + 1,
      permissions: { metadata: "read", pull_requests: "write" },
      events: ["pull_request", "issue_comment", "pull_request_review_comment"],
      suspendedAt: null,
    },
    hubOrganizationId: admin.organizationId,
  });
}

function mutationOptions(
  app: FastifyInstance,
  admin: AdminContext,
  probeGithubReview: () => Promise<"ready" | "permission_required" | "repo_not_covered" | "failed">,
) {
  return {
    updatedBy: admin.userId,
    staleSeconds: 60,
    githubAppCredentials: app.config.oauth?.githubApp,
    probeGithubReview,
    now: () => observedAt,
  };
}

describe("Context Reviewer assignment/readiness contract", () => {
  const getApp = useTestApp();

  it("lists only structurally eligible organization-visible Agents and keeps offline candidates selectable", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const eligible = await createReviewer(app, admin, { displayName: "Eligible Offline" });
    const privateAgent = await createReviewer(app, admin, { visibility: "private" });
    const noComputer = await createReviewer(app, admin, { clientId: null });
    const retiredClientId = await seedClient(app, admin.userId, admin.organizationId);
    const retired = await createReviewer(app, admin, { clientId: retiredClientId });
    const inactive = await createReviewer(app, admin);
    const disabledRuntime = await createReviewer(app, admin);
    const inactiveManager = await createAdminContext(app);
    const unmanaged = await createReviewer(app, inactiveManager);
    const landingTrial = await createReviewer(app, admin);
    await app.db.update(clients).set({ retiredAt: observedAt }).where(eq(clients.id, retiredClientId));
    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, inactive.uuid));
    await app.db
      .update(agents)
      .set({ runtimeProvider: "claude-code-tui" })
      .where(eq(agents.uuid, disabledRuntime.uuid));
    await app.db.update(members).set({ status: "left" }).where(eq(members.id, inactiveManager.memberId));
    await app.db
      .update(agents)
      .set({ metadata: { landingCampaignTrial: true } })
      .where(eq(agents.uuid, landingTrial.uuid));

    await expect(
      listContextReviewerCandidates(app.db, {
        organizationId: admin.organizationId,
        now: observedAt,
        staleSeconds: 60,
      }),
    ).resolves.toEqual({
      items: [
        {
          uuid: eligible.uuid,
          name: eligible.name,
          displayName: "Eligible Offline",
          visibility: "organization",
          runtime: {
            health: "degraded",
            blockers: [
              {
                code: "context_review_agent_runtime_unavailable",
                resolutionOwner: "admin",
                actionKind: "open_agent_owner_flow",
              },
            ],
          },
        },
      ],
      blockers: [],
    });

    for (const [agentUuid, code] of [
      [privateAgent.uuid, "context_review_agent_private"],
      [noComputer.uuid, "context_review_agent_no_runtime"],
      [retired.uuid, "context_review_agent_no_runtime"],
      [inactive.uuid, "context_review_agent_inactive"],
      [disabledRuntime.uuid, "context_review_agent_no_runtime"],
      [unmanaged.uuid, "context_review_agent_manager_inactive"],
      [landingTrial.uuid, "context_review_agent_missing"],
    ] as const) {
      await expect(
        putContextReviewerAssignment(app.db, admin.organizationId, agentUuid, {
          updatedBy: admin.userId,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        blocker: { code },
      });
    }

    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, eligible.uuid));
    await expect(
      listContextReviewerCandidates(app.db, {
        organizationId: admin.organizationId,
        now: observedAt,
        staleSeconds: 60,
      }),
    ).resolves.toEqual({
      items: [],
      blockers: [
        {
          code: "context_review_no_eligible_agent",
          resolutionOwner: "admin",
          actionKind: "open_agent_owner_flow",
        },
      ],
    });
  });

  it("keeps an assignment visible while the independent Tree binding is unavailable", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await putContextReviewerAssignment(app.db, admin.organizationId, reviewer.uuid, {
      updatedBy: admin.userId,
    });

    await expect(
      getTeamSetupCapabilities(app.db, admin.organizationId, {
        now: () => observedAt,
        staleSeconds: 60,
      }),
    ).resolves.toMatchObject({
      contextTree: {
        binding: { state: "unbound" },
        automaticReview: {
          adoption: "unavailable",
          health: "degraded",
          reviewerAgent: { uuid: reviewer.uuid, displayName: reviewer.displayName },
          blockers: [{ code: "context_review_agent_runtime_unavailable" }],
        },
      },
    });
  });

  it("does not project an invalid historical private selection to Team members", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const privateAgent = await createReviewer(app, admin, { visibility: "private" });
    await seedGithubPrerequisites(app, admin);
    await app.db.insert(organizationSettings).values({
      organizationId: admin.organizationId,
      namespace: "context_tree_features",
      value: {
        contextReviewer: { enabled: true, agentUuid: privateAgent.uuid },
      },
      version: 1,
      updatedBy: admin.userId,
    });

    await expect(getOrgSetting(app.db, admin.organizationId, "context_tree_features")).resolves.toEqual({
      contextReviewer: {
        enabled: true,
        agentUuid: null,
        reviewerAgent: null,
      },
    });
    await expect(
      getTeamSetupCapabilities(app.db, admin.organizationId, {
        now: () => observedAt,
        staleSeconds: 60,
        githubAppCredentials: app.config.oauth?.githubApp,
        probeGithubReview: async () => "ready",
      }),
    ).resolves.toMatchObject({
      contextTree: {
        automaticReview: {
          health: "unavailable",
          reviewerAgent: null,
          blockers: [{ code: "context_review_agent_private" }],
        },
      },
    });
  });

  it("classifies connection, presence, heartbeat, and capability drift as recoverable runtime health", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    const staleAt = new Date(observedAt.getTime() - 61_000);
    const scenarios: Array<{
      name: string;
      mutate: () => Promise<unknown>;
    }> = [
      {
        name: "disconnected Computer",
        mutate: () => app.db.update(clients).set({ status: "disconnected" }).where(eq(clients.id, admin.clientId)),
      },
      {
        name: "paused Computer",
        mutate: () =>
          app.db.update(clients).set({ pausedReason: "auth_rejected" }).where(eq(clients.id, admin.clientId)),
      },
      {
        name: "stale Computer heartbeat",
        mutate: () => app.db.update(clients).set({ lastSeenAt: staleAt }).where(eq(clients.id, admin.clientId)),
      },
      {
        name: "missing Agent presence",
        mutate: () => app.db.delete(agentPresence).where(eq(agentPresence.agentId, reviewer.uuid)),
      },
      {
        name: "mismatched runtime presence",
        mutate: () =>
          app.db.update(agentPresence).set({ runtimeType: "codex" }).where(eq(agentPresence.agentId, reviewer.uuid)),
      },
      {
        name: "unavailable runtime capability",
        mutate: () =>
          app.db
            .update(clients)
            .set({
              metadata: {
                capabilities: {
                  "claude-code": {
                    state: "missing",
                    available: false,
                    detectedAt: observedAt.toISOString(),
                  },
                },
              },
            })
            .where(eq(clients.id, admin.clientId)),
      },
      {
        name: "stale Server heartbeat",
        mutate: () =>
          app.db
            .update(serverInstances)
            .set({ lastHeartbeat: staleAt })
            .where(eq(serverInstances.instanceId, `instance-${admin.clientId}`)),
      },
    ];

    for (const scenario of scenarios) {
      await seedHealthyAgentRuntime(app, {
        agentUuid: reviewer.uuid,
        clientId: admin.clientId,
        now: observedAt,
      });
      await scenario.mutate();
      await expect(
        readContextReviewerAgentReadiness(app.db, {
          organizationId: admin.organizationId,
          reviewerAgentUuid: reviewer.uuid,
          now: observedAt,
          staleSeconds: 60,
        }),
        scenario.name,
      ).resolves.toMatchObject({
        structuralBlockers: [],
        healthBlockers: [{ code: "context_review_agent_runtime_unavailable" }],
      });
    }

    await seedHealthyAgentRuntime(app, {
      agentUuid: reviewer.uuid,
      clientId: admin.clientId,
      now: observedAt,
    });
    await expect(
      readContextReviewerAgentReadiness(app.db, {
        organizationId: admin.organizationId,
        reviewerAgentUuid: reviewer.uuid,
        now: observedAt,
        staleSeconds: 60,
      }),
    ).resolves.toMatchObject({
      structuralBlockers: [],
      healthBlockers: [],
    });
  });

  it("keeps assignment and disable idempotent, preserves selection, and disables on replacement", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const first = await createReviewer(app, admin);
    const second = await createReviewer(app, admin);

    await putContextReviewerAssignment(app.db, admin.organizationId, first.uuid, {
      updatedBy: admin.userId,
    });
    const readRow = () =>
      app.db
        .select({
          value: organizationSettings.value,
          version: organizationSettings.version,
        })
        .from(organizationSettings)
        .where(
          and(
            eq(organizationSettings.organizationId, admin.organizationId),
            eq(organizationSettings.namespace, "context_tree_features"),
          ),
        )
        .then((rows) => rows[0]);
    expect(await readRow()).toMatchObject({
      value: { contextReviewer: { enabled: false, agentUuid: first.uuid } },
      version: 1,
    });

    await putContextReviewerAssignment(app.db, admin.organizationId, first.uuid, {
      updatedBy: admin.userId,
    });
    expect(await readRow()).toMatchObject({ version: 1 });

    await app.db
      .update(organizationSettings)
      .set({
        value: { contextReviewer: { enabled: true, agentUuid: first.uuid } },
        version: 2,
      })
      .where(
        and(
          eq(organizationSettings.organizationId, admin.organizationId),
          eq(organizationSettings.namespace, "context_tree_features"),
        ),
      );
    await putContextReviewerAssignment(app.db, admin.organizationId, second.uuid, {
      updatedBy: admin.userId,
    });
    expect(await readRow()).toMatchObject({
      value: { contextReviewer: { enabled: false, agentUuid: second.uuid } },
      version: 3,
    });

    await putContextReviewerEnablement(app.db, admin.organizationId, false, {
      updatedBy: admin.userId,
      staleSeconds: 60,
    });
    expect(await readRow()).toMatchObject({
      value: { contextReviewer: { enabled: false, agentUuid: second.uuid } },
      version: 3,
    });

    await putContextReviewerAssignment(app.db, admin.organizationId, null, {
      updatedBy: admin.userId,
    });
    expect(await readRow()).toMatchObject({
      value: { contextReviewer: { enabled: false, agentUuid: null } },
      version: 4,
    });
    await putContextReviewerAssignment(app.db, admin.organizationId, null, {
      updatedBy: admin.userId,
    });
    expect(await readRow()).toMatchObject({ version: 4 });
  });

  it("takes manager and Computer locks before the assigned Agent row", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");

    const applicationName = `context_review_assignment_${randomUUID().slice(0, 8)}`;
    const assignmentDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, applicationName));
    const blocker = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
    const observer = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
    let blockerCommitted = false;
    try {
      await blocker`BEGIN`;
      await blocker`SELECT id FROM members WHERE id = ${admin.memberId} FOR UPDATE`;

      const assigning = putContextReviewerAssignment(assignmentDb, admin.organizationId, reviewer.uuid, {
        updatedBy: admin.userId,
      });
      await waitForPostgresLockWait(observer, applicationName);

      // If assignment had already taken Agent before waiting on manager,
      // either of these locks would complete a deadlock cycle.
      await blocker`SELECT id FROM clients WHERE id = ${admin.clientId} FOR UPDATE`;
      await blocker`SELECT uuid FROM agents WHERE uuid = ${reviewer.uuid} FOR UPDATE`;
      await blocker`COMMIT`;
      blockerCommitted = true;

      await expect(assigning).resolves.toMatchObject({
        contextReviewer: { enabled: false, agentUuid: reviewer.uuid },
      });
    } finally {
      if (!blockerCommitted) await blocker`ROLLBACK`;
      await assignmentDb.end();
      await blocker.end();
      await observer.end();
    }
  });

  it("retains the Tree binding and disabled selection across provider failure, then enables offline and projects degraded health", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await seedGithubPrerequisites(app, admin);
    await putContextReviewerAssignment(app.db, admin.organizationId, reviewer.uuid, {
      updatedBy: admin.userId,
    });
    const [treeBefore] = await app.db
      .select()
      .from(organizationSettings)
      .where(
        and(
          eq(organizationSettings.organizationId, admin.organizationId),
          eq(organizationSettings.namespace, "context_tree"),
        ),
      );

    await expect(
      putContextReviewerEnablement(
        app.db,
        admin.organizationId,
        true,
        mutationOptions(app, admin, async () => "repo_not_covered"),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      blocker: { code: "github_tree_repo_not_covered" },
    });
    await expect(getOrgSetting(app.db, admin.organizationId, "context_tree_features")).resolves.toMatchObject({
      contextReviewer: { enabled: false, agentUuid: reviewer.uuid },
    });
    const [treeAfterFailure] = await app.db
      .select()
      .from(organizationSettings)
      .where(
        and(
          eq(organizationSettings.organizationId, admin.organizationId),
          eq(organizationSettings.namespace, "context_tree"),
        ),
      );
    expect(treeAfterFailure).toEqual(treeBefore);

    await expect(
      putContextReviewerEnablement(
        app.db,
        admin.organizationId,
        true,
        mutationOptions(app, admin, async () => "ready"),
      ),
    ).resolves.toMatchObject({
      contextReviewer: { enabled: true, agentUuid: reviewer.uuid },
    });
    await expect(
      getTeamSetupCapabilities(app.db, admin.organizationId, {
        now: () => observedAt,
        staleSeconds: 60,
        githubAppCredentials: app.config.oauth?.githubApp,
        probeGithubReview: async () => "ready",
      }),
    ).resolves.toMatchObject({
      contextTree: {
        automaticReview: {
          adoption: "enabled",
          health: "degraded",
          reviewerAgent: {
            uuid: reviewer.uuid,
            displayName: reviewer.displayName,
          },
          blockers: [{ code: "context_review_agent_runtime_unavailable" }],
        },
      },
    });

    await putContextReviewerEnablement(app.db, admin.organizationId, false, {
      updatedBy: admin.userId,
      staleSeconds: 60,
    });
    await expect(getOrgSetting(app.db, admin.organizationId, "context_tree_features")).resolves.toMatchObject({
      contextReviewer: { enabled: false, agentUuid: reviewer.uuid },
    });
  });

  it("rechecks structural eligibility after the GitHub probe and fails closed on a concurrent privacy change", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await seedGithubPrerequisites(app, admin);
    await putContextReviewerAssignment(app.db, admin.organizationId, reviewer.uuid, {
      updatedBy: admin.userId,
    });

    await expect(
      putContextReviewerEnablement(
        app.db,
        admin.organizationId,
        true,
        mutationOptions(app, admin, async () => {
          await app.db.update(agents).set({ visibility: "private" }).where(eq(agents.uuid, reviewer.uuid));
          return "ready";
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      blocker: { code: "context_review_agent_private" },
    });
    await expect(getOrgSetting(app.db, admin.organizationId, "context_tree_features")).resolves.toMatchObject({
      contextReviewer: { enabled: false, agentUuid: null },
    });
  });

  it("keeps GitLab inbound readiness as an enablement prerequisite and recovers without reassignment", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await seedContextTreeBinding(app, admin, {
      provider: "gitlab",
      repo: "https://gitlab.internal/acme/context-tree.git",
    });
    const connection = await createGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "GitLab",
      instanceOrigin: "https://gitlab.internal",
    });
    await putContextReviewerAssignment(app.db, admin.organizationId, reviewer.uuid, {
      updatedBy: admin.userId,
    });

    await expect(
      putContextReviewerEnablement(app.db, admin.organizationId, true, {
        updatedBy: admin.userId,
        staleSeconds: 60,
        now: () => observedAt,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      blocker: { code: "gitlab_webhook_not_seen" },
    });
    await app.db
      .update(gitlabConnections)
      .set({
        endpointFirstSeenAt: observedAt,
        lastValidInboundAt: observedAt,
      })
      .where(eq(gitlabConnections.id, connection.connectionId));
    await expect(
      putContextReviewerEnablement(app.db, admin.organizationId, true, {
        updatedBy: admin.userId,
        staleSeconds: 60,
        now: () => observedAt,
      }),
    ).resolves.toMatchObject({
      contextReviewer: { enabled: true, agentUuid: reviewer.uuid },
    });
  });

  it("rechecks GitLab inbound authority after a concurrent bearer-health reset", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await seedContextTreeBinding(app, admin, {
      provider: "gitlab",
      repo: "https://gitlab.internal/acme/context-tree.git",
    });
    const connection = await createGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "GitLab",
      instanceOrigin: "https://gitlab.internal",
    });
    await app.db
      .update(gitlabConnections)
      .set({ endpointFirstSeenAt: observedAt, lastValidInboundAt: observedAt })
      .where(eq(gitlabConnections.id, connection.connectionId));
    await putContextReviewerAssignment(app.db, admin.organizationId, reviewer.uuid, {
      updatedBy: admin.userId,
    });

    let releaseReset = () => {};
    const waitForRelease = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    let markLocked = () => {};
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const reset = app.db.transaction(async (tx) => {
      await tx
        .select({ id: gitlabConnections.id })
        .from(gitlabConnections)
        .where(eq(gitlabConnections.id, connection.connectionId))
        .for("update");
      markLocked();
      await waitForRelease;
      await tx
        .update(gitlabConnections)
        .set({ endpointFirstSeenAt: null, lastValidInboundAt: null })
        .where(eq(gitlabConnections.id, connection.connectionId));
    });
    await locked;
    const enabling = putContextReviewerEnablement(app.db, admin.organizationId, true, {
      updatedBy: admin.userId,
      staleSeconds: 60,
      now: () => observedAt,
    });
    await Promise.resolve();
    releaseReset();
    await reset;

    await expect(enabling).rejects.toMatchObject({
      statusCode: 409,
      blocker: { code: "gitlab_webhook_not_seen" },
    });
    await expect(getOrgSetting(app.db, admin.organizationId, "context_tree_features")).resolves.toMatchObject({
      contextReviewer: { enabled: false, agentUuid: reviewer.uuid },
    });
  });

  it("exposes the candidate and assignment owner endpoints to Team admins only", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const member = await createTestAdmin(app);
    await app.db.update(members).set({ role: "member" }).where(eq(members.id, member.memberId));
    const privateAgent = await createReviewer(app, admin, { visibility: "private" });
    const baseUrl = `/api/v1/orgs/${admin.organizationId}/context-reviewer`;

    const adminCandidates = await app.inject({
      method: "GET",
      url: `${baseUrl}/candidates`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(adminCandidates.statusCode).toBe(200);
    expect(adminCandidates.json()).toMatchObject({
      items: [],
      blockers: [{ code: "context_review_no_eligible_agent" }],
    });

    const memberCandidates = await app.inject({
      method: "GET",
      url: `${baseUrl}/candidates`,
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(memberCandidates.statusCode).toBe(403);

    const invalidBody = await app.inject({
      method: "PUT",
      url: `${baseUrl}/assignment`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { agentUuid: privateAgent.uuid, assignedByMemberId: admin.memberId },
    });
    expect(invalidBody.statusCode).toBe(400);

    const privateAssignment = await app.inject({
      method: "PUT",
      url: `${baseUrl}/assignment`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { agentUuid: privateAgent.uuid },
    });
    expect(privateAssignment.statusCode).toBe(409);
    expect(privateAssignment.json()).toMatchObject({
      code: "context_review_agent_private",
    });
  });
});
