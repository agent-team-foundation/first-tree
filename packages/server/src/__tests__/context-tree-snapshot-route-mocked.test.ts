import type { ContextTreeSnapshot } from "@first-tree/shared";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

function unavailableSnapshot(detail: string): ContextTreeSnapshot {
  return {
    repo: "agent-team-foundation/first-tree-context",
    branch: "main",
    headCommit: null,
    syncedAt: null,
    snapshotStatus: "unavailable",
    contextStatus: { label: "Team context unavailable", detail, severity: "error" },
    summary: { addedCount: 0, editedCount: 0, removedCount: 0, changedNodeCount: 0 },
    usage: { windowDays: 7, agentCount: 0, usageCount: 0, recentEvents: [] },
    io: {
      windowDays: 7,
      summary: {
        read: { agentCount: 0, eventCount: 0, targetCount: 0 },
        write: { agentCount: 0, eventCount: 0, targetCount: 0 },
      },
      agents: [],
      recentEvents: [],
      writes: [],
      writesTotal: 0,
      skipped: { windowDays: 7, totalEventCount: 0, reasons: [] },
    },
    updates: [],
    nodes: [],
    edges: [],
    changes: [],
  };
}

async function setupRoute(input: { orgId: string | null; githubRemote?: boolean; snapshot?: ContextTreeSnapshot }) {
  vi.resetModules();

  const snapshot = input.snapshot ?? unavailableSnapshot("mock snapshot");
  const resolveUserPrimaryOrgId = vi.fn().mockResolvedValue(input.orgId);
  const getOrgContextTreeBinding = vi.fn().mockResolvedValue({
    repo: "https://github.com/acme/context-tree.git",
    branch: "main",
  });
  const getOrgContextReviewRuntime = vi.fn().mockResolvedValue(
    input.orgId
      ? {
          provider: "github",
          repo: "https://github.com/acme/context-tree.git",
          branch: "main",
          providerSource: "declared",
          providerMatchesRepository: true,
          gitlabConnection: null,
          contextReviewer: { enabled: false, agentUuid: null },
        }
      : null,
  );
  const isOrgContextTreeBindingRuntimeCurrent = vi.fn().mockResolvedValue(true);
  const getContextTreeSnapshot = vi.fn().mockResolvedValue(snapshot);
  const isGithubRemoteBinding = vi.fn().mockReturnValue(input.githubRemote ?? false);
  const findInstallationByOrg = vi.fn().mockResolvedValue({ installationId: 123 });
  const mintContextTreeInstallationToken = vi.fn().mockResolvedValue({
    ok: false,
    reason: "no-installation",
  });
  const resolveContextTreeRecoveryAction = vi.fn().mockResolvedValue("manage_github_app_installation");
  const resolveOrgViewer = vi.fn().mockResolvedValue({ memberId: "member-1", role: "admin" });
  const summarizeContextTreeUsage = vi.fn().mockResolvedValue({
    windowDays: 7,
    agentCount: 1,
    usageCount: 2,
    recentEvents: [],
  });
  const buildContextTreeIoSummary = vi.fn().mockResolvedValue({
    windowDays: 7,
    summary: {
      read: { agentCount: 1, eventCount: 1, targetCount: 1 },
      write: { agentCount: 0, eventCount: 0, targetCount: 0 },
    },
    agents: [],
    recentEvents: [],
    writes: [],
    writesTotal: 0,
    skipped: { windowDays: 7, totalEventCount: 0, reasons: [] },
  });

  vi.doMock("../scope/require-user.js", () => ({
    requireUser: () => ({ userId: "user-1" }),
  }));
  vi.doMock("../services/org-settings.js", () => ({
    getOrgContextReviewRuntime,
    getOrgContextTreeBinding,
    isOrgContextTreeBindingRuntimeCurrent,
    resolveUserPrimaryOrgId,
  }));
  vi.doMock("../services/context-tree-snapshot.js", () => ({
    contextTreeSnapshotWindowDays: () => 7,
    getContextTreeSnapshot,
    isGithubRemoteBinding,
  }));
  vi.doMock("../services/github-app-installations.js", () => ({ findInstallationByOrg }));
  vi.doMock("../services/github-app-token.js", () => ({
    mintContextTreeInstallationToken,
    resolveContextTreeRecoveryAction,
  }));
  vi.doMock("../scope/require-resource.js", () => ({ resolveOrgViewer }));
  vi.doMock("../services/session-event.js", () => ({ summarizeContextTreeUsage }));
  vi.doMock("../services/context-tree-io.js", () => ({ buildContextTreeIoSummary }));

  const { contextTreeSnapshotRoutes } = await import("../api/context-tree-snapshot.js");
  const app = Object.assign(Fastify(), {
    db: {},
    config: { oauth: { githubApp: {} } },
  });
  await app.register(contextTreeSnapshotRoutes);
  await app.ready();

  return {
    app,
    mocks: {
      buildContextTreeIoSummary,
      findInstallationByOrg,
      getOrgContextReviewRuntime,
      getContextTreeSnapshot,
      getOrgContextTreeBinding,
      isOrgContextTreeBindingRuntimeCurrent,
      isGithubRemoteBinding,
      mintContextTreeInstallationToken,
      resolveContextTreeRecoveryAction,
      resolveOrgViewer,
      resolveUserPrimaryOrgId,
      summarizeContextTreeUsage,
    },
  };
}

