import { generateKeyPairSync, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { getTeamSetupCapabilities } from "../services/setup-capabilities.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const observedAt = new Date("2026-07-23T08:00:00.000Z");
const githubAppPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;
const githubAppCredentials = {
  appId: "12345",
  privateKeyPem: githubAppPrivateKey,
  slug: "first-tree-test",
  webhookSecret: "setup-webhook-secret",
};
const githubAppCredentialsWithoutSlug = {
  appId: githubAppCredentials.appId,
  privateKeyPem: githubAppCredentials.privateKeyPem,
  webhookSecret: githubAppCredentials.webhookSecret,
};

type Scenario = Awaited<ReturnType<typeof createScenario>>;

async function createScenario(app: FastifyInstance, role: "admin" | "member" = "admin") {
  const identity = await createTestAdmin(app);
  const organizationId = `org-setup-${randomUUID().slice(0, 8)}`;
  const memberId = uuidv7();
  let humanAgentUuid = "";

  await app.db.transaction(async (tx) => {
    await tx.insert(organizations).values({
      id: organizationId,
      name: `setup-${randomUUID().slice(0, 8)}`,
      displayName: "Setup Contract Team",
    });
    const human = await createAgent(tx as unknown as typeof app.db, {
      name: `setup-human-${randomUUID().slice(0, 8)}`,
      type: "human",
      displayName: "Setup Human",
      managerId: memberId,
      organizationId,
      source: "admin-api",
    });
    humanAgentUuid = human.uuid;
    await tx.insert(members).values({
      id: memberId,
      userId: identity.userId,
      organizationId,
      agentId: human.uuid,
      role,
    });
  });

  return { ...identity, organizationId, memberId, humanAgentUuid };
}

async function attachMember(app: FastifyInstance, organizationId: string, role: "admin" | "member"): Promise<Scenario> {
  const identity = await createTestAdmin(app);
  const memberId = uuidv7();
  let humanAgentUuid = "";
  await app.db.transaction(async (tx) => {
    const human = await createAgent(tx as unknown as typeof app.db, {
      name: `setup-human-${randomUUID().slice(0, 8)}`,
      type: "human",
      displayName: "Setup Human",
      managerId: memberId,
      organizationId,
      source: "admin-api",
    });
    humanAgentUuid = human.uuid;
    await tx.insert(members).values({
      id: memberId,
      userId: identity.userId,
      organizationId,
      agentId: human.uuid,
      role,
    });
  });
  return { ...identity, organizationId, memberId, humanAgentUuid };
}

async function seedSetting(
  app: FastifyInstance,
  scenario: Scenario,
  namespace: "context_tree" | "context_tree_features",
  value: Record<string, unknown>,
): Promise<void> {
  await app.db.insert(organizationSettings).values({
    organizationId: scenario.organizationId,
    namespace,
    value,
    version: 1,
    updatedBy: scenario.userId,
  });
}

async function seedGithubInstallation(
  app: FastifyInstance,
  scenario: Scenario,
  options: {
    accountLogin?: string;
    pullRequests?: "read" | "write";
    suspended?: boolean;
    events?: string[];
  } = {},
): Promise<void> {
  const installationId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 10), 16);
  await app.db.insert(githubAppInstallations).values({
    id: uuidv7(),
    installationId,
    accountType: "Organization",
    accountLogin: options.accountLogin ?? "acme",
    accountGithubId: installationId + 1,
    installerGithubId: installationId + 2,
    requesterGithubId: null,
    hubOrganizationId: scenario.organizationId,
    permissions: {
      metadata: "read",
      pull_requests: options.pullRequests ?? "write",
    },
    events: options.events ?? ["pull_request", "issue_comment", "pull_request_review_comment"],
    suspendedAt: options.suspended ? new Date("2026-07-22T08:00:00.000Z") : null,
  });
}

