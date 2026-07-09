import { afterEach, describe, expect, it, vi } from "vitest";
import { agentMeRoutes } from "../api/agent/me.js";
import { contextTreeInfoRoutes } from "../api/context-tree-info.js";
import { sessionRoutes } from "../api/sessions.js";
import type { Config } from "../config.js";
import { ClientOrgMismatchError } from "../errors.js";
import { resolveOrgViewer } from "../scope/require-resource.js";
import { requireResourceAccess } from "../scope/require-resource-access.js";
import {
  assertNoRuntimeSwitchInProgress,
  getRuntimeSwitchClaim,
  MIN_RUNTIME_SWITCH_CLIENT_VERSION,
  recoverAgentRuntimeSwitch,
} from "../services/agent-runtime-switch.js";
import {
  assertMetadataDoesNotClaimLandingCampaignTrial,
  assertMutableAgentIsNotLandingCampaignTrial,
  isLandingCampaignServiceMembership,
  isLandingCampaignServiceOrg,
} from "../services/landing-campaigns/guards.js";
import {
  buildLandingCampaignAgentMetadata,
  buildLandingCampaignChatMetadata,
  getLandingCampaignTrialChat,
  withLandingCampaignChatState,
} from "../services/landing-campaigns/metadata.js";

type ChainRows = unknown[];

function queryChain(rows: unknown[] = []): unknown {
  const promise = Promise.resolve(rows);
  const chain = new Proxy(
    function queryProxy(): unknown {
      return chain;
    },
    {
      get: (_target, prop) => {
        if (prop === "then") return promise.then.bind(promise);
        if (prop === "catch") return promise.catch.bind(promise);
        if (prop === "finally") return promise.finally.bind(promise);
        if (prop === Symbol.iterator) return rows[Symbol.iterator].bind(rows);
        if (prop === "returning") return vi.fn(async () => rows);
        if (prop === "for") return vi.fn(() => chain);
        return vi.fn(() => chain);
      },
      apply: () => chain,
    },
  );
  return chain;
}

function queuedSelectDb(results: ChainRows[]): { select: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } {
  return {
    select: vi.fn(() => queryChain(results.shift() ?? [])),
    update: vi.fn(() => queryChain(results.shift() ?? [])),
  };
}

type Captured = { method: string; path: string; handler: (...args: unknown[]) => unknown };

function captureApp(overrides: Record<string, unknown> = {}): {
  app: Record<string, unknown>;
  routes: Captured[];
} {
  const routes: Captured[] = [];
  const register =
    (method: string) =>
    (path: string, optionsOrHandler?: unknown, maybeHandler?: unknown): unknown => {
      const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
      if (typeof handler !== "function") throw new Error("missing handler");
      routes.push({ method, path, handler: handler as (...args: unknown[]) => unknown });
      return app;
    };
  const app: Record<string, unknown> = {
    db: {},
    config: {},
    get: register("GET"),
    post: register("POST"),
    ...overrides,
  };
  return { app, routes };
}

