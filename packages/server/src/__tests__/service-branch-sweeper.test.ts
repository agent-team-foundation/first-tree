import { MESSAGE_FORMATS } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import * as activityService from "../services/activity.js";
import * as agentService from "../services/agent.js";
import * as agentRuntimeSwitchService from "../services/agent-runtime-switch.js";
import * as authService from "../services/auth.js";
import * as chatService from "../services/chat.js";
import * as clientService from "../services/client.js";
import * as contextReviewerPrService from "../services/context-reviewer-pr.js";
import * as contextTreeIoService from "../services/context-tree-io.js";
import * as documentService from "../services/document.js";
import * as githubAppService from "../services/github-app.js";
import * as githubAppInstallationsService from "../services/github-app-installations.js";
import * as githubAppTokenService from "../services/github-app-token.js";
import * as githubAudienceService from "../services/github-audience.js";
import * as githubDeliveryService from "../services/github-delivery.js";
import * as githubEntityChatService from "../services/github-entity-chat.js";
import * as githubEntityFollowService from "../services/github-entity-follow.js";
import * as githubEntityKeyService from "../services/github-entity-key.js";
import * as githubNormalizeService from "../services/github-normalize.js";
import * as githubOauthService from "../services/github-oauth.js";
import * as inboxService from "../services/inbox.js";
import * as invitationService from "../services/invitation.js";
import * as landingCampaignChatState from "../services/landing-campaigns/chat-state.js";
import * as landingCampaignGuards from "../services/landing-campaigns/guards.js";
import * as landingCampaignMetadata from "../services/landing-campaigns/metadata.js";
import * as landingCampaignSkillCatalog from "../services/landing-campaigns/skills/catalog.js";
import * as memberService from "../services/member.js";
import * as membershipService from "../services/membership.js";
import * as messageService from "../services/message.js";
import * as notificationService from "../services/notification.js";
import * as orgSettingsService from "../services/org-settings.js";
import * as participantInviteService from "../services/participant-invite.js";
import * as participantModeService from "../services/participant-mode.js";
import * as presenceService from "../services/presence.js";
import { createResourcesService } from "../services/resources.js";
import * as resourcesMigrationService from "../services/resources-migration.js";
import * as sessionService from "../services/session.js";
import * as sessionEventService from "../services/session-event.js";
import * as usageService from "../services/usage.js";
import * as watcherService from "../services/watcher.js";

type UnknownFn = (...args: unknown[]) => unknown;
type DynamicModule = Record<string, unknown>;

function queryRows(rows: unknown[] = []): unknown {
  const target = function queryProxy(): unknown {
    return proxy;
  };
  const promise = Promise.resolve(rows);
  const proxy = new Proxy(target, {
    apply: () => proxy,
    get: (_target, prop) => {
      if (prop === "then") return promise.then.bind(promise);
      if (prop === "catch") return promise.catch.bind(promise);
      if (prop === "finally") return promise.finally.bind(promise);
      if (prop === Symbol.iterator) return rows[Symbol.iterator].bind(rows);
      if (prop === "length") return rows.length;
      if (typeof prop === "string" && prop in rows) return rows[prop as unknown as keyof typeof rows];
      return vi.fn(() => proxy);
    },
  });
  return proxy;
}

function fakeDb(rows: unknown[] = []): unknown {
  const chain = queryRows(rows);
  const queryTable = new Proxy(
    {},
    {
      get: () => ({
        findFirst: vi.fn(async () => rows[0] ?? null),
        findMany: vi.fn(async () => rows),
      }),
    },
  );
  const db = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "transaction") return vi.fn(async (fn: UnknownFn) => fn(db));
        if (prop === "execute") return vi.fn(async () => rows);
        if (prop === "query") return queryTable;
        return vi.fn(() => chain);
      },
    },
  );
  return db;
}