describe("context tree snapshot user route with mocked dependencies", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("keeps snapshot-provided usage and io when the user has no active organization", async () => {
    const ctx = await setupRoute({ orgId: null });
    const res = await ctx.app.inject({ method: "GET", url: "/snapshot?window=1d" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ snapshotStatus: "unavailable", recoveryAction: null });
    expect(ctx.mocks.getOrgContextTreeBinding).not.toHaveBeenCalled();
    expect(ctx.mocks.findInstallationByOrg).not.toHaveBeenCalled();
    expect(ctx.mocks.summarizeContextTreeUsage).not.toHaveBeenCalled();
    expect(ctx.mocks.buildContextTreeIoSummary).not.toHaveBeenCalled();
    await ctx.app.close();
  });

  it("mints snapshot credentials without adding App guidance and reconciles org telemetry", async () => {
    const ctx = await setupRoute({ orgId: "org-1", githubRemote: true });
    const res = await ctx.app.inject({ method: "GET", url: "/snapshot?window=30d" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      recoveryAction: "manage_github_app_installation",
      contextStatus: { detail: "mock snapshot" },
      usage: { windowDays: 7, agentCount: 1, usageCount: 2 },
      io: { windowDays: 7, summary: { read: { eventCount: 1 } } },
    });
    expect(res.json<{ contextStatus: { detail: string } }>().contextStatus.detail).not.toContain("GitHub App");
    expect(ctx.mocks.findInstallationByOrg).toHaveBeenCalledWith(ctx.app.db, "org-1");
    expect(ctx.mocks.mintContextTreeInstallationToken).toHaveBeenCalled();
    expect(ctx.mocks.resolveContextTreeRecoveryAction).toHaveBeenCalled();
    expect(ctx.mocks.resolveOrgViewer).toHaveBeenCalledWith(ctx.app.db, "user-1", "org-1");
    expect(ctx.mocks.summarizeContextTreeUsage).toHaveBeenCalled();
    expect(ctx.mocks.buildContextTreeIoSummary).toHaveBeenCalled();
    await ctx.app.close();
  });

  it("drives the snapshot from one live runtime tuple instead of a separately read stale binding", async () => {
    const ctx = await setupRoute({ orgId: "org-1" });
    ctx.mocks.getOrgContextTreeBinding.mockResolvedValue({
      provider: "gitlab",
      repo: "https://gitlab.example/acme/old-tree.git",
      branch: "old-branch",
    });
    ctx.mocks.getOrgContextReviewRuntime.mockResolvedValue({
      provider: "gitlab",
      repo: "https://gitlab.example/acme/new-tree.git",
      branch: "new-branch",
      providerSource: "declared",
      providerMatchesRepository: true,
      gitlabConnection: {
        id: "connection-1",
        instanceOrigin: "https://gitlab.example",
        endpointSeen: true,
        lastValidInboundAt: null,
      },
      contextReviewer: { enabled: true, agentUuid: "reviewer-1" },
    });

    const res = await ctx.app.inject({ method: "GET", url: "/snapshot" });

    expect(res.statusCode).toBe(200);
    expect(ctx.mocks.getOrgContextTreeBinding).not.toHaveBeenCalled();
    expect(ctx.mocks.getContextTreeSnapshot).toHaveBeenCalledWith(
      {
        provider: "gitlab",
        repo: "https://gitlab.example/acme/new-tree.git",
        branch: "new-branch",
        githubToken: undefined,
      },
      "7d",
      expect.objectContaining({ gitlabInstanceOrigin: "https://gitlab.example" }),
    );
    await ctx.app.close();
  });
});