describe("branch coverage wave3 — scope + routes", () => {
  it("covers resolveOrgViewer and requireResourceAccess decision tree", async () => {
    await expect(resolveOrgViewer(queuedSelectDb([[]]) as never, "u", "o")).resolves.toBeNull();
    await expect(
      resolveOrgViewer(queuedSelectDb([[{ id: "m", role: "owner", agentId: "h" }]]) as never, "u", "o"),
    ).resolves.toBeNull();
    await expect(
      resolveOrgViewer(queuedSelectDb([[{ id: "m", role: "admin", agentId: "h" }]]) as never, "u", "o"),
    ).resolves.toEqual({ memberId: "m", humanAgentId: "h" });

    const req = (resourceId: string, userId = "user_1") => ({ params: { resourceId }, user: { userId } }) as never;

    // missing resource
    await expect(requireResourceAccess(req("r1"), queuedSelectDb([[]]) as never, "read")).rejects.toThrow(
      "Resource not found",
    );

    // retired resource
    await expect(
      requireResourceAccess(
        req("r1"),
        queuedSelectDb([[{ id: "r1", status: "retired", organizationId: "o", scope: "team", type: "repo" }]]) as never,
        "read",
      ),
    ).rejects.toThrow("Resource not found");

    // team write by non-admin
    await expect(
      requireResourceAccess(
        req("r1"),
        queuedSelectDb([
          [{ id: "r1", status: "active", organizationId: "o", scope: "team", type: "repo", ownerAgentId: null }],
          [{ id: "m", role: "member", agentId: "h" }],
        ]) as never,
        "write",
      ),
    ).rejects.toThrow("Resource not found");

    // team read by member ok
    await expect(
      requireResourceAccess(
        req("r1"),
        queuedSelectDb([
          [{ id: "r1", status: "active", organizationId: "o", scope: "team", type: "repo", ownerAgentId: null }],
          [{ id: "m", role: "member", agentId: "h" }],
        ]) as never,
        "read",
      ),
    ).resolves.toMatchObject({ scope: { role: "member" } });

    // invalid agent-scoped resource shape
    await expect(
      requireResourceAccess(
        req("r1"),
        queuedSelectDb([
          [{ id: "r1", status: "active", organizationId: "o", scope: "agent", type: "prompt", ownerAgentId: null }],
          [{ id: "m", role: "admin", agentId: "h" }],
        ]) as never,
        "read",
      ),
    ).rejects.toThrow("Resource not found");

    // missing owner agent
    await expect(
      requireResourceAccess(
        req("r1"),
        queuedSelectDb([
          [
            {
              id: "r1",
              status: "active",
              organizationId: "o",
              scope: "agent",
              type: "repo",
              ownerAgentId: "agent_x",
            },
          ],
          [{ id: "m", role: "admin", agentId: "h" }],
          [],
        ]) as never,
        "read",
      ),
    ).rejects.toThrow("Resource not found");

    // agent write by non-manager non-admin
    await expect(
      requireResourceAccess(
        req("r1"),
        queuedSelectDb([
          [
            {
              id: "r1",
              status: "active",
              organizationId: "o",
              scope: "agent",
              type: "repo",
              ownerAgentId: "agent_x",
            },
          ],
          [{ id: "m", role: "member", agentId: "h" }],
          [
            {
              uuid: "agent_x",
              organizationId: "o",
              managerId: "other",
              status: "active",
              visibility: "private",
            },
          ],
        ]) as never,
        "write",
      ),
    ).rejects.toThrow("Resource not found");

    // agent write by manager
    await expect(
      requireResourceAccess(
        req("r1"),
        queuedSelectDb([
          [
            {
              id: "r1",
              status: "active",
              organizationId: "o",
              scope: "agent",
              type: "repo",
              ownerAgentId: "agent_x",
            },
          ],
          [{ id: "m", role: "member", agentId: "h" }],
          [
            {
              uuid: "agent_x",
              organizationId: "o",
              managerId: "m",
              status: "active",
              visibility: "private",
            },
          ],
        ]) as never,
        "write",
      ),
    ).resolves.toMatchObject({ resource: { id: "r1" } });

    // agent read private by non-manager
    await expect(
      requireResourceAccess(
        req("r1"),
        queuedSelectDb([
          [
            {
              id: "r1",
              status: "active",
              organizationId: "o",
              scope: "agent",
              type: "repo",
              ownerAgentId: "agent_x",
            },
          ],
          [{ id: "m", role: "member", agentId: "h" }],
          [
            {
              uuid: "agent_x",
              organizationId: "o",
              managerId: "other",
              status: "active",
              visibility: "private",
            },
          ],
        ]) as never,
        "read",
      ),
    ).rejects.toThrow("Resource not found");

    // agent read org-visible
    await expect(
      requireResourceAccess(
        req("r1"),
        queuedSelectDb([
          [
            {
              id: "r1",
              status: "active",
              organizationId: "o",
              scope: "agent",
              type: "repo",
              ownerAgentId: "agent_x",
            },
          ],
          [{ id: "m", role: "member", agentId: "h" }],
          [
            {
              uuid: "agent_x",
              organizationId: "o",
              managerId: "other",
              status: "active",
              visibility: "organization",
            },
          ],
        ]) as never,
        "read",
      ),
    ).resolves.toMatchObject({ resource: { id: "r1" } });
  });

  it("covers agent /me null presence nullish fields", async () => {
    const agentService = await import("../services/agent.js");
    const presenceService = await import("../services/presence.js");
    const getAgentSpy = vi.spyOn(agentService, "getAgent").mockResolvedValue({
      uuid: "a1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    } as never);
    const getPresenceSpy = vi.spyOn(presenceService, "getPresence").mockResolvedValue(null as never);

    const { app, routes } = captureApp({ db: {} });
    await agentMeRoutes(app as never);
    const me = routes.find((r) => r.path === "/me");
    expect(me).toBeDefined();

    const request = {
      agent: { uuid: "a1", inboxId: "in1", clientId: null },
    };

    await expect(me?.handler(request as never)).resolves.toMatchObject({
      clientId: null,
      runtimeType: null,
      runtimeVersion: null,
      runtimeState: null,
      activeSessions: null,
      totalSessions: null,
    });

    getPresenceSpy.mockResolvedValue({
      clientId: "c",
      runtimeType: "codex",
      runtimeVersion: "1",
      runtimeState: "idle",
      activeSessions: 1,
      totalSessions: 2,
    } as never);
    await expect(me?.handler(request as never)).resolves.toMatchObject({
      clientId: "c",
      runtimeType: "codex",
      totalSessions: 2,
    });

    getAgentSpy.mockRestore();
    getPresenceSpy.mockRestore();
  });

  it("covers context-tree info null org and null tree fields", async () => {
    const orgSettings = await import("../services/org-settings.js");
    const requireUser = await import("../scope/require-user.js");
    const resolveSpy = vi.spyOn(orgSettings, "resolveUserPrimaryOrgId").mockResolvedValue(null);
    const treeSpy = vi.spyOn(orgSettings, "getOrgContextTree");
    const userSpy = vi.spyOn(requireUser, "requireUser").mockReturnValue({ userId: "u1" } as never);

    const { app, routes } = captureApp({ db: {} });
    await contextTreeInfoRoutes(app as never);
    const info = routes[0];
    expect(info).toBeDefined();
    await expect(info?.handler({} as never)).resolves.toEqual({ repo: null, branch: null });

    resolveSpy.mockResolvedValue("org_1");
    treeSpy.mockResolvedValue({ repo: undefined, branch: undefined } as never);
    await expect(info?.handler({} as never)).resolves.toEqual({ repo: null, branch: null });

    treeSpy.mockResolvedValue({ repo: "https://github.com/a/b.git", branch: "main" } as never);
    await expect(info?.handler({} as never)).resolves.toEqual({
      repo: "https://github.com/a/b.git",
      branch: "main",
    });

    resolveSpy.mockRestore();
    treeSpy.mockRestore();
    userSpy.mockRestore();
  });

  it("covers session list admin/manager vs filter and event query parsing", async () => {
    const requireResource = await import("../scope/require-resource.js");
    const sessionService = await import("../services/session.js");
    const sessionEventService = await import("../services/session-event.js");

    const accessSpy = vi.spyOn(requireResource, "requireAgentAccess");
    const chatSpy = vi.spyOn(requireResource, "requireChatAccess").mockResolvedValue({} as never);
    const listSpy = vi.spyOn(sessionService, "listAgentSessions").mockResolvedValue([{ chatId: "c1" }] as never);
    const filterSpy = vi
      .spyOn(sessionService, "filterSessionsByParticipant")
      .mockResolvedValue([{ chatId: "c1", filtered: true }] as never);
    const getSessionSpy = vi
      .spyOn(sessionService, "getSession")
      .mockResolvedValue({ state: "active", chatId: "c1" } as never);
    const listEventsSpy = vi.spyOn(sessionEventService, "listEvents").mockResolvedValue({ items: [] } as never);

    const { app, routes } = captureApp({ db: {}, notifier: {} });
    await sessionRoutes(app as never);

    const listRoute = routes.find((r) => r.path === "/:uuid/sessions");
    const eventsRoute = routes.find((r) => r.path === "/:uuid/sessions/:chatId/events");
    expect(listRoute && eventsRoute).toBeTruthy();

    accessSpy.mockResolvedValue({
      agent: { uuid: "a1", managerId: "m1" },
      scope: { memberId: "m1", role: "member", humanAgentId: "h1" },
    } as never);
    await expect(listRoute?.handler({ query: {} } as never)).resolves.toEqual([{ chatId: "c1" }]);

    accessSpy.mockResolvedValue({
      agent: { uuid: "a1", managerId: "other" },
      scope: { memberId: "m1", role: "admin", humanAgentId: "h1" },
    } as never);
    await expect(listRoute?.handler({ query: {} } as never)).resolves.toEqual([{ chatId: "c1" }]);

    accessSpy.mockResolvedValue({
      agent: { uuid: "a1", managerId: "other" },
      scope: { memberId: "m1", role: "member", humanAgentId: "h1" },
    } as never);
    await expect(listRoute?.handler({ query: {} } as never)).resolves.toEqual([{ chatId: "c1", filtered: true }]);
    expect(filterSpy).toHaveBeenCalled();

    accessSpy.mockResolvedValue({
      agent: { uuid: "a1", managerId: "m1" },
      scope: { memberId: "m1", role: "admin", humanAgentId: "h1" },
    } as never);
    await expect(
      eventsRoute?.handler({
        params: { uuid: "a1", chatId: "c1" },
        query: { limit: "10", cursor: "5", direction: "desc" },
      } as never),
    ).resolves.toEqual({ items: [] });
    expect(listEventsSpy).toHaveBeenCalledWith(expect.anything(), "a1", "c1", {
      limit: 10,
      cursor: 5,
      direction: "desc",
    });

    await expect(
      eventsRoute?.handler({
        params: { uuid: "a1", chatId: "c1" },
        query: { limit: "nope", cursor: "nope", direction: "asc" },
      } as never),
    ).resolves.toEqual({ items: [] });
    expect(listEventsSpy).toHaveBeenLastCalledWith(expect.anything(), "a1", "c1", {
      limit: undefined,
      cursor: undefined,
      direction: "asc",
    });

    accessSpy.mockRestore();
    chatSpy.mockRestore();
    listSpy.mockRestore();
    filterSpy.mockRestore();
    getSessionSpy.mockRestore();
    listEventsSpy.mockRestore();
  });
});

describe("branch coverage wave3 — runtime switch + landing guards + errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("covers runtime switch claim parsing and recovery early exits", async () => {
    expect(getRuntimeSwitchClaim(undefined)).toBeNull();
    expect(getRuntimeSwitchClaim({ runtimeSwitch: null })).toBeNull();
    expect(getRuntimeSwitchClaim({ runtimeSwitch: "x" })).toBeNull();
    const validClaim = {
      claimId: "c1",
      phase: "claimed" as const,
      oldClientId: "old",
      targetClientId: "t",
      oldRuntimeProvider: "codex",
      targetRuntimeProvider: "claude-code",
      claimedAt: "2026-01-01T00:00:00.000Z",
      claimedByUserId: "u1",
      claimedByMemberId: "m1",
    };
    expect(getRuntimeSwitchClaim({ runtimeSwitch: validClaim })).toMatchObject({
      claimId: "c1",
      phase: "claimed",
      oldClientId: "old",
    });
    // oldClientId must be string — null fails claim parse
    expect(getRuntimeSwitchClaim({ runtimeSwitch: { ...validClaim, oldClientId: null } })).toBeNull();

    expect(() =>
      assertNoRuntimeSwitchInProgress({
        metadata: { runtimeSwitch: { ...validClaim, phase: "committed" } },
      }),
    ).toThrow("in progress");
    expect(() => assertNoRuntimeSwitchInProgress({ metadata: { runtimeSwitch: { claimId: 99 } } })).toThrow(
      "in progress",
    );

    await expect(recoverAgentRuntimeSwitch(queuedSelectDb([]) as never, "a1")).rejects.toThrow(
      "requires agent HTTP runtime-session enforcement",
    );
    await expect(
      recoverAgentRuntimeSwitch(queuedSelectDb([[]]) as never, "a1", { runtimeHttpTokenEnforced: true }),
    ).rejects.toThrow("not found");
    await expect(
      recoverAgentRuntimeSwitch(queuedSelectDb([[{ uuid: "a1", status: "deleted", metadata: {} }]]) as never, "a1", {
        runtimeHttpTokenEnforced: true,
      }),
    ).rejects.toThrow("not found");
    await expect(
      recoverAgentRuntimeSwitch(queuedSelectDb([[{ uuid: "a1", status: "active", metadata: {} }]]) as never, "a1", {
        runtimeHttpTokenEnforced: true,
      }),
    ).rejects.toThrow("no runtime switch recovery state");
    await expect(
      recoverAgentRuntimeSwitch(
        queuedSelectDb([[{ uuid: "a1", status: "active", metadata: { runtimeSwitch: { claimId: 1 } } }]]) as never,
        "a1",
        { runtimeHttpTokenEnforced: true },
      ),
    ).rejects.toThrow("malformed");
    await expect(
      recoverAgentRuntimeSwitch(
        queuedSelectDb([
          [{ uuid: "a1", status: "active", metadata: { runtimeSwitch: { claimId: "c1", phase: "weird" } } }],
        ]) as never,
        "a1",
        { runtimeHttpTokenEnforced: true },
      ),
    ).rejects.toThrow("malformed");

    expect(MIN_RUNTIME_SWITCH_CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("covers landing-campaign guard branches with incomplete config", () => {
    const empty = { growth: {} } as Config;
    const partial = { growth: { landingCampaigns: {} } } as Config;
    const full = {
      growth: {
        landingCampaigns: {
          serviceOrgId: "so",
          serviceUserId: "su",
        },
      },
    } as Config;

    expect(isLandingCampaignServiceOrg(empty, "so")).toBe(false);
    expect(isLandingCampaignServiceOrg(partial, "so")).toBe(false);
    expect(isLandingCampaignServiceOrg(full, "so")).toBe(true);
    expect(isLandingCampaignServiceOrg(full, null)).toBe(false);
    expect(isLandingCampaignServiceMembership(empty, { userId: "su", organizationId: "x" })).toBe(false);
    expect(isLandingCampaignServiceMembership(full, { userId: "su", organizationId: "so" })).toBe(false);
    expect(isLandingCampaignServiceMembership(full, { userId: "su", organizationId: null })).toBe(false);
    expect(isLandingCampaignServiceMembership(full, { userId: "su", organizationId: "customer" })).toBe(true);

    expect(() => assertMetadataDoesNotClaimLandingCampaignTrial(undefined)).not.toThrow();
    expect(() => assertMetadataDoesNotClaimLandingCampaignTrial({})).not.toThrow();
    expect(() => assertMetadataDoesNotClaimLandingCampaignTrial({ landingCampaignTrial: false })).not.toThrow();
    expect(() => assertMetadataDoesNotClaimLandingCampaignTrial({ landingCampaignTrial: true })).toThrow();

    const agentMeta = buildLandingCampaignAgentMetadata({
      campaign: "portfolio",
      skillSetId: "portfolio",
      skillSetVersion: "v1",
    });
    expect(() => assertMutableAgentIsNotLandingCampaignTrial({ metadata: agentMeta })).toThrow();
    expect(() => assertMutableAgentIsNotLandingCampaignTrial({ metadata: {} })).not.toThrow();

    const chatMeta = buildLandingCampaignChatMetadata({
      campaign: "portfolio",
      agentId: "a1",
      skillSetId: "portfolio",
      skillSetVersion: "v1",
      repo: {
        url: "https://github.com/a/b",
        canonicalKey: "github.com/a/b",
        owner: "a",
        name: "b",
      },
      state: "awaiting_user",
      inputLocked: true,
      awaitingUserKind: "follow_up",
      maxAgentTurns: 2,
      limitReason: "turns",
    });
    const running = withLandingCampaignChatState(chatMeta, "running", false);
    expect(getLandingCampaignTrialChat({ metadata: running })).toMatchObject({ state: "running", inputLocked: false });
    expect(getLandingCampaignTrialChat({ metadata: running })).not.toHaveProperty("awaitingUserKind");
    expect(getLandingCampaignTrialChat({ metadata: agentMeta })).toBeNull();
  });

  it("constructs ClientOrgMismatchError with default message branch", () => {
    const err = new ClientOrgMismatchError();
    expect(err.code).toBe("CLIENT_ORG_MISMATCH");
    expect(err.message).toContain("different organization");
    expect(new ClientOrgMismatchError("custom").message).toBe("custom");
  });
});