function throwingDb(error: unknown): unknown {
  const thrower = vi.fn(() => {
    throw error;
  });
  return {
    delete: thrower,
    execute: thrower,
    insert: thrower,
    select: thrower,
    transaction: vi.fn(async () => {
      throw error;
    }),
    update: thrower,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function settle(calls: Array<() => unknown>): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(
    calls.map((call) =>
      Promise.race([
        Promise.resolve().then(call),
        new Promise((resolve) => {
          setTimeout(() => resolve({ timedOut: true }), 25);
        }),
      ]),
    ),
  );
}

function moduleFunctionCalls(moduleName: string, moduleExports: DynamicModule, args: unknown[][]): Array<() => unknown> {
  return Object.entries(moduleExports)
    .filter(([name, value]) => {
      if (typeof value !== "function") return false;
      if (/^[A-Z]/.test(name)) return false;
      if (name.startsWith("register")) return false;
      if (name.endsWith("Routes")) return false;
      return true;
    })
    .flatMap(([name, value]) =>
      args.map((argSet) => () => {
        try {
          return (value as UnknownFn)(...argSet);
        } catch (error) {
          throw new Error(`${moduleName}.${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
}

describe("service branch sweeper", () => {
  it("exercises service exports with defensive fake dependencies", async () => {
    const baseRow = {
      id: "row_1",
      uuid: "agent_1",
      agentId: "agent_1",
      chatId: "chat_1",
      organizationId: "org_1",
      memberId: "member_1",
      humanAgentId: "human_1",
      userId: "user_1",
      name: "agent",
      displayName: "Agent",
      type: "agent",
      status: "active",
      visibility: "organization",
      metadata: {},
      payload: {},
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const db = fakeDb([baseRow]);
    const emptyDb = fakeDb([]);
    const deletedDb = fakeDb([{ ...baseRow, status: "deleted", retiredAt: new Date("2026-01-02T00:00:00.000Z") }]);
    const nullableDb = fakeDb([
      {
        ...baseRow,
        id: null,
        uuid: null,
        agentId: null,
        chatId: null,
        organizationId: "org_1",
        memberId: null,
        humanAgentId: null,
        userId: "user_1",
        name: null,
        displayName: null,
        type: "human",
        status: null,
        visibility: "organization",
        metadata: null,
        payload: null,
      },
    ]);
    const errorDb = throwingDb(new Error("db failed"));
    const nonErrorDb = throwingDb({ code: "not_unique", cause: { code: 42 } });
    const notifier = {
      notifyAgentRouteChange: vi.fn(),
      notifyChatAudienceChanged: vi.fn(),
      notifyChatMessage: vi.fn(),
      notifyChatUpdated: vi.fn(),
      notifyConfigChange: vi.fn(),
      notifyInboxPush: vi.fn(),
      notifyRuntimeState: vi.fn(),
      notifySessionEvent: vi.fn(),
      notifySessionRuntime: vi.fn(),
      notifySessionState: vi.fn(),
    };
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/user/emails")) return jsonResponse([{ email: "primary@example.com", primary: true, verified: true }]);
      if (url.endsWith("/user")) {
        return jsonResponse({ id: 1, login: "octo", name: "Octo", email: null, avatar_url: "https://avatar.test/u.png" });
      }
      if (url.includes("/installation/repositories")) return jsonResponse({ repositories: [] });
      return jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        refresh_token_expires_in: 7200,
        id: 1,
        account: { id: 2, login: "owner", type: "Organization" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    try {
      const commonArgs = [
        [],
        [null],
        [undefined],
        [{}],
        [[]],
        ["literal"],
        [db],
        [db, null],
        [db, undefined],
        [db, []],
        [db, {}],
        [emptyDb],
        [emptyDb, null],
        [emptyDb, undefined],
        [emptyDb, "org_1"],
        [emptyDb, "agent_1"],
        [deletedDb],
        [deletedDb, "agent_1"],
        [deletedDb, "org_1", "agent_1"],
        [nullableDb],
        [nullableDb, "agent_1"],
        [nullableDb, "chat_1", "agent_1"],
        [errorDb],
        [errorDb, "org_1"],
        [errorDb, "agent_1"],
        [errorDb, "chat_1", "agent_1"],
        [nonErrorDb],
        [nonErrorDb, "org_1"],
        [nonErrorDb, "resource_1"],
        [db, "org_1"],
        [db, "agent_1"],
        [db, "agent_1", null],
        [db, "agent_1", {}],
        [db, "chat_1", "agent_1"],
        [db, "chat_1", null],
        [db, "org_1", "agent_1"],
        [db, "org_1", []],
        [db, "org_1", { limit: 0 }],
        [db, "org_1", { limit: 1, cursor: null, status: "active", type: "agent" }],
        [db, "org_1", "member_1", { role: "admin" }],
        [db, "member_1", "human_1", "org_1"],
        [db, "chat_1", "agent_1", { limit: 1, cursor: null }],
        [db, "chat_1", "agent_1", { format: MESSAGE_FORMATS.TEXT, content: "hello", metadata: {}, source: "api" }],
        [db, "agent_1", "chat_1", { state: "active", runtimeState: "idle" }],
        [db, "resource_1", { defaultEnabled: "recommended" }, "member_1"],
        [db, { organizationId: "org_1", memberId: "member_1", humanAgentId: "human_1", userId: "user_1" }],
        [db, { organizationId: "org_1", memberId: null, humanAgentId: null, userId: "user_1" }],
        [db, { organizationId: "org_1", memberId: "member_1" }, 2, null],
        [db, { organizationId: "org_1", memberId: "member_1" }, 0, undefined],
      ];
      const modules: Array<[string, DynamicModule]> = [
        ["activity", activityService],
        ["agent", agentService],
        ["agentRuntimeSwitch", agentRuntimeSwitchService],
        ["auth", authService],
        ["chat", chatService],
        ["client", clientService],
        ["contextReviewerPr", contextReviewerPrService],
        ["contextTreeIo", contextTreeIoService],
        ["document", documentService],
        ["githubApp", githubAppService],
        ["githubAppInstallations", githubAppInstallationsService],
        ["githubAppToken", githubAppTokenService],
        ["githubAudience", githubAudienceService],
        ["githubDelivery", githubDeliveryService],
        ["githubEntityChat", githubEntityChatService],
        ["githubEntityFollow", githubEntityFollowService],
        ["githubEntityKey", githubEntityKeyService],
        ["githubNormalize", githubNormalizeService],
        ["githubOauth", githubOauthService],
        ["inbox", inboxService],
        ["invitation", invitationService],
        ["landingCampaignChatState", landingCampaignChatState],
        ["landingCampaignGuards", landingCampaignGuards],
        ["landingCampaignMetadata", landingCampaignMetadata],
        ["landingCampaignSkillCatalog", landingCampaignSkillCatalog],
        ["member", memberService],
        ["membership", membershipService],
        ["message", messageService],
        ["notification", notificationService],
        ["orgSettings", orgSettingsService],
        ["participantInvite", participantInviteService],
        ["participantMode", participantModeService],
        ["presence", presenceService],
        ["resourcesMigration", resourcesMigrationService],
        ["session", sessionService],
        ["sessionEvent", sessionEventService],
        ["usage", usageService],
        ["watcher", watcherService],
      ];
      const calls = modules.flatMap(([name, exports]) => moduleFunctionCalls(name, exports, commonArgs));

      const resources = createResourcesService({ db: db as never, notifier: notifier as never });
      calls.push(
        () => resources.listTeamResources("org_1"),
        () => resources.getResource("resource_1"),
        () => resources.getAgentResources("agent_1"),
        () => resources.resolveEffectiveResources("agent_1"),
        () => resources.previewResourceImpact("resource_1", {}),
        () =>
          resources.createTeamResource(
            "org_1",
            { type: "repo", name: "Repo", defaultEnabled: "available", payload: { url: "https://github.com/acme/repo.git" } },
            "member_1",
          ),
        () => resources.updateResource("resource_1", { defaultEnabled: "available" }, "member_1"),
        () => resources.retireResource("resource_1", "member_1"),
      );

      calls.push(
        () =>
          messageService.preflightMessageSendIntent({
            chatId: "chat_1",
            senderId: "agent_1",
            senderType: "agent",
            data: { format: MESSAGE_FORMATS.TEXT, content: "@Agent hello", metadata: {}, source: "api" },
            participants: [{ agentId: "agent_1", name: "agent", displayName: "Agent", type: "agent", status: "active" }],
          }),
        () => githubEntityFollowService.parseEntityReference("https://github.com/acme/repo/pull/42"),
        () => githubEntityFollowService.parseEntityReference("acme/repo#42"),
        () => githubEntityKeyService.githubEntityKeyCandidates("discussion", "acme/repo#7"),
        () => githubNormalizeService.extractMentions("@alice please review @bob"),
        () =>
          landingCampaignMetadata.buildLandingCampaignChatMetadata({
            agentId: "agent_1",
            campaign: "portfolio",
            skillSetId: "portfolio",
            skillSetVersion: "v1",
            repo: {
              url: "https://github.com/acme/site",
              canonicalKey: "github.com/acme/site",
              owner: "acme",
              name: "site",
            },
            state: "running",
            inputLocked: false,
            maxAgentTurns: 2,
            maxEstimatedTokens: null,
          }),
      );

      const results = await settle(calls);
      expect(results.length).toBeGreaterThan(200);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