async function seedGitlabConnection(
  app: FastifyInstance,
  scenario: Scenario,
  options: {
    origin?: string;
    firstSeenAt?: Date | null;
    lastValidInboundAt?: Date | null;
    lastProcessingFailureAt?: Date | null;
  } = {},
): Promise<string> {
  const id = uuidv7();
  await app.db.insert(gitlabConnections).values({
    id,
    organizationId: scenario.organizationId,
    displayName: "Setup GitLab",
    instanceOrigin: options.origin ?? "https://gitlab.internal",
    tokenHash: `setup-${randomUUID()}`,
    endpointFirstSeenAt: options.firstSeenAt ?? null,
    lastValidInboundAt: options.lastValidInboundAt ?? null,
    lastProcessingFailureAt: options.lastProcessingFailureAt ?? null,
    createdByMemberId: scenario.memberId,
    updatedByMemberId: scenario.memberId,
  });
  return id;
}

async function createReviewer(
  app: FastifyInstance,
  scenario: Scenario,
  status: "active" | "suspended" = "active",
): Promise<{ uuid: string; displayName: string }> {
  const clientId = `setup-client-${randomUUID().slice(0, 8)}`;
  await app.db.insert(clients).values({
    id: clientId,
    userId: scenario.userId,
    organizationId: scenario.organizationId,
    status: "connected",
  });
  const reviewer = await createAgent(app.db, {
    name: `setup-reviewer-${randomUUID().slice(0, 8)}`,
    type: "agent",
    displayName: "Context Reviewer",
    managerId: scenario.memberId,
    organizationId: scenario.organizationId,
    clientId,
  });
  if (status !== "active") {
    await app.db.update(agents).set({ status }).where(eq(agents.uuid, reviewer.uuid));
  }
  return { uuid: reviewer.uuid, displayName: reviewer.displayName };
}

async function seedGithubReview(
  app: FastifyInstance,
  scenario: Scenario,
  options: {
    reviewer?: { uuid: string } | null;
    enabled?: boolean;
    accountLogin?: string;
    pullRequests?: "read" | "write";
    suspended?: boolean;
    events?: string[];
  } = {},
): Promise<void> {
  await seedSetting(app, scenario, "context_tree", {
    provider: "github",
    repo: "https://github.com/acme/setup-context-tree.git",
    branch: "main",
  });
  await seedSetting(app, scenario, "context_tree_features", {
    contextReviewer: {
      enabled: options.enabled ?? true,
      agentUuid: options.enabled === false ? null : (options.reviewer?.uuid ?? uuidv7()),
    },
  });
  await seedGithubInstallation(app, scenario, {
    accountLogin: options.accountLogin,
    pullRequests: options.pullRequests,
    suspended: options.suspended,
    events: options.events,
  });
}

async function seedGitlabReview(
  app: FastifyInstance,
  scenario: Scenario,
  options: {
    connectionOrigin?: string;
    repoOrigin?: string;
    firstSeenAt?: Date | null;
    lastValidInboundAt?: Date | null;
    lastProcessingFailureAt?: Date | null;
    reviewer: { uuid: string };
  },
): Promise<void> {
  await seedGitlabConnection(app, scenario, {
    origin: options.connectionOrigin,
    firstSeenAt: options.firstSeenAt,
    lastValidInboundAt: options.lastValidInboundAt,
    lastProcessingFailureAt: options.lastProcessingFailureAt,
  });
  await seedSetting(app, scenario, "context_tree", {
    provider: "gitlab",
    repo: `${options.repoOrigin ?? "https://gitlab.internal"}/acme/setup-context-tree.git`,
    branch: "main",
  });
  await seedSetting(app, scenario, "context_tree_features", {
    contextReviewer: { enabled: true, agentUuid: options.reviewer.uuid },
  });
}

function project(
  app: FastifyInstance,
  scenario: Scenario,
  probeGithubReview?: () => Promise<never | "ready" | "permission_required" | "repo_not_covered" | "failed">,
  options: {
    githubAppCredentials?: {
      appId: string;
      privateKeyPem: string;
      slug?: string;
      webhookSecret?: string;
    };
    githubFetch?: typeof fetch;
  } = { githubAppCredentials },
) {
  return getTeamSetupCapabilities(app.db, scenario.organizationId, {
    now: () => observedAt,
    ...options,
    ...(probeGithubReview ? { probeGithubReview } : {}),
  });
}

function withoutObservedAt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutObservedAt);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "observedAt")
      .map(([key, nested]) => [key, withoutObservedAt(nested)]),
  );
}

describe("Team setup capabilities", () => {
  const getApp = useTestApp();

  it("keeps untouched optional providers and an unbound Context Tree neutral", async () => {
    const app = getApp();
    const scenario = await createScenario(app);

    await expect(project(app, scenario)).resolves.toEqual({
      organizationId: scenario.organizationId,
      repositoryAutomation: {
        providers: [
          {
            provider: "github",
            adoption: "available",
            health: "not_observed",
            blockers: [],
            observedAt: observedAt.toISOString(),
          },
          {
            provider: "gitlab",
            adoption: "available",
            health: "not_observed",
            blockers: [],
            observedAt: observedAt.toISOString(),
          },
        ],
      },
      contextTree: {
        binding: { state: "unbound" },
        blockers: [],
        automaticReview: {
          adoption: "unavailable",
          health: "not_observed",
          reviewerAgent: null,
          blockers: [],
          observedAt: observedAt.toISOString(),
        },
      },
    });
  });

  it("fails closed for malformed, unresolved, and provider-mismatched Tree bindings", async () => {
    const app = getApp();
    const malformed = await createScenario(app);
    await seedSetting(app, malformed, "context_tree", { repo: "", branch: "main" });
    await expect(project(app, malformed)).resolves.toMatchObject({
      contextTree: {
        binding: { state: "invalid" },
        blockers: [{ code: "context_tree_binding_invalid", actionKind: "repair_tree_binding" }],
      },
    });

    const unresolved = await createScenario(app);
    await seedSetting(app, unresolved, "context_tree", {
      repo: "git@unknown.example:acme/tree.git",
      branch: "main",
    });
    await expect(project(app, unresolved)).resolves.toMatchObject({
      contextTree: {
        binding: { state: "invalid" },
        blockers: [{ code: "context_tree_provider_unresolved", actionKind: "repair_tree_binding" }],
      },
    });

    const mismatched = await createScenario(app);
    await seedSetting(app, mismatched, "context_tree", {
      provider: "github",
      repo: "https://gitlab.internal/acme/tree.git",
      branch: "main",
    });
    await expect(project(app, mismatched)).resolves.toMatchObject({
      contextTree: {
        binding: { state: "invalid" },
        blockers: [{ code: "context_tree_provider_unresolved", actionKind: "repair_tree_binding" }],
      },
    });
  });

  it("projects GitHub active, suspended, permission, coverage, and probe-failure states", async () => {
    const app = getApp();

    const ready = await createScenario(app);
    const readyReviewer = await createReviewer(app, ready);
    await seedGithubReview(app, ready, { reviewer: readyReviewer });
    const readyProjection = await project(app, ready, async () => "ready");
    expect(readyProjection.repositoryAutomation.providers[0]).toMatchObject({
      provider: "github",
      adoption: "enabled",
      health: "ready",
      blockers: [],
    });
    expect(readyProjection).toMatchObject({
      contextTree: {
        binding: { state: "bound", provider: "github" },
        automaticReview: {
          adoption: "enabled",
          health: "ready",
          reviewerAgent: readyReviewer,
          blockers: [],
        },
      },
    });

    const suspended = await createScenario(app);
    const suspendedReviewer = await createReviewer(app, suspended);
    await seedGithubReview(app, suspended, { reviewer: suspendedReviewer, suspended: true });
    const suspendedProbe = vi.fn(async () => "ready" as const);
    const suspendedProjection = await project(app, suspended, suspendedProbe);
    expect(suspendedProjection.repositoryAutomation.providers[0]).toMatchObject({
      provider: "github",
      adoption: "enabled",
      health: "unavailable",
      blockers: [{ code: "github_app_suspended" }],
    });
    expect(suspendedProjection).toMatchObject({
      contextTree: {
        automaticReview: {
          health: "unavailable",
          blockers: [{ code: "github_app_suspended" }],
        },
      },
    });
    expect(suspendedProbe).not.toHaveBeenCalled();

    const missingApp = await createScenario(app);
    const missingAppReviewer = await createReviewer(app, missingApp);
    await seedGithubReview(app, missingApp, { reviewer: missingAppReviewer });
    const missingAppProbe = vi.fn(async () => "ready" as const);
    const missingAppProjection = await project(app, missingApp, missingAppProbe, {
      githubAppCredentials: undefined,
    });
    expect(missingAppProjection.repositoryAutomation.providers[0]).toMatchObject({
      provider: "github",
      adoption: "enabled",
      health: "unavailable",
      blockers: [
        {
          code: "github_app_not_configured",
          resolutionOwner: "operator",
          actionKind: null,
        },
      ],
    });
    expect(missingAppProjection).toMatchObject({
      contextTree: {
        automaticReview: {
          health: "unavailable",
          blockers: [
            {
              code: "github_app_not_configured",
              resolutionOwner: "operator",
              actionKind: null,
            },
          ],
        },
      },
    });
    expect(missingAppProbe).not.toHaveBeenCalled();

    const permission = await createScenario(app);
    const permissionReviewer = await createReviewer(app, permission);
    await seedGithubReview(app, permission, { reviewer: permissionReviewer, pullRequests: "read" });
    const permissionProbe = vi.fn(async () => "ready" as const);
    await expect(project(app, permission, permissionProbe)).resolves.toMatchObject({
      contextTree: {
        automaticReview: {
          health: "unavailable",
          blockers: [{ code: "github_pull_requests_permission_required" }],
        },
      },
    });
    expect(permissionProbe).not.toHaveBeenCalled();

    const missingEvents = await createScenario(app);
    const missingEventsReviewer = await createReviewer(app, missingEvents);
    await seedGithubReview(app, missingEvents, { reviewer: missingEventsReviewer, events: [] });
    const missingEventsProbe = vi.fn(async () => "ready" as const);
    const missingEventsProjection = await project(app, missingEvents, missingEventsProbe);
    expect(missingEventsProjection.repositoryAutomation.providers[0]).toMatchObject({
      provider: "github",
      adoption: "enabled",
      health: "unavailable",
      blockers: [
        {
          code: "github_webhook_events_missing",
          resolutionOwner: "operator",
          actionKind: null,
        },
      ],
    });
    expect(missingEventsProjection).toMatchObject({
      contextTree: {
        automaticReview: {
          health: "unavailable",
          blockers: [
            {
              code: "github_webhook_events_missing",
              resolutionOwner: "operator",
              actionKind: null,
            },
          ],
        },
      },
    });
    expect(missingEventsProbe).not.toHaveBeenCalled();

    const missingCommentEvents = await createScenario(app);
    const missingCommentEventsReviewer = await createReviewer(app, missingCommentEvents);
    await seedGithubReview(app, missingCommentEvents, {
      reviewer: missingCommentEventsReviewer,
      events: ["pull_request"],
    });
    const missingCommentEventsProbe = vi.fn(async () => "ready" as const);
    const missingCommentEventsProjection = await project(app, missingCommentEvents, missingCommentEventsProbe);
    expect(missingCommentEventsProjection.repositoryAutomation.providers[0]).toMatchObject({
      provider: "github",
      adoption: "enabled",
      health: "ready",
      blockers: [],
    });
    expect(missingCommentEventsProjection).toMatchObject({
      contextTree: {
        automaticReview: {
          health: "unavailable",
          blockers: [
            {
              code: "github_webhook_events_missing",
              resolutionOwner: "operator",
              actionKind: null,
            },
          ],
        },
      },
    });
    expect(missingCommentEventsProbe).not.toHaveBeenCalled();

    const uncovered = await createScenario(app);
    const uncoveredReviewer = await createReviewer(app, uncovered);
    await seedGithubReview(app, uncovered, { reviewer: uncoveredReviewer });
    await expect(project(app, uncovered, async () => "repo_not_covered")).resolves.toMatchObject({
      contextTree: {
        automaticReview: {
          health: "unavailable",
          blockers: [{ code: "github_tree_repo_not_covered" }],
        },
      },
    });

    const failed = await createScenario(app);
    const failedReviewer = await createReviewer(app, failed);
    await seedGithubReview(app, failed, { reviewer: failedReviewer });
    await expect(
      project(app, failed, async () => {
        throw new Error("GitHub unavailable");
      }),
    ).resolves.toMatchObject({
      contextTree: {
        automaticReview: {
          health: "pending_verification",
          blockers: [{ code: "provider_probe_failed", resolutionOwner: "operator", actionKind: null }],
        },
      },
    });
  });

  it("uses a bounded exact-repo GitHub token preflight and maps live failures", async () => {
    const app = getApp();
    const response = (
      status: number,
      permissions: Record<string, "read" | "write" | "admin"> = {
        metadata: "read",
        pull_requests: "write",
      },
      repositorySelection: "all" | "selected" = "selected",
    ) =>
      new Response(
        JSON.stringify({
          token: "setup-token",
          expires_at: "2026-07-23T09:00:00.000Z",
          permissions,
          repository_selection: repositorySelection,
        }),
        { status, headers: { "content-type": "application/json" } },
      );

    const ready = await createScenario(app);
    const readyReviewer = await createReviewer(app, ready);
    await seedGithubReview(app, ready, { reviewer: readyReviewer });
    const readyFetch = vi.fn<typeof fetch>(async () => response(201));
    await expect(
      project(app, ready, undefined, { githubAppCredentials, githubFetch: readyFetch }),
    ).resolves.toMatchObject({
      contextTree: { automaticReview: { health: "ready", blockers: [] } },
    });
    expect(readyFetch).toHaveBeenCalledTimes(1);
    const [, readyRequest] = readyFetch.mock.calls[0] ?? [];
    expect(readyRequest?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(readyRequest?.body))).toEqual({
      repositories: ["setup-context-tree"],
      permissions: { metadata: "read", pull_requests: "write" },
    });

    const wrongOwner = await createScenario(app);
    const wrongOwnerReviewer = await createReviewer(app, wrongOwner);
    await seedGithubReview(app, wrongOwner, {
      reviewer: wrongOwnerReviewer,
      accountLogin: "different-owner",
    });
    const wrongOwnerFetch = vi.fn<typeof fetch>(async () => response(201));
    await expect(
      project(app, wrongOwner, undefined, { githubAppCredentials, githubFetch: wrongOwnerFetch }),
    ).resolves.toMatchObject({
      contextTree: {
        automaticReview: {
          health: "unavailable",
          blockers: [{ code: "github_tree_repo_not_covered" }],
        },
      },
    });
    expect(wrongOwnerFetch).not.toHaveBeenCalled();

    const missingSlug = await createScenario(app);
    const missingSlugReviewer = await createReviewer(app, missingSlug);
    await seedGithubReview(app, missingSlug, { reviewer: missingSlugReviewer });
    const missingSlugFetch = vi.fn<typeof fetch>(async () => response(201));
    await expect(
      project(app, missingSlug, undefined, {
        githubAppCredentials: githubAppCredentialsWithoutSlug,
        githubFetch: missingSlugFetch,
      }),
    ).resolves.toMatchObject({
      contextTree: {
        automaticReview: {
          health: "pending_verification",
          blockers: [{ code: "provider_probe_failed", resolutionOwner: "operator", actionKind: null }],
        },
      },
    });
    expect(missingSlugFetch).not.toHaveBeenCalled();

    const permission = await createScenario(app);
    const permissionReviewer = await createReviewer(app, permission);
    await seedGithubReview(app, permission, { reviewer: permissionReviewer });
    const permissionFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(403))
      .mockResolvedValueOnce(response(201, { metadata: "read", pull_requests: "read" }));
    await expect(
      project(app, permission, undefined, { githubAppCredentials, githubFetch: permissionFetch }),
    ).resolves.toMatchObject({
      contextTree: {
        automaticReview: {
          health: "unavailable",
          blockers: [{ code: "github_pull_requests_permission_required" }],
        },
      },
    });
    expect(permissionFetch).toHaveBeenCalledTimes(2);

    const uncovered = await createScenario(app);
    const uncoveredReviewer = await createReviewer(app, uncovered);
    await seedGithubReview(app, uncovered, { reviewer: uncoveredReviewer });
    const uncoveredFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(422))
      .mockResolvedValueOnce(response(201))
      .mockResolvedValueOnce(response(404));
    await expect(
      project(app, uncovered, undefined, { githubAppCredentials, githubFetch: uncoveredFetch }),
    ).resolves.toMatchObject({
      contextTree: {
        automaticReview: {
          health: "unavailable",
          blockers: [{ code: "github_tree_repo_not_covered" }],
        },
      },
    });
    expect(uncoveredFetch).toHaveBeenCalledTimes(3);
    const uncoveredSignals = uncoveredFetch.mock.calls.map(([, request]) => request?.signal);
    expect(uncoveredSignals.every((signal) => signal === uncoveredSignals[0])).toBe(true);

    const ambiguous = await createScenario(app);
    const ambiguousReviewer = await createReviewer(app, ambiguous);
    await seedGithubReview(app, ambiguous, { reviewer: ambiguousReviewer });
    const ambiguousFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(201, { metadata: "read", pull_requests: "write" }, "all"));
    await expect(
      project(app, ambiguous, undefined, { githubAppCredentials, githubFetch: ambiguousFetch }),
    ).resolves.toMatchObject({
      contextTree: {
        automaticReview: {
          health: "pending_verification",
          blockers: [{ code: "provider_probe_failed", resolutionOwner: "operator", actionKind: null }],
        },
      },
    });

    const failed = await createScenario(app);
    const failedReviewer = await createReviewer(app, failed);
    await seedGithubReview(app, failed, { reviewer: failedReviewer });
    const failedFetch = vi.fn<typeof fetch>(async () => response(503));
    await expect(
      project(app, failed, undefined, { githubAppCredentials, githubFetch: failedFetch }),
    ).resolves.toMatchObject({
      contextTree: {
        automaticReview: {
          health: "pending_verification",
          blockers: [{ code: "provider_probe_failed", resolutionOwner: "operator", actionKind: null }],
        },
      },
    });
  });

  it("does not run GitHub live coverage until the App and saved Reviewer are stable", async () => {
    const app = getApp();
    const missingInstallation = await createScenario(app);
    const missingInstallationReviewer = await createReviewer(app, missingInstallation);
    await seedGithubReview(app, missingInstallation, { reviewer: missingInstallationReviewer });
    await app.db
      .delete(githubAppInstallations)
      .where(eq(githubAppInstallations.hubOrganizationId, missingInstallation.organizationId));
    const missingInstallationProbe = vi.fn(async () => "ready" as const);
    await expect(project(app, missingInstallation, missingInstallationProbe)).resolves.toMatchObject({
      contextTree: {
        automaticReview: {
          health: "unavailable",
          blockers: [{ code: "context_review_provider_prerequisite_missing", actionKind: "connect_github" }],
        },
      },
    });
    expect(missingInstallationProbe).not.toHaveBeenCalled();

    const missing = await createScenario(app);
    await seedGithubReview(app, missing);
    const missingProbe = vi.fn(async () => "ready" as const);
    await expect(project(app, missing, missingProbe)).resolves.toMatchObject({
      contextTree: {
        automaticReview: {
          health: "unavailable",
          reviewerAgent: null,
          blockers: [{ code: "context_review_agent_missing", actionKind: "replace_review_agent" }],
        },
      },
    });
    expect(missingProbe).not.toHaveBeenCalled();

    const inactive = await createScenario(app);
    const inactiveReviewer = await createReviewer(app, inactive, "suspended");
    await seedGithubReview(app, inactive, { reviewer: inactiveReviewer });
    const inactiveProbe = vi.fn(async () => "ready" as const);
    await expect(project(app, inactive, inactiveProbe)).resolves.toMatchObject({
      contextTree: {
        automaticReview: {
          health: "unavailable",
          reviewerAgent: inactiveReviewer,
          blockers: [{ code: "context_review_agent_inactive", actionKind: "replace_review_agent" }],
        },
      },
    });
    expect(inactiveProbe).not.toHaveBeenCalled();
  });

  it("keeps a disabled Reviewer neutral on a valid binding", async () => {
    const app = getApp();
    const scenario = await createScenario(app);
    await seedGithubReview(app, scenario, { enabled: false });
    const probe = vi.fn(async () => "ready" as const);

    await expect(project(app, scenario, probe)).resolves.toMatchObject({
      contextTree: {
        binding: { state: "bound", provider: "github" },
        automaticReview: {
          adoption: "disabled",
          health: "not_observed",
          reviewerAgent: null,
          blockers: [],
        },
      },
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("projects GitLab pending, ready, degraded, simultaneous-provider, and invalid-connection states", async () => {
    const app = getApp();

    const pending = await createScenario(app);
    const pendingReviewer = await createReviewer(app, pending);
    await seedGitlabReview(app, pending, { reviewer: pendingReviewer });
    await expect(project(app, pending)).resolves.toMatchObject({
      repositoryAutomation: {
        providers: [
          {},
          {
            provider: "gitlab",
            adoption: "configuring",
            health: "pending_verification",
            blockers: [{ code: "gitlab_webhook_not_seen" }],
          },
        ],
      },
      contextTree: {
        binding: { state: "bound", provider: "gitlab" },
        automaticReview: {
          health: "pending_verification",
          blockers: [{ code: "gitlab_webhook_not_seen" }],
        },
      },
    });

    const ready = await createScenario(app);
    const readyReviewer = await createReviewer(app, ready);
    await seedGitlabReview(app, ready, {
      reviewer: readyReviewer,
      firstSeenAt: new Date("2026-07-22T08:00:00.000Z"),
      lastValidInboundAt: new Date("2026-07-22T09:00:00.000Z"),
    });
    await seedGithubInstallation(app, ready);
    await expect(project(app, ready)).resolves.toMatchObject({
      repositoryAutomation: {
        providers: [
          { provider: "github", adoption: "enabled", health: "ready", blockers: [] },
          { provider: "gitlab", adoption: "enabled", health: "ready", blockers: [] },
        ],
      },
      contextTree: {
        automaticReview: { adoption: "enabled", health: "ready", blockers: [] },
      },
    });

    const degraded = await createScenario(app);
    const degradedReviewer = await createReviewer(app, degraded);
    await seedGitlabReview(app, degraded, {
      reviewer: degradedReviewer,
      firstSeenAt: new Date("2026-07-22T08:00:00.000Z"),
      lastValidInboundAt: new Date("2026-07-22T09:00:00.000Z"),
      lastProcessingFailureAt: new Date("2026-07-22T10:00:00.000Z"),
    });
    await expect(project(app, degraded)).resolves.toMatchObject({
      repositoryAutomation: {
        providers: [
          {},
          {
            provider: "gitlab",
            adoption: "enabled",
            health: "degraded",
            blockers: [{ code: "gitlab_processing_failed", resolutionOwner: "admin", actionKind: null }],
          },
        ],
      },
      contextTree: {
        automaticReview: {
          health: "degraded",
          blockers: [{ code: "gitlab_processing_failed", resolutionOwner: "admin", actionKind: null }],
        },
      },
    });

    const mismatch = await createScenario(app);
    const mismatchReviewer = await createReviewer(app, mismatch);
    await seedGitlabReview(app, mismatch, {
      reviewer: mismatchReviewer,
      connectionOrigin: "https://gitlab.current",
      repoOrigin: "https://gitlab.previous",
      firstSeenAt: new Date("2026-07-22T08:00:00.000Z"),
      lastValidInboundAt: new Date("2026-07-22T09:00:00.000Z"),
    });
    await expect(project(app, mismatch)).resolves.toMatchObject({
      contextTree: {
        binding: { state: "bound", provider: "gitlab" },
        blockers: [],
        automaticReview: {
          adoption: "enabled",
          health: "unavailable",
          blockers: [
            {
              code: "context_tree_connection_mismatch",
              resolutionOwner: "admin",
              actionKind: "repair_tree_binding",
            },
          ],
        },
      },
    });

    const missingConnection = await createScenario(app);
    const missingConnectionReviewer = await createReviewer(app, missingConnection);
    await seedGitlabReview(app, missingConnection, {
      reviewer: missingConnectionReviewer,
      firstSeenAt: new Date("2026-07-22T08:00:00.000Z"),
      lastValidInboundAt: new Date("2026-07-22T09:00:00.000Z"),
    });
    await app.db
      .delete(gitlabConnections)
      .where(eq(gitlabConnections.organizationId, missingConnection.organizationId));
    await expect(project(app, missingConnection)).resolves.toMatchObject({
      repositoryAutomation: {
        providers: [{}, { provider: "gitlab", adoption: "available", health: "not_observed", blockers: [] }],
      },
      contextTree: {
        binding: { state: "bound", provider: "gitlab" },
        blockers: [],
        automaticReview: {
          adoption: "enabled",
          health: "unavailable",
          blockers: [
            {
              code: "context_review_provider_prerequisite_missing",
              resolutionOwner: "admin",
              actionKind: "connect_gitlab",
            },
          ],
        },
      },
    });
  });

  it("enforces active org membership, role-independent shape, and URL-selected multi-org isolation", async () => {
    const app = getApp();
    const admin = await createScenario(app, "admin");
    const member = await attachMember(app, admin.organizationId, "member");
    const foreign = await createTestAdmin(app);
    await seedSetting(app, admin, "context_tree", {
      provider: "github",
      repo: "https://github.com/acme/private-setup-tree.git",
      branch: "main",
    });
    const url = `/api/v1/orgs/${admin.organizationId}/setup-capabilities`;

    const adminResponse = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const memberResponse = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(adminResponse.statusCode).toBe(200);
    expect(memberResponse.statusCode).toBe(200);
    expect(withoutObservedAt(adminResponse.json())).toEqual(withoutObservedAt(memberResponse.json()));

    await app.db.update(members).set({ role: "admin" }).where(eq(members.id, member.memberId));
    const promotedResponse = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(promotedResponse.statusCode).toBe(200);
    expect(withoutObservedAt(promotedResponse.json())).toEqual(withoutObservedAt(memberResponse.json()));

    const secondOrg = await createScenario(app, "admin");
    const secondMembership = await attachMember(app, secondOrg.organizationId, "member");
    await app.db
      .update(members)
      .set({ userId: admin.userId, agentId: secondMembership.humanAgentUuid })
      .where(eq(members.id, secondMembership.memberId));
    const secondResponse = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${secondOrg.organizationId}/setup-capabilities`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toMatchObject({
      organizationId: secondOrg.organizationId,
      contextTree: { binding: { state: "unbound" } },
    });
    expect(secondResponse.body).not.toContain("private-setup-tree");

    const foreignResponse = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${foreign.accessToken}` },
    });
    expect(foreignResponse.statusCode).toBe(403);
    expect(foreignResponse.body).not.toContain("private-setup-tree");

    await app.db.update(members).set({ status: "left" }).where(eq(members.id, member.memberId));
    const inactiveResponse = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(inactiveResponse.statusCode).toBe(403);
    expect(inactiveResponse.body).not.toContain("private-setup-tree");
  });
});
